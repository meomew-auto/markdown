# Case 01: Daily Ingress Curve — Products Service Browse/List Traffic Theo Daily Pattern

> **Executor:** `ramping-arrival-rate` | **Open model** | **Stage curve: 5 -> 28 -> 8 /s**

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [2 yêu cầu cốt lõi](#2-2-yêu-cầu-cốt-lõi)
3. [Vì sao chọn ramping-arrival-rate?](#3-vì-sao-chọn-ramping-arrival-rate)
4. [Phân tích nguyên nhân gốc kỹ thuật (5 RC)](#4-phân-tích-nguyên-nhân-gốc-kỹ-thuật-5-rc)
5. [Identity model deep-dive](#5-identity-model-deep-dive)
6. [Phân tích open model với stage curve](#6-phân-tích-open-model-với-stage-curve)
7. [Bảng service/API flow](#7-bảng-serviceapi-flow)
8. [Metrics & tags deep-dive](#8-metrics--tags-deep-dive)
9. [Pass criteria](#9-pass-criteria)
10. [Cách chạy](#10-cách-chạy)
11. [Phân tích output 5 bước](#11-phân-tích-output-5-bước)
12. [Dashboard 3-chart deep analysis](#12-dashboard-3-chart-deep-analysis)
13. [4 output -> decision scenarios](#13-4-output--decision-scenarios)
14. ["Nghịch lý" (4)](#14-nghịch-lý-4)
15. [Checklist](#15-checklist)
16. [5 variations với code](#16-5-variations-với-code)
17. [Anti-patterns](#17-anti-patterns)
18. [Reference](#18-reference)

---

## 1. Tình huống thực tế

### 1.1. Business context

Products service của một nền tảng e-commerce nhận browse/list traffic theo **daily pattern** rõ rệt:

```
Sáng sớm (0-15s):  traffic tăng dần từ 5 requests/s lên 15 requests/s
                    — người dùng bắt đầu mở app, browse sản phẩm

Trưa (15-40s):      traffic giữ peak, tăng tiếp từ 15 lên 28 requests/s
                    — giờ cao điểm: người dùng lướt sản phẩm, so sánh giá

Chiều (40-55s):     traffic giảm dần từ 28 xuống 8 requests/s
                    — người dùng ít dần, chuẩn bị hết phiên làm việc
```

Đây là bài toán **ingress contract**: traffic đến từ bên ngoài hệ thống theo nhịp thay đổi. Hệ thống không kiểm soát được nhịp đến — nó phải **chịu được** đường cong arrival rate này.

### 1.2. Câu hỏi của team

Team cần trả lời:

| # | Câu hỏi | Vì sao quan trọng |
| --- | --- | --- |
| Q1 | Hệ thống có chịu được toàn bộ daily ingress curve không? | Nếu không, peak giờ trưa sẽ mất traffic |
| Q2 | Có dropped_iterations ở đâu không? | Drop = mất business event, không thể chấp nhận với production |
| Q3 | Latency ở peak (28/s) có khác gì ở trough (5/s) không? | Nếu latency spike ở peak, cần scale backend hoặc VU pool |
| Q4 | preAllocatedVUs=15 có đủ cho peak 28/s không? | VU sizing sai -> dropped_iterations dù backend khỏe |
| Q5 | Stage transition có gây drop không? | Rate thay đổi nhanh có thể gây VU shortage tạm thời |

### 1.3. Tại sao không dùng executor khác?

| Executor | Vì sao không hợp | Hậu quả nếu dùng sai |
| --- | --- | --- |
| `constant-vus` | Closed model: VU cố định, throughput là output. Không kiểm soát được arrival rate — backend chậm thì throughput tự tụt, không phát hiện được mất traffic ở peak | Không biết hệ thống có chịu được 28/s không |
| `constant-arrival-rate` | Chỉ giữ MỘT rate cố định. Daily curve có 3 vùng rate khác nhau (5->15, 15->28, 28->8). Không thể mô phỏng bằng một rate phẳng | Phải chọn 1 rate: nếu chọn 28/s thì quá stress ở "sáng" và "chiều"; nếu chọn 17.4/s (average) thì không test được peak thật |
| `per-vu-iterations` | Mỗi VU chạy đúng N vòng. Không có khái niệm arrival rate, không có timeline stage | Không mô phỏng được daily curve |
| `shared-iterations` | Chia đều N jobs cho pool VUs. Không có timeline, không có rate variation | Jobs chạy xong là hết, không phản ánh traffic liên tục theo thời gian |
| `ramping-vus` | Closed model: thay đổi số VU, throughput là hệ quả — không đo được ingress contract | Không biết 15 VU hay 40 VU tạo ra bao nhiêu iter/s; không map được sang 28/s arrival target |

### 1.4. Config đầy đủ

```js
export const options = {
  scenarios: {
    daily_ingress_curve: {
      executor: "ramping-arrival-rate",
      exec: "dailyIngressCurve",
      startRate: 5,
      timeUnit: "1s",
      stages: [
        { duration: "15s", target: 15 },   // morning ramp-up
        { duration: "25s", target: 28 },   // noon peak
        { duration: "15s", target: 8 },    // afternoon ramp-down
      ],
      preAllocatedVUs: 15,
      maxVUs: 40,
      gracefulStop: "3s",
      tags: {
        case_id: "rar-01-daily-ingress-curve",
        service: "products-service",
        workload_type: "daily_ingress_curve",
      },
    },
  },
};
```

### 1.5. Stage math chi tiết

Đây là phần tính toán quan trọng nhất để hiểu case này. Mỗi stage rate thay đổi **tuyến tính** từ rate đầu đến rate cuối.

#### Stage 1: Morning ramp-up (5 -> 15 /s trong 15s)

```
rate_start = 5/s
rate_end   = 15/s
duration   = 15s

Scheduled slots = duration × (rate_start + rate_end) / 2
                = 15 × (5 + 15) / 2
                = 15 × 10
                = 150 slots                                   // (1a)

Rate tại thời điểm t (0 <= t <= 15):
  rate(t) = 5 + (15 - 5) × t / 15
          = 5 + 10t/15
          = 5 + 0.667t                                       // (1b)

Kiểm tra biên:
  t=0:   rate = 5/s    ✓ (khớp startRate)
  t=7.5: rate = 10/s   (điểm giữa stage)
  t=15:  rate = 15/s   ✓ (khớp target stage 1)
```

#### Stage 2: Noon peak (15 -> 28 /s trong 25s)

```
rate_start = 15/s
rate_end   = 28/s
duration   = 25s

Scheduled slots = duration × (rate_start + rate_end) / 2
                = 25 × (15 + 28) / 2
                = 25 × 21.5
                = 537.5 slots                                 // (2a)

rate(t) với 0 <= t <= 25 (trong stage 2):
  rate(t) = 15 + (28 - 15) × t / 25
          = 15 + 13t/25
          = 15 + 0.52t                                       // (2b)

Kiểm tra biên:
  t=0:    rate = 15/s   ✓ (tiếp nối stage 1)
  t=12.5: rate = 21.5/s (điểm giữa stage 2)
  t=25:   rate = 28/s   ✓ (khớp target stage 2, đây là lambda_peak)
```

#### Stage 3: Afternoon ramp-down (28 -> 8 /s trong 15s)

```
rate_start = 28/s
rate_end   = 8/s
duration   = 15s

Scheduled slots = duration × (rate_start + rate_end) / 2
                = 15 × (28 + 8) / 2
                = 15 × 18
                = 270 slots                                   // (3a)

rate(t) với 0 <= t <= 15 (trong stage 3):
  rate(t) = 28 + (8 - 28) × t / 15
          = 28 - 20t/15
          = 28 - 1.333t                                      // (3b)

Kiểm tra biên:
  t=0:  rate = 28/s   ✓ (tiếp nối stage 2, lambda_peak)
  t=7.5: rate = 18/s  (điểm giữa stage 3)
  t=15:  rate = 8/s   ✓ (khớp target stage 3)
```

#### Tổng kết stage math

| Đại lượng | Giá trị | Ghi chú |
| --- | --- | --- |
| Stage 1 slots | 150 | 5->15/s, 15s |
| Stage 2 slots | 537.5 | 15->28/s, 25s (nhiều nhất) |
| Stage 3 slots | 270 | 28->8/s, 15s |
| **Total scheduled slots** | **≈ 958** | 150 + 537.5 + 270 |
| `lambda_peak` | **28/s** | Tại cuối stage 2 / đầu stage 3 |
| `lambda_min` | **5/s** | Tại đầu stage 1 |
| `average_target_rate` | **17.42/s** | 958 / 55s |
| Total duration | **55s** | 15 + 25 + 15 |
| Regular timeline | **55s** | Sum(stage.duration) |
| Wall-clock max | **58s** | 55s + gracefulStop(3s) |

### 1.6. Timeline visualization

```
Rate
(/s)
 28 |                                  . . . . . . . . . . .
    |                            . . .                       . .
    |                      . . .                               . .
 20 |                . . .                                       . .
    |          . . .                                               . .
 15 |    . . .                                                       . .
    | . .                                                             . . .
 10 |.                                                                   . .
    |                                                                       . .
  8 |                                                                         . .
    |
  5 |*
    |
    +----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+
    0    5   10   15   20   25   30   35   40   45   50   55
    |<- Stage 1 -->|<----- Stage 2 ----->|<----- Stage 3 ----->|
    |  5->15 /s    |    15->28 /s         |     28->8 /s        |
    |   150 slots  |    537.5 slots       |     270 slots       |
    |  "morning"   |    "noon peak"       |    "afternoon"      |
```

---

## 2. 2 yêu cầu cốt lõi

### 2.1. Yêu cầu A: Sustain daily ingress curve

```
Hệ thống phải CHỊU ĐƯỢC toàn bộ đường cong arrival rate:
  morning:  5 -> 15 /s  (ramp-up nhẹ nhàng)
  noon:    15 -> 28 /s  (peak — đây là điểm quyết định)
  afternoon: 28 -> 8 /s (ramp-down)

Nghĩa là:
  - Không dropped_iterations (hoặc trong ngưỡng cho phép, ví dụ < 1%)
  - Actual iter/s theo sát target_rate(t) ở mọi stage
  - Không có stage nào bị "hụt" iterations đáng kể so với scheduled slots
```

Đây không phải là "chạy xong là được". Đây là **arrival contract theo thời gian**. Mỗi giây k6 phải start được đúng số iteration như lịch.

### 2.2. Yêu cầu B: Zero drops at peak

```
Tại lambda_peak = 28/s, hệ thống phải:
  - Có đủ VU rảnh để nhận mọi arrival slot
  - Không có dropped_iterations ở stage 2 và đầu stage 3
  - Latency ở peak không vượt ngưỡng SLO (ví dụ p95 < 200ms)

Nếu peak drop, toàn bộ test fail — vì peak chính là giờ cao điểm
business quan trọng nhất.
```

### 2.3. Tại sao 2 yêu cầu này là đủ?

| Yêu cầu | Bao phủ điều gì | Nếu thiếu |
| --- | --- | --- |
| Sustain daily curve | Kiểm tra toàn bộ timeline, không chỉ peak | Có thể peak pass nhưng ramp-up hoặc ramp-down fail |
| Zero drops at peak | Kiểm tra điểm stress cao nhất (28/s) | Có thể toàn bộ run pass nhưng peak drop — test vô nghĩa |

Cả hai cùng đảm bảo: **hệ thống chịu được traffic pattern thực tế**, không chỉ một điểm rate duy nhất.

---

## 3. Vì sao chọn ramping-arrival-rate?

### 3.1. Bảng so sánh đầy đủ với tất cả 6 executor

| Executor | Model | Rate control | Phù hợp daily curve? | Lý do chính |
| --- | --- | --- | --- | --- |
| **ramping-arrival-rate** | Open | **Stage-based variable rate** | **YES — perfectly** | Stage curve map 1:1 sang daily pattern: sáng ramp-up, trưa peak, chiều ramp-down |
| constant-arrival-rate | Open | Fixed rate | No | Chỉ có 1 rate phẳng. Nếu đặt 28/s: quá stress cho sáng/chiều. Nếu đặt 17.4/s: không test được peak thật. Nếu đặt 5/s: bỏ lỡ toàn bộ peak |
| ramping-vus | Closed | VU changes (throughput is output) | No | Thay đổi VU, không kiểm soát được arrival rate. 28 VU không có nghĩa là 28 iter/s |
| constant-vus | Closed | Fixed VUs | No | VU cố định, throughput là hệ quả. Không mô phỏng được rate variation |
| per-vu-iterations | Closed | Fixed iterations per VU | No | Không có timeline stage, không có arrival rate concept |
| shared-iterations | Closed | Fixed total iterations | No | Chia đều jobs, không có timeline, không có rate variation |

### 3.2. Phân tích sâu: vì sao constant-arrival-rate (flat rate) thất bại với daily curve?

Giả sử team dùng `constant-arrival-rate` để test daily ingress pattern. Team có 3 lựa chọn rate:

#### Lựa chọn A: rate = 28/s (lambda_peak)

```
Config: constant-arrival-rate, rate=28, timeUnit=1s, duration=55s

Scheduled slots = 28 × 55 = 1540 slots

Vấn đề:
  - 1540 slots >> 958 slots thực tế của daily curve
  - Sáng (5-15s) và chiều (40-55s) bị overshoot nặng
  - Test quá khắc nghiệt -> false negative
  - Backend bị stress gấp 3-5 lần thực tế ở vùng trough
  - Nếu pass 28/s constant: tức là hệ thống dư capacity rất nhiều,
    nhưng KHÔNG kiểm tra được pattern tăng/giảm có gây vấn đề gì không
  - Nếu fail 28/s constant: không biết fail vì peak thật hay vì
    trough bị overshoot -> kết luận sai
```

#### Lựa chọn B: rate = 17.4/s (average)

```
Config: constant-arrival-rate, rate=17, timeUnit=1s, duration=55s

Scheduled slots ≈ 17 × 55 = 935 slots (gần 958)

Vấn đề:
  - Qua được trung bình nhưng KHÔNG test được peak 28/s
  - Production peak là 28/s — nếu backend chỉ chịu được 22/s,
    test vẫn pass vì average 17/s thấp hơn ngưỡng thật
  - False positive nguy hiểm: test pass nhưng production fail
  - Không phát hiện được latency spike ở rate cao
```

#### Lựa chọn C: rate = 5/s (trough)

```
Config: constant-arrival-rate, rate=5, timeUnit=1s, duration=55s

Scheduled slots = 5 × 55 = 275 slots

Vấn đề:
  - Quá thấp, không test được gì ngoài vùng sáng sớm
  - Bỏ lỡ hoàn toàn 683 slots còn lại
  - Vô nghĩa với mục tiêu validate daily curve
```

#### Kết luận

```text
constant-arrival-rate KHÔNG THỂ thay thế ramping-arrival-rate
cho daily curve vì:

1. Một rate phẳng không có stage — daily curve có 3 stage
2. lambda_peak (28/s) >> average rate (17.4/s) — gap 1.6x
3. Sizing cho peak constant-rate khác sizing cho peak có ramp-up/down
4. Stage transition behavior (rate jumps) không được test với flat rate
```

### 3.3. So sánh chi tiết ramping-arrival-rate vs ramping-vus

Đây là cặp so sánh quan trọng nhất vì cả hai đều dùng `stages[]`.

| Khía cạnh | ramping-arrival-rate (open) | ramping-vus (closed) |
| --- | --- | --- |
| **Stage điều khiển cái gì?** | Arrival rate (iterations khởi tạo mỗi giây) | Số VU active đồng thời |
| **Throughput** | Input (target) — k6 cố đạt rate này | Output — hệ quả của VU count và iteration duration |
| **Công thức stage** | slots = duration × (r1+r2)/2 | VU-seconds = duration × (v1+v2)/2 |
| **lambda_peak** | 28 iterations/s | Không có — thay vào đó là VU_peak |
| **VU role** | Worker giữ arrival contract | Business user đang online |
| **drop khi thiếu VU** | dropped_iterations (slot bị bỏ) | Không có drop — VU loop chậm lại, throughput giảm |
| **Metric chính để pass/fail** | dropped_iterations + actual iter/s vs target | http_req_duration + actual throughput |
| **Backend chậm ->** | Cần thêm VU để giữ rate, hoặc drop | Throughput tự giảm, latency tăng |
| **Dùng cho daily curve?** | YES — rate thay đổi theo stage | NO — VU count thay đổi không map sang arrival rate |

Ví dụ minh họa sự khác biệt:

```text
Cùng stages: [{duration: "15s", target: 15}, {duration: "25s", target: 28}]

ramping-arrival-rate:
  - Stage 1: k6 start 5->15 iterations/s, bất kể backend nhanh hay chậm
  - Stage 2: k6 start 15->28 iterations/s, cần đủ VU để nhận slot
  - Nếu backend chậm: VU bận lâu hơn -> cần nhiều VU hơn -> nếu không đủ -> DROP
  - Kết luận: "Hệ thống có chịu được 28 arrivals/s không?"

ramping-vus:
  - Stage 1: k6 tăng VU từ 5 lên 15, mỗi VU loop liên tục
  - Stage 2: k6 tăng VU từ 15 lên 28
  - Throughput thực tế = f(VU_count, iteration_duration)
  - Nếu backend chậm: mỗi VU loop chậm -> throughput tự giảm, KHÔNG drop
  - Kết luận: "28 VU concurrent tạo ra throughput bao nhiêu?"
```

---

## 4. Phân tích nguyên nhân gốc kỹ thuật (5 RC)

### 4.1. RC1: Stage curve định nghĩa arrival schedule; rate thay đổi tuyến tính trong mỗi stage

#### Cơ chế

`ramping-arrival-rate` không giữ rate cố định. Tại mỗi millisecond, executor tính rate hiện tại theo đường tuyến tính:

```text
rate_now = rate_previous_target + (stage.target - rate_previous_target) × elapsed / stage.duration
```

Trong đó `rate_previous_target` là target rate của stage trước (với stage 1, đó là `startRate`).

#### Trace cụ thể cho case này

**Stage 1 (0-15s): Morning ramp-up**

| Thời điểm (t) | rate(t) công thức | rate(t) giá trị | Số slot tích lũy ~ | Ghi chú |
| --- | --- | --- | --- | --- |
| t=0.0s | 5 + 10×0/15 | **5.0/s** | 0 | Bắt đầu morning |
| t=1.0s | 5 + 10×1/15 | **5.7/s** | ~5 | |
| t=2.0s | 5 + 10×2/15 | **6.3/s** | ~11 | |
| t=3.0s | 5 + 10×3/15 | **7.0/s** | ~18 | |
| t=5.0s | 5 + 10×5/15 | **8.3/s** | ~34 | |
| t=7.5s | 5 + 10×7.5/15 | **10.0/s** | ~56 | Điểm giữa stage 1 |
| t=10.0s | 5 + 10×10/15 | **11.7/s** | ~83 | |
| t=12.5s | 5 + 10×12.5/15 | **13.3/s** | ~114 | |
| t=15.0s | 5 + 10×15/15 | **15.0/s** | ~150 | Kết thúc stage 1 |

**Stage 2 (15-40s): Noon peak**

| Thời điểm (t) | rate(t) công thức | rate(t) giá trị | Số slot tích lũy ~ | Ghi chú |
| --- | --- | --- | --- | --- |
| t=15.0s | 15 + 13×0/25 | **15.0/s** | 150 | Tiếp nối stage 1 |
| t=17.5s | 15 + 13×2.5/25 | **16.3/s** | ~189 | |
| t=20.0s | 15 + 13×5/25 | **17.6/s** | ~231 | |
| t=22.5s | 15 + 13×7.5/25 | **18.9/s** | ~277 | |
| t=25.0s | 15 + 13×10/25 | **20.2/s** | ~326 | |
| t=27.5s | 15 + 13×12.5/25 | **21.5/s** | ~378 | Điểm giữa stage 2 |
| t=30.0s | 15 + 13×15/25 | **22.8/s** | ~433 | |
| t=32.5s | 15 + 13×17.5/25 | **24.1/s** | ~496 | |
| t=35.0s | 15 + 13×20/25 | **25.4/s** | ~555 | |
| t=37.5s | 15 + 13×22.5/25 | **26.7/s** | ~620 | |
| t=40.0s | 15 + 13×25/25 | **28.0/s** | ~687.5 | lambda_peak! |

**Stage 3 (40-55s): Afternoon ramp-down**

| Thời điểm (t) | rate(t) công thức | rate(t) giá trị | Số slot tích lũy ~ | Ghi chú |
| --- | --- | --- | --- | --- |
| t=40.0s | 28 - 20×0/15 | **28.0/s** | 687.5 | lambda_peak, bắt đầu giảm |
| t=42.5s | 28 - 20×2.5/15 | **24.7/s** | ~753 | |
| t=45.0s | 28 - 20×5/15 | **21.3/s** | ~810 | |
| t=47.5s | 28 - 20×7.5/15 | **18.0/s** | ~859 | Điểm giữa stage 3 |
| t=50.0s | 28 - 20×10/15 | **14.7/s** | ~900 | |
| t=52.5s | 28 - 20×12.5/15 | **11.3/s** | ~932 | |
| t=55.0s | 28 - 20×15/15 | **8.0/s** | ~957.5 | Kết thúc timeline |

#### Demo trace: slot scheduling ở stage transition

```
Transition stage 1 -> stage 2 (t≈15s):
  rate_change: 15/s -> 15/s (no jump! continuous)
  Không có discontinuity ở rate
  Nhưng VU demand có thể thay đổi nếu iteration duration khác

Transition stage 2 -> stage 3 (t≈40s):
  rate_change: 28/s -> 28/s (no jump! continuous)
  Đây là điểm rate cao nhất — VU demand ở mức tối đa
  Nếu VU pool không đủ, drop sẽ xuất hiện ở ĐOẠN NÀY,
  không phải ở chính xác t=40s

Lưu ý quan trọng:
  Rate không bao giờ nhảy cục giữa các stage.
  Mỗi stage bắt đầu từ target của stage trước.
  "Jump" chỉ xảy ra nếu target của stage mới KHÁC rate hiện tại
  — nhưng trong config này, các stage nối tiếp nhau mượt mà.
```

#### Ý nghĩa với sizing

```text
Vì rate thay đổi LIÊN TỤC, VU demand cũng thay đổi liên tục:

  VU_demand(t) ≈ rate(t) × W_effective

Sizing phải cover:
  1. VU_demand ở lambda_peak (28/s): đây là max demand
  2. VU_demand ở stage transition: spawn kịp không?
  3. VU_demand ở ramp-down: VU vẫn bận với in-flight iterations
```

### 4.2. RC2: Peak rate (28/s) quyết định VU sizing, KHÔNG phải average rate (17.4/s)

#### Công thức Little's Law áp dụng cho open model

```text
required_vus_min ≈ ceil(lambda × W_effective)

Trong đó:
  lambda      = arrival rate (iterations/s)
  W_effective = thời gian trung bình một iteration giữ VU bận (s)
```

#### Tính toán với case này

Giả sử `W_effective` thay đổi theo stage vì backend load khác nhau:

| Stage | Rate range | W_effective ước tính | VU_demand ước tính | Ghi chú |
| --- | --- | --- | --- | --- |
| Stage 1 (sáng) | 5-15/s | ~100ms | 1-2 VU | Backend nhẹ, latency thấp |
| Stage 2 (trưa peak) | 15-28/s | ~180ms | 3-6 VU | Backend tải cao hơn, latency tăng |
| Stage 3 (chiều) | 28-8/s | ~150ms | 2-5 VU | Latency giảm dần theo rate |

Tính VU_demand tại lambda_peak với các kịch bản W_effective:

| W_effective | required_vus_min_peak | Có đủ với preAllocatedVUs=15? | Ghi chú |
| --- | --- | --- | --- |
| 100ms | ceil(28 × 0.1) = **3 VU** | YES, dư nhiều | Event nhanh (cache hit, read simple) |
| 200ms | ceil(28 × 0.2) = **6 VU** | YES, dư nhiều | Event trung bình |
| 350ms | ceil(28 × 0.35) = **10 VU** | YES, còn buffer | Event hơi chậm (DB query phức tạp) |
| 500ms | ceil(28 × 0.5) = **14 VU** | YES, sát | Event chậm (external call, join nhiều bảng) |
| 600ms | ceil(28 × 0.6) = **17 VU** | NO — cần thêm 2 VU | Vượt preAllocatedVUs, cần spawn từ maxVUs |
| 1000ms | ceil(28 × 1.0) = **28 VU** | NO — cần 13 VU từ maxVUs | Event rất chậm |

#### Sai lầm phổ biến: sizing theo average rate

```text
Nếu sizing theo average target rate 17.4/s:
  required_vus_min_avg ≈ ceil(17.4 × W_effective)

Với W_effective = 200ms:
  required_vus_min_avg = ceil(17.4 × 0.2) = 4 VU

Nhưng thực tế peak cần:
  required_vus_min_peak = ceil(28 × 0.2) = 6 VU

Chênh lệch: 6 vs 4 = 1.5x

Với W_effective = 500ms:
  required_vus_min_avg = ceil(17.4 × 0.5) = 9 VU
  required_vus_min_peak = ceil(28 × 0.5) = 14 VU

Chênh lệch: 14 vs 9 = 1.56x

Kết luận: lambda_peak / average_rate = 28/17.4 = 1.61x
VU sizing nếu dùng average rate sẽ THIẾU ~38% VU ở peak.
```

#### Hệ quả

```text
Nếu preAllocatedVUs được set dựa trên average rate:
  - Sáng và chiều: VU dư thừa (waste)
  - Trưa peak: VU thiếu -> dropped_iterations -> test fail

Nếu preAllocatedVUs được set dựa trên peak rate:
  - Sáng và chiều: VU hơi dư nhưng an toàn
  - Trưa peak: VU đủ -> zero drops

-> LUÔN sizing cho lambda_peak, không phải average rate.
```

### 4.3. RC3: dropped_iterations ở stage transition — rate jumps có thể gây VU shortage tạm thời

#### Cơ chế

Mặc dù rate không nhảy cục trong config này (các stage nối tiếp mượt), `dropped_iterations` vẫn có thể xuất hiện do:

1. **VU spawning delay**: Khi rate tăng, VU demand tăng. Nếu preAllocatedVUs không đủ, k6 phải spawn thêm VU từ pool maxVUs. Spawn mất thời gian (có thể vài trăm ms đến vài giây). Trong thời gian spawn, slot đến mà không có VU rảnh -> drop.

2. **In-flight iteration backlog**: VU đang bận với iteration cũ, chưa kịp giải phóng. Slot mới đến -> không có VU rảnh -> drop.

3. **Ramp-up gradient**: Stage 2 ramp từ 15 lên 28/s trong 25s — gradient = 0.52/s mỗi giây. Đây là ramp khá từ từ, nhưng VU demand tăng dần đòi hỏi pool phải mở rộng kịp thời.

#### Trace: VU demand change trong stage 2

```
Thời điểm     rate     VU_demand (W=200ms)   VU_demand (W=350ms)   VU_demand (W=500ms)
t=15.0s       15.0/s   3 VU                   6 VU                   8 VU
t=20.0s       17.6/s   4 VU                   7 VU                   9 VU
t=25.0s       20.2/s   5 VU                   8 VU                   11 VU
t=30.0s       22.8/s   5 VU                   8 VU                   12 VU
t=35.0s       25.4/s   6 VU                   9 VU                   13 VU
t=40.0s       28.0/s   6 VU                   10 VU                  14 VU

VU demand tăng từ 8 lên 14 (với W=500ms) trong 25s
-> gradient VU demand ≈ (14-8)/25 = 0.24 VU/s
-> Mỗi ~4 giây cần thêm 1 VU
-> Spawn rate này hoàn toàn khả thi với preAllocatedVUs=15, maxVUs=40
```

#### Khi nào drop xuất hiện ở transition?

| Nguyên nhân | Dấu hiệu | Cách phát hiện |
| --- | --- | --- |
| preAllocatedVUs quá thấp | Drop xuất hiện ngay từ đầu run, trước cả peak | VUs = maxVUs ngay từ stage 1 |
| Spawn không kịp | Drop xuất hiện thành cụm ở đầu stage 2 | VUs tăng dần, có vài bucket drop rồi hết |
| maxVUs quá thấp | Drop xuất hiện ở cuối stage 2 (gần peak) và kéo dài | VUs = maxVUs liên tục, drop không giảm |
| In-flight backlog | Drop xuất hiện rải rác, không tập trung | Event duration cao, VUs không chạm max |

### 4.4. RC4: preAllocatedVUs vs maxVUs — capacity envelope qua các stage

#### Định nghĩa

```text
preAllocatedVUs = số VU được khởi tạo SẴN trước khi scenario bắt đầu
                  -> luôn sẵn sàng nhận slot, zero spawn delay

maxVUs          = số VU TỐI ĐA k6 được phép mở
                  -> trần capacity của pool

VU hoạt động    = preAllocatedVUs (warm) + spawned VUs (cold, mất thời gian)
```

#### Capacity envelope cho case này

```
preAllocatedVUs = 15 VU (warm, sẵn sàng)
maxVUs          = 40 VU (trần tuyệt đối)

Headroom = maxVUs - preAllocatedVUs = 40 - 15 = 25 VU (có thể spawn thêm)

Capacity phân tích theo W_effective:

  Với W_effective = 200ms:
    capacity_pre = 15 / 0.2 = 75 iter/s  >> lambda_peak=28/s ✓
    capacity_max = 40 / 0.2 = 200 iter/s >> dư rất nhiều

  Với W_effective = 350ms:
    capacity_pre = 15 / 0.35 ≈ 43 iter/s > lambda_peak=28/s ✓
    capacity_max = 40 / 0.35 ≈ 114 iter/s >> dư

  Với W_effective = 500ms:
    capacity_pre = 15 / 0.5 = 30 iter/s  > lambda_peak=28/s ✓ (sát!)
    capacity_max = 40 / 0.5 = 80 iter/s  >> dư

  Với W_effective = 600ms:
    capacity_pre = 15 / 0.6 = 25 iter/s  < lambda_peak=28/s ✗ (thiếu!)
    -> cần spawn thêm ít nhất 2 VU từ maxVUs pool
    capacity_max = 40 / 0.6 ≈ 67 iter/s  >> dư sau khi spawn
```

#### Phân bố VU qua các stage (dự kiến)

```
Stage 1 (5->15/s, W≈100ms):
  VU cần: 1-2
  preAllocatedVUs=15 dư nhiều
  VU active thực tế: ~2-5 (một số idle)
  Không cần spawn

Stage 2 (15->28/s, W≈180-350ms):
  VU cần: 3-10
  preAllocatedVUs=15 vẫn đủ với hầu hết W_effective
  VU active thực tế: ~5-12
  Có thể cần spawn nếu W > 500ms

Stage 3 (28->8/s, W≈150ms):
  VU cần: 2-5 (giảm dần)
  VU active giảm dần theo rate
  VU dư thừa sẽ idle, không ảnh hưởng đến test
```

#### Nguyên tắc chọn preAllocatedVUs và maxVUs

| Tham số | Nguyên tắc | Case này |
| --- | --- | --- |
| `preAllocatedVUs` | Đủ cho phần lớn timeline, tránh spawn delay thường xuyên | 15: đủ cho peak với W<=500ms |
| `maxVUs` | Cover worst case: W spike, cold start, GC pause | 40: buffer 2.67x so với preAllocated |
| Tỉ lệ max/pre | 2-4x là hợp lý | 40/15 ≈ 2.67x |
| Không nên | preAllocatedVUs = maxVUs (mất flexibility) | - |
| Không nên | preAllocatedVUs quá thấp (spawn delay gây drop ở ramp-up) | - |

### 4.5. RC5: Event duration biến thiên qua các stage — peak stage có thể thấy latency cao hơn

#### Cơ chế

Event duration không cố định. Nó phụ thuộc vào:

```text
1. Backend load: rate càng cao -> backend càng bận -> latency càng tăng
2. Connection pool: nhiều concurrent requests -> queueing ở DB/pool
3. Cache efficiency: cold start ở stage 1, warm cache ở stage 2, cache vẫn ấm ở stage 3
4. GC/CPU: rate cao -> nhiều object allocation -> GC pressure
```

#### Dự kiến event duration theo stage

| Stage | Rate range | Backend load | Dự kiến p50 | Dự kiến p95 | Dự kiến p99 |
| --- | --- | --- | --- | --- | --- |
| Stage 1 (sáng) | 5-15/s | Nhẹ | 40-60ms | 80-120ms | 150-200ms |
| Stage 2 (trưa peak) | 15-28/s | Cao | 60-100ms | 150-250ms | 300-500ms |
| Stage 3 (chiều) | 28-8/s | Giảm dần | 50-80ms | 100-180ms | 200-350ms |

#### Vì sao event duration quan trọng với sizing?

```text
event_duration tăng -> W_effective tăng -> VU_demand tăng

Đây là vòng lặp nguy hiểm:
  rate cao -> backend chậm -> event lâu hơn
  -> VU bận lâu hơn -> cần nhiều VU hơn
  -> nếu không đủ VU -> drop -> mất traffic

Ngược lại với closed model (constant-vus):
  rate cao -> backend chậm -> VU loop chậm
  -> throughput tự giảm -> backend đỡ tải
  -> tự điều chỉnh (self-throttling)
```

#### Trace: tương tác rate-event_duration-VU_demand

```
Giả sử event_duration tăng theo rate: W = 100ms + rate×3ms

t=0s:   rate=5/s,  W=100+5×3=115ms,   VU_demand=ceil(5×0.115)=1
t=15s:  rate=15/s, W=100+15×3=145ms,  VU_demand=ceil(15×0.145)=3
t=27.5s:rate=21.5/s,W=100+21.5×3=165ms,VU_demand=ceil(21.5×0.165)=4
t=40s:  rate=28/s, W=100+28×3=184ms,  VU_demand=ceil(28×0.184)=6

VU_demand tăng từ 1 lên 6, preAllocatedVUs=15 vẫn dư.
Nhưng nếu W tăng mạnh hơn (ví dụ: W=100ms + rate×10ms):

t=40s:  rate=28/s, W=100+28×10=380ms, VU_demand=ceil(28×0.38)=11
-> Vẫn trong preAllocatedVUs=15

Nếu W=200ms + rate×20ms:
t=40s:  rate=28/s, W=200+28×20=760ms, VU_demand=ceil(28×0.76)=22
-> Vượt preAllocatedVUs, cần spawn 7 VU từ maxVUs=40
```

---

## 5. Identity model deep-dive

### 5.1. Các identity trong ramping-arrival-rate

| Identity | Ý nghĩa | Cách lấy | Dùng để làm gì |
| --- | --- | --- | --- |
| `__VU` | Worker ID, định danh VU | `exec.vu.idInInstance` | Trace xem VU nào đang chạy event nào |
| `exec.scenario.iterationInTest` | Slot index trong toàn bộ timeline | `exec.scenario.iterationInTest` | Slot thứ mấy được schedule? Có khớp expected count không? |
| `userContext.userId` | User identity cho event đó | `userContext.userId` hoặc `exec.vu.idInInstance % userPoolSize` | Phân biệt business user vs k6 VU |
| `exec.scenario.name` | Tên scenario | `exec.scenario.name` | Xác nhận đúng scenario đang chạy |
| `exec.instance.iterationsCompleted` | Số iteration đã hoàn thành bởi VU này | `exec.instance.iterationsCompleted` | Trace activity của từng VU |

### 5.2. Bảng so sánh identity model: ramping-arrival-rate vs constant-arrival-rate vs ramping-vus

| Identity | ramping-arrival-rate | constant-arrival-rate | ramping-vus |
| --- | --- | --- | --- |
| VU meaning | Worker capacity | Worker capacity | Business user |
| iterationInTest | Slot index (global timeline) | Slot index (global timeline) | VU-local iteration counter |
| VU life | Nhận slot từ arrival schedule | Nhận slot từ arrival schedule | Loop liên tục, tự start iteration mới |
| iteration start trigger | Arrival slot đến giờ | Arrival slot đến giờ | VU finish iteration trước |
| user identity | Derived từ iterationInTest % pool | Derived từ iterationInTest % pool | Derived từ VU id |
| Relationship VU-user | 1 VU phục vụ nhiều user | 1 VU phục vụ nhiều user | 1 VU = 1 user (gần đúng) |

### 5.3. Slot-to-VU mapping trace

Đây là trace minh họa cách slot được schedule và VU nào nhận slot:

```
Timeline trace (giả lập, W_effective ≈ 150ms):

t=0.000s  slot#0   rate=5/s   -> VU#1 nhận, bắt đầu event user-0
t=0.200s  slot#1   rate=5/s   -> VU#2 nhận, bắt đầu event user-1
t=0.400s  slot#2   rate=5/s   -> VU#3 nhận, bắt đầu event user-2
t=0.600s  slot#3   rate=5/s   -> VU#1 vừa finish slot#0, nhận slot#3
t=0.800s  slot#4   rate=5/s   -> VU#2 vừa finish slot#1, nhận slot#4
...
t=15.000s slot#150 rate=15/s  -> VU#5 nhận (VU demand tăng, thêm VU active)
...
t=27.500s slot#378 rate=21.5/s -> VU#10 nhận (giữa stage 2)
...
t=40.000s slot#688 rate=28/s  -> VU#14 nhận (peak, VU demand max)
...
t=55.000s slot#958 rate=8/s   -> VU#3 nhận (ramp-down, VU demand giảm)
```

Nhận xét:
- Cùng một VU (ví dụ VU#1) phục vụ nhiều slot khác nhau trong suốt timeline
- Mỗi slot được gán user khác nhau (user-0, user-1, ...) từ user pool
- `iterationInTest` tăng toàn cục, không phải per-VU
- VU active tăng dần khi rate tăng, giảm dần khi rate giảm

### 5.4. Công thức ánh xạ slot -> user

```js
// Pattern trong script
const userPoolSize = 1000; // hoặc từ env
const userId = `arrival-user-${exec.scenario.iterationInTest % userPoolSize}`;
```

```text
slot#0    -> iterationInTest=0    -> userId = arrival-user-0
slot#1    -> iterationInTest=1    -> userId = arrival-user-1
...
slot#999  -> iterationInTest=999  -> userId = arrival-user-999
slot#1000 -> iterationInTest=1000 -> userId = arrival-user-0  (wrap around)
```

User pool 1000 đảm bảo:
- 958 slots < 1000 users -> mỗi slot có user duy nhất
- Không user nào bị lặp trong 1 run
- Nếu run dài hơn, user wrap around -> mô phỏng user quay lại

---

## 6. Phân tích open model với stage curve

### 6.1. Open model fundamentals

```text
OPEN MODEL (ramping-arrival-rate):
  - k6 QUYẾT ĐỊNH khi nào start iteration (theo arrival schedule)
  - Iteration start KHÔNG phụ thuộc vào việc iteration trước finish chưa
  - VU là tài nguyên được pool — iteration nào cũng cần 1 VU rảnh
  - Thiếu VU -> drop slot (không chạy bù)
  - Backend chậm -> VU bận lâu -> cần nhiều VU hơn

CLOSED MODEL (ramping-vus):
  - VU QUYẾT ĐỊNH khi nào start iteration mới (khi finish iteration cũ)
  - Iteration start phụ thuộc vào iteration duration
  - VU là user — mỗi VU loop độc lập
  - Không có drop — VU tự loop, throughput là hệ quả
  - Backend chậm -> VU loop chậm -> throughput tự giảm
```

### 6.2. Open model + variable rate = sức mạnh của ramping-arrival-rate

```text
ramping-arrival-rate = open model (k6 kiểm soát start time)
                     + variable rate (rate thay đổi theo stage)

Điều này có nghĩa:
  1. k6 vẫn là "người gác cổng" quyết định khi nào bắt đầu iteration
  2. Nhưng "lịch" không cố định — nó thay đổi theo stage curve
  3. VU vẫn chỉ là worker — không phải business user
  4. Stage curve mô tả arrival pattern, không phải concurrency pattern
```

### 6.3. So sánh side-by-side: ramping-arrival-rate vs ramping-vus với cùng stage shape

Giả sử dùng cùng stage config `[{duration: "15s", target: 15}, {duration: "25s", target: 28}, {duration: "15s", target: 8}]`:

| Khía cạnh | ramping-arrival-rate | ramping-vus |
| --- | --- | --- |
| **Ý nghĩa target** | 15 iterations/s, 28 iterations/s, 8 iterations/s | 15 VUs, 28 VUs, 8 VUs |
| **Điều khiển** | Arrival rate | Concurrent VUs |
| **Stage 1 hành vi** | k6 start 5->15 iterations mỗi giây | k6 tăng VU từ 5 lên 15, mỗi VU loop liên tục |
| **Stage 2 hành vi** | k6 start 15->28 iterations mỗi giây | k6 tăng VU từ 15 lên 28 |
| **Throughput stage 2** | ~15-28 iter/s (gần target nếu không drop) | 28 VU × (1 / iteration_duration) iter/s |
| **Nếu W=200ms** | VU cần ~6, throughput ~15-28/s | Throughput ≈ 28/0.2 = 140 iter/s (cao hơn nhiều!) |
| **Nếu W=1000ms** | VU cần ~28, throughput ~15-28/s | Throughput ≈ 28/1.0 = 28 iter/s (trùng target!) |
| **Metric pass/fail** | dropped_iterations, actual iter/s vs target | http_req_duration, actual throughput |
| **Business question** | "Hệ thống chịu được 28 arrivals/s không?" | "28 user online tạo ra throughput bao nhiêu?" |

#### Key insight

```text
Với ramping-vus, throughput là HỆ QUẢ:
  - Nếu iteration nhanh (W nhỏ): throughput CAO hơn target stage nhiều
  - Nếu iteration chậm (W lớn): throughput THẤP, nhưng không drop

Với ramping-arrival-rate, throughput là INPUT:
  - k6 LUÔN cố đạt target rate (trừ khi drop)
  - Nếu iteration chậm: VU demand tăng, có thể drop nếu thiếu VU
  - Drop là tín hiệu: "hệ thống không chịu được rate này"

-> Chọn executor dựa trên câu hỏi business, không dựa trên config similarity
```

### 6.4. VU life trong open model với stage curve

```
VU lifecycle trong ramping-arrival-rate:

1. PRE-ALLOCATED: VU được tạo sẵn trước khi scenario start
   - Ngồi đợi trong pool
   - Sẵn sàng nhận slot ngay lập tức

2. ACTIVE (có iteration): VU đang chạy một arrival event
   - Bắt đầu: khi nhận slot từ arrival schedule
   - Kết thúc: khi default() function return (hoặc iteration hết duration)
   - Trong thời gian này, VU không thể nhận slot mới

3. IDLE (không iteration): VU rảnh, sẵn sàng nhận slot tiếp theo
   - Quay lại pool, đợi slot tiếp theo
   - Thời gian idle phụ thuộc vào gap giữa các slot

4. SPAWNED: VU được tạo thêm khi demand vượt preAllocatedVUs
   - Mất thời gian khởi tạo (spawn delay)
   - Có thể gây drop nếu spawn không kịp

5. GRACEFUL-STOP: Khi regular duration hết
   - Không schedule slot mới
   - VU đang active được phép finish iteration hiện tại
   - Sau gracefulStop, mọi iteration bị interrupt
```

---

## 7. Bảng service/API flow

### 7.1. Endpoint inventory

Case này mô phỏng products service browse/list traffic. Mỗi event = 1 API call, chọn ngẫu nhiên theo trọng số:

| Branch | Trọng số | Method | Endpoint | Mô tả business |
| --- | --- | --- | --- | --- |
| Product list | 70% | GET | `/api/sim/products` | Người dùng browse danh sách sản phẩm (có filter, sort, pagination) |
| Product detail | 30% | GET | `/api/sim/products/:id` | Người dùng click vào một sản phẩm cụ thể để xem chi tiết |

### 7.2. Expected call counts per stage

Với tổng ~958 scheduled slots, mỗi slot = 1 API call:

| Stage | Scheduled slots | Product list (70%) | Product detail (30%) | Tổng API calls |
| --- | --- | --- | --- | --- |
| Stage 1 (sáng) | 150 | ~105 | ~45 | 150 |
| Stage 2 (trưa) | 537.5 | ~376 | ~161 | 537.5 |
| Stage 3 (chiều) | 270 | ~189 | ~81 | 270 |
| **Tổng** | **~958** | **~670** | **~287** | **~958** |

Lưu ý: đây là expected nếu không có drop. Nếu có drop ở stage 2, số call thực tế sẽ thấp hơn.

### 7.3. API call pattern per event

```text
Mỗi event:

1. Bắt đầu event -> record startTime = Date.now()
2. Random number r = Math.random()
3. Nếu r < 0.7:
     Gọi GET /api/sim/products
     Tag: operation=product_list, endpoint=GET_/api/sim/products
   Ngược lại:
     Gọi GET /api/sim/products/:id
     Tag: operation=product_detail, endpoint=GET_/api/sim/products/:id
4. Check response status (expectedStatus: 200)
5. Kết thúc event -> record duration = Date.now() - startTime
6. Emit custom metrics:
     - ramping_arrival_events_total += 1
     - ramping_arrival_events_failed += (check fail ? 1 : 0)
     - ramping_arrival_api_calls_total += 1
     - ramping_arrival_event_duration_ms = duration
```

### 7.4. Script structure (hypothetical)

```js
// rar-01-daily-ingress-curve.js
import { sleep } from 'k6';
import exec from 'k6/execution';
import {
  buildRampingArrivalScenario,
  requestJson,
  finishEvent,
  RAMPING_ARRIVAL_EVENTS_TOTAL,
  RAMPING_ARRIVAL_EVENTS_FAILED,
  RAMPING_ARRIVAL_API_CALLS_TOTAL,
  RAMPING_ARRIVAL_EVENT_DURATION_MS,
} from './common.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:80';

export const options = {
  scenarios: {
    daily_ingress_curve: buildRampingArrivalScenario(
      'dailyIngressCurve',  // exec name
      5,                     // startRate
      '1s',                  // timeUnit
      [
        { duration: '15s', target: 15 },
        { duration: '25s', target: 28 },
        { duration: '15s', target: 8 },
      ],
      15,                    // preAllocatedVUs
      40,                    // maxVUs
      {                      // extraTags
        case_id: 'rar-01-daily-ingress-curve',
        service: 'products-service',
        workload_type: 'daily_ingress_curve',
      }
    ),
  },
};

export function dailyIngressCurve() {
  const startedAt = Date.now();

  let ok = true;
  const r = Math.random();

  if (r < 0.7) {
    // 70%: product list
    ok = requestJson(
      'GET',
      `${BASE_URL}/api/sim/products`,
      null,
      {
        operation: 'product_list',
        endpoint: 'GET_/api/sim/products',
      },
      200
    );
  } else {
    // 30%: product detail
    const productId = (exec.scenario.iterationInTest % 100) + 1;
    ok = requestJson(
      'GET',
      `${BASE_URL}/api/sim/products/${productId}`,
      null,
      {
        operation: 'product_detail',
        endpoint: 'GET_/api/sim/products/:id',
      },
      200
    );
  }

  finishEvent(startedAt, ok, {
    operation: r < 0.7 ? 'product_list' : 'product_detail',
  });
}
```

---

## 8. Metrics & tags deep-dive

### 8.1. Custom metrics (pack-defined)

| Metric name | Type | Đơn vị | Ý nghĩa | Cách emit | Dùng để |
| --- | --- | --- | --- | --- | --- |
| `ramping_arrival_events_total` | Counter | events | Số arrival event đã start và chạy xong | `finishEvent()` gọi `.add(1)` | So với `iterations` để verify event-level tracking |
| `ramping_arrival_events_failed` | Counter | events | Số event có ít nhất 1 required API call fail | `finishEvent()` với `ok=false` | Đo failure rate ở event level (cao hơn http_req_failed) |
| `ramping_arrival_api_calls_total` | Counter | calls | Tổng số HTTP API call do arrival event tạo ra | Mỗi `requestJson()` gọi `.add(1)` | Verify call count; với case này = số event (1 call/event) |
| `ramping_arrival_event_duration_ms` | Trend | ms | End-to-end duration của một arrival event | `finishEvent()` gọi `.add(duration)` | Đo latency toàn event (có thể > http_req_duration nếu có JS processing) |

### 8.2. Built-in metrics (k6 core)

| Metric name | Type | Ý nghĩa trong case này | Cách đọc |
| --- | --- | --- | --- |
| `iterations` | Counter | Số arrival event đã start và hoàn thành | ~= scheduled_slots nếu không drop |
| `dropped_iterations` | Counter | Số slot bị drop vì thiếu VU rảnh | **Pass/fail gate chính** |
| `http_reqs` | Counter | Tổng HTTP requests | ~= iterations (1 call/event) |
| `http_req_duration` | Trend | HTTP request duration | p50/p95/p99 cho mỗi endpoint |
| `http_req_failed` | Rate | Tỉ lệ HTTP request fail | Nên = 0 hoặc rất thấp |
| `checks` | Rate | Tỉ lệ check pass | Nên = 100% |
| `vus` | Gauge | Số VU active tại thời điểm hiện tại | Theo dõi VU demand theo thời gian |
| `vus_max` | Gauge | Số VU đã được khởi tạo (trần) | So với maxVUs config |
| `data_sent` | Counter | Data gửi đi | Thường thấp với GET requests |
| `data_received` | Counter | Data nhận về | Tùy payload size của API |

### 8.3. Tags (built-in + custom)

| Tag | Nguồn | Giá trị trong case này | Dùng để filter/group |
| --- | --- | --- | --- |
| `executor_family` | Custom | `ramping_arrival_rate` | Phân biệt với constant_arrival_rate, ramping_vus |
| `workload_shape` | Custom | `variable_ingress_rate` | Phân biệt với fixed_ingress_rate |
| `case_id` | Custom | `rar-01-daily-ingress-curve` | Lọc run theo case |
| `service` | Custom | `products-service` | Lọc theo service |
| `operation` | Custom | `product_list` hoặc `product_detail` | Phân tích latency theo operation |
| `endpoint` | Custom | `GET_/api/sim/products` hoặc `GET_/api/sim/products/:id` | Phân tích theo endpoint cụ thể |
| `scenario` | k6 built-in | `daily_ingress_curve` | Lọc theo scenario |
| `group` | k6 built-in | `::` (không dùng group) | - |
| `method` | k6 built-in | `GET` | Lọc theo HTTP method |
| `url` | k6 built-in | URL đầy đủ | Lọc theo URL cụ thể |
| `status` | k6 built-in | `200` (expected) | Lọc theo HTTP status |
| `expected_response` | k6 built-in | `true` | Xác nhận response status khớp expected |

### 8.4. Tag hierarchy

```text
executor_family=ramping_arrival_rate
├── workload_shape=variable_ingress_rate
│   ├── case_id=rar-01-daily-ingress-curve
│   │   ├── service=products-service
│   │   │   ├── operation=product_list
│   │   │   │   └── endpoint=GET_/api/sim/products
│   │   │   └── operation=product_detail
│   │   │       └── endpoint=GET_/api/sim/products/:id
```

### 8.5. Cách reconcile metrics

```text
Verify event-level tracking:
  ramping_arrival_events_total ≈ iterations
  (mỗi iteration là một arrival event)

Verify API call tracking:
  ramping_arrival_api_calls_total ≈ http_reqs ≈ iterations
  (case này 1 call/event, nên 3 giá trị phải gần bằng nhau)

Verify failure tracking:
  ramping_arrival_events_failed ≤ http_req_failed (tính theo count)
  (một event fail nếu IT NHẤT 1 API call fail;
   http_req_failed có thể > events_failed nếu 1 event gọi nhiều endpoint)

Verify duration:
  ramping_arrival_event_duration_ms.avg ≈ http_req_duration.avg
  (với case này, event duration ≈ HTTP request duration vì không có
   JS processing nặng hay sleep)
```

---

## 9. Pass criteria

### 9.1. Tiêu chí pass chi tiết

| # | Tiêu chí | Ngưỡng | Cách kiểm tra | Mức độ |
| --- | --- | --- | --- | --- |
| P1 | **Zero dropped_iterations (hoặc <1%)** | `dropped_iterations` < 10 (trên ~958 slots ≈ 1%) | k6 summary + dashboard executor tab | **CRITICAL** |
| P2 | **Iterations gần scheduled slots** | `iterations` >= 940 (trên ~958, cho phép sai số timing) | k6 summary | **CRITICAL** |
| P3 | **Actual iter/s theo sát target rate(t)** | Trên dashboard timeline, iter/s per bucket gần target_rate(t) | Dashboard execution timeline | HIGH |
| P4 | **Zero failed events** | `ramping_arrival_events_failed` = 0 | k6 summary | **CRITICAL** |
| P5 | **HTTP failures trong ngưỡng** | `http_req_failed` < 0.1% | k6 summary | HIGH |
| P6 | **Checks pass 100%** | `checks` rate = 100% | k6 summary | HIGH |
| P7 | **p95 latency trong SLO** | `http_req_duration` p95 < ngưỡng (ví dụ 200ms) | k6 summary | HIGH |
| P8 | **p95 event duration trong SLO** | `ramping_arrival_event_duration_ms` p95 < ngưỡng | k6 summary | MEDIUM |
| P9 | **VU không chạm trần ở peak** | `vus` < `maxVUs` tại mọi thời điểm (có headroom) | Dashboard VUs chart | MEDIUM |
| P10 | **API call count khớp event count** | `ramping_arrival_api_calls_total` ≈ `ramping_arrival_events_total` | k6 summary | LOW (consistency check) |

### 9.2. Ma trận pass/fail

| dropped_iterations | http_req_failed | p95 latency | Kết luận | Hành động |
| --- | --- | --- | --- | --- |
| 0 | 0% | < SLO | **PERFECT PASS** | Hệ thống sẵn sàng cho daily pattern |
| 0 | 0% | > SLO | **PASS với caveat** | Backend chịu được rate nhưng latency cao; cần optimize |
| 0 | > 0% | - | **PASS với failure** | Rate đạt nhưng có lỗi business; điều tra API fail |
| > 0, < 1% | 0% | < SLO | **MARGINAL** | VU pool hơi thiếu; tăng preAllocatedVUs hoặc maxVUs |
| > 0, < 1% | > 0% | > SLO | **NEEDS ATTENTION** | Cả VU và backend đều dưới sức; điều tra từng cái |
| > 1% | bất kỳ | bất kỳ | **FAIL** | Hệ thống không chịu được daily curve; cần scale |
| bất kỳ | > 1% | bất kỳ | **FAIL** | Backend có vấn đề; fix API errors trước khi rerun |

### 9.3. Pass criteria rationale

```text
Vì sao dropped_iterations = CRITICAL?

  dropped_iterations = mất business event.
  Mỗi slot drop = một customer request không được phục vụ.
  Trong production, đây là mất doanh thu.

  Với 958 slots:
    1 drop = 0.1% mất traffic -> chấp nhận được
    10 drops = 1% -> borderline
    50 drops = 5.2% -> không thể chấp nhận với production

Vì sao p95 latency quan trọng nhưng không CRITICAL bằng drop?

  Latency cao -> user experience kém, nhưng request VẪN được phục vụ.
  Drop -> request KHÔNG được phục vụ.
  Trong trade-off, drop tệ hơn latency cao.
  Nhưng latency quá cao (>1s) có thể gây timeout chain reaction
  -> tăng W_effective -> tăng VU demand -> có thể gây drop.

Vì sao cần check VU headroom?

  Nếu VU luôn sát maxVUs, hệ thống không còn buffer.
  Một spike nhỏ về latency có thể đẩy VU demand vượt maxVUs -> drop.
  Headroom = khả năng hấp thụ biến động.
```

---

## 10. Cách chạy

### 10.1. Stack requirements

Giống như constant-arrival-rate series, cần 3 service:

| Service | URL | Check |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Mở browser, login bằng token |
| Metrics API | http://localhost:18080 | `curl http://localhost:18080/v1/capabilities` |
| Load-target | http://localhost:80 | `curl http://localhost:80/health` |

### 10.2. Start stack

```powershell
# 1. Metrics + UI
cd E:\Projects\k6\k6-metrics-server\deploy\private-metrics
docker compose --env-file .env `
  -f compose.private-metrics.yml `
  -f compose.tier1-small.yml `
  up -d

# 2. Load-target
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up
```

### 10.3. Environment variables

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Linux/Bash:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

### 10.4. Run commands

```powershell
cd "E:\Khoa hoc\k6"

# Local run: chỉ xem CLI summary (nhanh, không dashboard)
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"

# Full run: có dashboard, run id, summary-final
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

### 10.5. Smoke test (rút gọn)

```powershell
# Smoke: duration ngắn, rate thấp hơn, verify script + stack OK
$env:RAR_01_START_RATE = "3"
$env:RAR_01_STAGE_1_DURATION = "5s"
$env:RAR_01_STAGE_1_TARGET = "8"
$env:RAR_01_STAGE_2_DURATION = "5s"
$env:RAR_01_STAGE_2_TARGET = "12"
$env:RAR_01_STAGE_3_DURATION = "5s"
$env:RAR_01_STAGE_3_TARGET = "4"
$env:RAR_01_PREALLOCATED_VUS = "6"
$env:RAR_01_MAX_VUS = "15"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"

# Cleanup env
Remove-Item Env:RAR_01_START_RATE, Env:RAR_01_STAGE_1_DURATION, Env:RAR_01_STAGE_1_TARGET, `
  Env:RAR_01_STAGE_2_DURATION, Env:RAR_01_STAGE_2_TARGET, Env:RAR_01_STAGE_3_DURATION, `
  Env:RAR_01_STAGE_3_TARGET, Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS `
  -ErrorAction SilentlyContinue
```

### 10.6. Sanity check connectivity

```bash
# Trước mỗi run, verify stack healthy
curl http://localhost:18080/v1/capabilities
curl -H "Authorization: Bearer student-token-1234567890" http://localhost:18080/v1/me
curl http://localhost:80/health
```

Expected output:

```text
/v1/capabilities -> {"auth_required":true,"production_mode":true,...}
/v1/me           -> {"class_id":"...","student_id":"..."}
/health          -> {"status":"ok"}
```

---

## 11. Phân tích output 5 bước

### Bước 1: Xác nhận executor/config

Mở k6 CLI output, đọc phần scenario config. Phải xác nhận:

```text
✓ executor: ramping-arrival-rate (không phải ramping-vus hay constant-arrival-rate)
✓ startRate: 5
✓ timeUnit: 1s
✓ stages[0]: duration=15s, target=15
✓ stages[1]: duration=25s, target=28
✓ stages[2]: duration=15s, target=8
✓ preAllocatedVUs: 15
✓ maxVUs: 40
✓ gracefulStop: 3s (hoặc default)
```

**Nếu config sai, dừng phân tích ngay.** Mọi kết luận phía sau vô nghĩa. Nguyên nhân config sai thường gặp:
- Env override chưa được unset từ run trước
- Gọi nhầm script (rar-01 vs car-01 vs rvus-01)
- Script dùng default khác với expected

### Bước 2: Tính expected scheduled slots

```text
Stage 1: 15 × (5 + 15) / 2 = 150
Stage 2: 25 × (15 + 28) / 2 = 537.5
Stage 3: 15 × (28 + 8) / 2  = 270
Total scheduled slots ≈ 958

lambda_peak = 28/s
average_target_rate = 958 / 55 ≈ 17.42/s
```

Ghi nhớ 3 con số này. Chúng là "ground truth" để so sánh với output thực tế.

### Bước 3: So sánh với summary

Đọc k6 summary, tập trung vào các dòng:

```text
iterations....................: ?     ?/s
dropped_iterations............: ?
interrupted...................: ?
http_reqs.....................: ?     ?/s
http_req_failed...............: ?%
checks........................: ?%
vus..........................: min=? max=?
vus_max.......................: min=? max=?
```

Expected healthy run:

```text
iterations....................: 950-960   17.3-17.5/s
dropped_iterations............: 0         0/s
interrupted...................: 0 (hoặc vài cái ở gracefulStop)
http_reqs.....................: 950-960   17.3-17.5/s
http_req_failed...............: 0.00%
checks........................: 100.00%
vus..........................: min=1-2   max=8-15
vus_max.......................: min=?     max=15-16 (gần preAllocatedVUs)
```

#### Cách đọc iterations/s trong summary

```text
iterations....................: 956   17.38/s

956 = tổng số iterations đã hoàn thành
17.38/s = completed iteration rate TRUNG BÌNH trên toàn bộ runtime

Lưu ý: 17.38/s là AVERAGE, không phải peak.
Peak rate (28/s) không hiển thị trực tiếp trong summary.
Phải xem dashboard timeline để thấy rate tại peak.
```

### Bước 4: Đọc custom metrics

```text
ramping_arrival_events_total........: ?  (nên ≈ iterations)
ramping_arrival_events_failed.......: ?  (nên = 0)
ramping_arrival_api_calls_total.....: ?  (nên ≈ iterations, 1 call/event)
ramping_arrival_event_duration_ms...: avg=? p(95)=? p(99)=?
```

Expected healthy run:

```text
ramping_arrival_events_total........: 950-960
ramping_arrival_events_failed.......: 0
ramping_arrival_api_calls_total.....: 950-960
ramping_arrival_event_duration_ms...: avg=50-150ms p(95)=100-250ms
```

#### Reconciliation

```text
Check: ramping_arrival_events_total ≈ iterations?
  Yes -> event-level tracking đúng

Check: ramping_arrival_api_calls_total ≈ http_reqs?
  Yes -> API call tracking khớp HTTP layer

Check: ramping_arrival_events_failed = 0?
  Yes -> không có event fail

Check: ramping_arrival_event_duration_ms.avg ≈ http_req_duration.avg?
  Gần bằng -> event duration chủ yếu là HTTP time, không có overhead JS
```

### Bước 5: Đọc VU pressure và kết luận

```text
Đọc VU chart (dashboard) hoặc vus/vus_max summary:

Nếu vus_max < preAllocatedVUs:
  -> Pool không cần spawn thêm VU nào
  -> preAllocatedVUs=15 đủ cho toàn bộ timeline
  -> Headroom dư nhiều

Nếu vus_max = preAllocatedVUs:
  -> Pool dùng hết preAllocated, có thể đã spawn vài VU nhưng
     vus_max đếm tất cả VU đã khởi tạo
  -> Cận dưới của headroom

Nếu vus_max > preAllocatedVUs nhưng < maxVUs:
  -> Pool đã spawn thêm VU, nhưng chưa chạm trần
  -> Còn headroom, OK

Nếu vus_max = maxVUs:
  -> Pool chạm trần
  -> Nếu dropped_iterations=0: vẫn OK, nhưng không còn buffer
  -> Nếu dropped_iterations>0: cần tăng maxVUs

Kết luận cuối cùng:
  - Pass nếu: dropped=0, failed=0, p95<SLO, VU còn headroom
  - Marginal nếu: dropped<1%, failed=0, p95<SLO
  - Fail nếu: dropped>1% hoặc failed>0 hoặc p95>>SLO
```

---

## 12. Dashboard 3-chart deep analysis

### 12.1. Chart 1: Response time (theo stage)

Chart này hiển thị latency theo thời gian. Với daily curve, cần đọc theo từng stage:

#### Stage 1 (0-15s): Morning ramp-up

```text
Kỳ vọng:
  - p50: 40-80ms, ổn định
  - p95: 80-150ms, có thể hơi cao ở đầu (cold start)
  - Không có spike đột ngột
  - Có thể thấy cold start: p95 cao hơn ở 1-2 giây đầu

Dấu hiệu bất thường:
  - p95 > 300ms ngay từ stage 1: backend có vấn đề dù rate thấp
  - Spike đơn lẻ > 1s: có thể GC pause hoặc DB lock
  - Latency tăng dần đều: connection pool cạn dần
```

#### Stage 2 (15-40s): Noon peak

```text
Kỳ vọng:
  - p50: 60-120ms, tăng nhẹ so với stage 1
  - p95: 120-300ms, tăng rõ rệt ở nửa cuối stage 2 (rate cao nhất)
  - p99: 200-500ms, tail latency xuất hiện
  - Latency curve đi lên dần theo rate

Dấu hiệu bất thường:
  - p95 > 500ms: backend quá tải ở peak
  - p95 spike đột ngột ở rate ~20/s: có thể đây là ngưỡng bão hòa
  - p50 cao hơn p95 stage 1: toàn bộ latency distribution shift lên
  - Latency tăng theo bậc thang: có thể queueing ở tầng DB/pool
```

#### Stage 3 (40-55s): Afternoon ramp-down

```text
Kỳ vọng:
  - Latency giảm dần theo rate
  - p50: 50-80ms, về gần stage 1
  - p95: 100-200ms, giảm dần
  - Có thể còn "đuôi" latency cao ở đầu stage 3 (in-flight từ peak)

Dấu hiệu bất thường:
  - Latency không giảm dù rate giảm: backend chưa hồi phục
  - Latency vẫn cao ở cuối stage 3: memory/connection leak
  - p95 đột ngột giảm rồi tăng lại: GC hoặc resource cleanup/reacquire
```

#### Bảng tổng hợp response time expected

| Stage | p50 expected | p95 expected | p99 expected | Cảnh báo nếu |
| --- | --- | --- | --- | --- |
| Stage 1 (5-15/s) | 40-80ms | 80-150ms | 100-200ms | p95 > 200ms |
| Stage 2 (15-28/s) | 60-120ms | 120-300ms | 200-500ms | p95 > 500ms |
| Stage 3 (28-8/s) | 50-80ms | 100-200ms | 150-300ms | p95 không giảm theo rate |

### 12.2. Chart 2: Execution timeline (ramping shape)

Đây là chart quan trọng nhất để verify stage curve.

#### Cách đọc

```text
Trục X: thời gian (0-58s)
Trục Y: iterations/s hoặc requests/s per bucket

Kỳ vọng:
  - Đường iterations/s có hình dạng khớp với daily curve:
    * 0-15s:  đi lên từ 5 -> 15/s
    * 15-40s: đi lên từ 15 -> 28/s
    * 40-55s: đi xuống từ 28 -> 8/s
  - Đường http_reqs/s có hình dạng tương tự (vì 1 call/event)
  - Không có "hố" (gap) ở bất kỳ bucket nào
  - Đường dropped_iterations = 0 ở tất cả bucket

Bucket size thường là 1s hoặc 2s.
Với bucket 1s, số iteration/bucket ≈ rate tại giây đó.
```

#### Timeline checklist

| Điểm kiểm tra | Vị trí | Expected | Nếu sai |
| --- | --- | --- | --- |
| Bắt đầu stage 1 | t=0-2s | iter/s bắt đầu ~5, tăng dần | Nếu =0: cold start chậm; nếu >>5: config sai startRate |
| Giữa stage 1 | t=7-8s | iter/s ~10 | Nếu thấp hơn: drop hoặc schedule sai |
| Cuối stage 1 | t=13-15s | iter/s ~15 | Nếu thấp hơn: VU thiếu hoặc drop |
| Chuyển stage 1->2 | t=15s | iter/s liên tục ~15 (không gap) | Nếu gap: transition issue |
| Giữa stage 2 | t=27-28s | iter/s ~21-22 | So với target rate(t) |
| Cuối stage 2 | t=38-40s | iter/s ~28 | **Đây là điểm quyết định pass/fail** |
| Chuyển stage 2->3 | t=40s | iter/s liên tục ~28 | Nếu tụt: VU pool không đủ ở peak |
| Giữa stage 3 | t=47-48s | iter/s ~18 | Kiểm tra ramp-down có mượt không |
| Cuối stage 3 | t=53-55s | iter/s ~8 | Iter/s có về đúng target không? |
| Graceful stop | t=55-58s | iter/s giảm về 0 | Iteration finish nốt, không schedule mới |

#### Trace: cách đọc execution timeline bucket-by-bucket

```
Bucket (giây)  Target rate   Expected iter   OK nếu trong khoảng
t=0-1          5.0-5.7/s     5-6             -
t=1-2          5.7-6.3/s     6-7             -
...
t=14-15        14.3-15.0/s   14-15           -
t=15-16        15.0-15.5/s   15-16           (transition, phải liên tục)
...
t=39-40        27.5-28.0/s   27-28           (PEAK! quan trọng nhất)
t=40-41        27.3-28.0/s   27-28           (vẫn peak, bắt đầu giảm)
...
t=54-55        8.7-8.0/s     8-9             -
t=55-56        gracefulStop  giảm dần        (không schedule slot mới)
```

### 12.3. Chart 3: VUs vs iter/s (VU demand follows rate curve)

Đây là chart trả lời: "k6 cần bao nhiêu VU để giữ được daily curve?"

#### Cách đọc

```text
Trục Y trái: active VUs
Trục Y phải: iterations/s
Trục X: thời gian

Kỳ vọng:
  - Đường VUs có hình dạng TƯƠNG TỰ nhưng KHÔNG trùng với đường iter/s
  - VUs tăng dần trong stage 1 và 2, đạt max ở cuối stage 2 / đầu stage 3
  - VUs giảm dần trong stage 3
  - VUs luôn dưới maxVUs (40), lý tưởng dưới preAllocatedVUs (15)
  - iter/s theo đúng đường cong target

Mối quan hệ VUs và iter/s:
  - iter/s = target_rate(t) (input)
  - VUs ≈ rate(t) × W_effective (hệ quả)
  - Nếu W_effective tăng -> VUs tăng dù iter/s không đổi
  - Nếu VUs chạm maxVUs -> iter/s có thể tụt (drop)
```

#### Phân tích VUs chart theo stage

**Stage 1: Morning ramp-up**
```text
iter/s: 5 -> 15 /s
VUs: 1-3 (với W≈100ms) hoặc 3-8 (với W≈300ms)

Nếu VUs đã >10 ở stage 1:
  -> W_effective lớn bất thường (có thể backend rất chậm)
  -> Hoặc preAllocatedVUs được dùng hết dù rate thấp

Nếu VUs = 1-2:
  -> Event rất nhanh, pool dư nhiều
```

**Stage 2: Noon peak**
```text
iter/s: 15 -> 28 /s
VUs: 4-6 (W≈100ms) hoặc 8-15 (W≈300ms) hoặc 15-22 (W≈500ms)

Đây là vùng quan trọng nhất:
  - Nếu VUs < preAllocatedVUs (15): hệ thống thoải mái
  - Nếu VUs = 15-20: đã vượt preAllocated, đang spawn thêm
  - Nếu VUs = 40 (max): nguy hiểm, không còn buffer
  - Nếu VUs = 40 và iter/s tụt: dropped_iterations!
```

**Stage 3: Afternoon ramp-down**
```text
iter/s: 28 -> 8 /s
VUs: giảm dần từ peak về 1-3

Nếu VUs không giảm dù iter/s giảm:
  -> In-flight iterations vẫn đang chạy (W_effective lớn)
  -> Có thể iteration bắt đầu ở stage 2 vẫn chưa finish ở stage 3

Nếu VUs giảm nhanh hơn iter/s:
  -> Iteration duration đang giảm (backend nhẹ dần)
```

#### Bảng phân tích VU/iter relationship

| Pattern VUs vs iter/s | Ý nghĩa | Hành động |
| --- | --- | --- |
| VUs thấp, iter/s đạt target | W_effective nhỏ, pool dư headroom | OK, có thể giảm preAllocatedVUs nếu muốn |
| VUs tăng theo iter/s (tỉ lệ) | W_effective ổn định | OK, hệ thống hoạt động bình thường |
| VUs tăng nhanh hơn iter/s | W_effective đang tăng (backend chậm dần) | Điều tra latency, có thể sắp chạm giới hạn |
| VUs chạm maxVUs, iter/s vẫn đạt | Sát giới hạn, không buffer | Tăng maxVUs hoặc giảm target rate |
| VUs chạm maxVUs, iter/s tụt | Quá tải, đang drop | Tăng VU pool hoặc tối ưu backend |
| VUs giảm chậm hơn iter/s | In-flight iteration dài | Bình thường ở ramp-down, trừ khi quá lâu |

---

## 13. 4 output -> decision scenarios

### 13.1. Scenario A: Perfect pass — tất cả stage đạt, 0 drops

#### Output mẫu

```text
iterations....................: 956   17.38/s
dropped_iterations............: 0     0/s
http_reqs.....................: 956   17.38/s
http_req_failed...............: 0.00%
checks........................: 100.00%
vus..........................: min=1   max=11
vus_max.......................: min=15  max=15

ramping_arrival_events_total........: 956
ramping_arrival_events_failed.......: 0
ramping_arrival_api_calls_total.....: 956
ramping_arrival_event_duration_ms...: avg=87.3  p(95)=156.2  p(99)=234.1

http_req_duration..................: avg=85.1  p(95)=152.8  p(99)=228.7
```

#### Phân tích dashboard

```text
Chart 1 (Response time):
  - Stage 1: p50~45ms, p95~90ms — cold start nhẹ ở giây đầu
  - Stage 2: p50~70ms, p95~150ms — tăng dần theo rate, không spike
  - Stage 3: p50~55ms, p95~110ms — giảm dần về gần stage 1

Chart 2 (Execution timeline):
  - iter/s theo sát đường target: 5->15->28->8
  - Không bucket nào hụt quá 10% target
  - Transition mượt, không gap

Chart 3 (VUs vs iter/s):
  - VUs: 2 -> 11 -> 3, theo hình chữ V ngược
  - VU_max = 11 < preAllocatedVUs=15 -> không cần spawn thêm
  - Headroom còn 4 VU (27% buffer)
```

#### Kết luận

```text
DECISION: Hệ thống SẴN SÀNG cho daily ingress pattern.

Evidence:
  - Zero drops: mọi arrival slot được phục vụ
  - Zero failures: không có lỗi business
  - Latency trong SLO: p95=156ms < 200ms threshold
  - VU headroom: 11/15 preAllocated, 11/40 max -> còn nhiều buffer

Action:
  - Ghi nhận baseline
  - Có thể thử tăng peak rate (variation V4) để tìm giới hạn
  - Theo dõi production monitoring để so sánh
```

### 13.2. Scenario B: Peak stage drops — VU pool không đủ cho 28/s peak

#### Output mẫu

```text
iterations....................: 891   16.20/s
dropped_iterations............: 65    1.18/s
http_reqs.....................: 891   16.20/s
http_req_failed...............: 0.00%
checks........................: 100.00%
vus..........................: min=1   max=40
vus_max.......................: min=15  max=40

ramping_arrival_events_total........: 891
ramping_arrival_events_failed.......: 0
ramping_arrival_api_calls_total.....: 891
ramping_arrival_event_duration_ms...: avg=423.5  p(95)=782.1  p(99)=1234.5
```

#### Phân tích dashboard

```text
Chart 1 (Response time):
  - Stage 1: p50~80ms, p95~150ms — bình thường
  - Stage 2: p50~300ms, p95~780ms — LATENCY SPIKE!
    Đặc biệt từ t=30s trở đi (rate > 22/s), latency tăng phi tuyến
  - Stage 3: p50~200ms, p95~500ms — vẫn cao dù rate giảm
    Backend chưa hồi phục

Chart 2 (Execution timeline):
  - Stage 1: iter/s OK, khớp target
  - Stage 2: iter/s theo target đến ~22/s, sau đó FLAT (không tăng tiếp)
    Từ t=30-40s: iter/s ~22-23/s dù target là 22-28/s
    -> Hệ thống bão hòa ở ~22/s
  - Stage 3: iter/s thấp hơn target ở đầu (vẫn bão hòa)
    Về cuối stage 3: iter/s khớp target (rate đã giảm dưới ngưỡng bão hòa)
  - dropped_iterations xuất hiện từ t=28s, tập trung ở t=30-42s

Chart 3 (VUs vs iter/s):
  - VUs tăng nhanh trong stage 2, chạm maxVUs=40 ở t=30s
  - VUs = 40 liên tục từ t=30s đến t=45s
  - iter/s flat ở ~22/s dù target tăng -> đây là capacity limit
  - VUs chỉ giảm khi rate target xuống dưới ~22/s (t≈47s)
```

#### Root cause analysis

```text
NGUYÊN NHÂN GỐC: W_effective quá lớn ở peak.

Tính ngược từ VU=40 và iter/s=22:
  W_effective ≈ VUs / rate = 40 / 22 ≈ 1.82s

Tức là mỗi iteration mất ~1.82s để hoàn thành.
Với W=1.82s và lambda_peak=28/s:
  required_vus = ceil(28 × 1.82) = 51 VU
  Nhưng maxVUs chỉ có 40 -> thiếu 11 VU -> drop.

Vì sao W_effective cao?
  - Backend quá tải ở rate > 22/s
  - Connection pool cạn, request queueing
  - DB query chậm dưới tải cao
  - Hoặc external dependency (payment, inventory) chậm
```

#### Kết luận

```text
DECISION: Hệ thống CHỈ CHỊU ĐƯỢC ~22/s, không đạt peak 28/s.

Evidence:
  - 65 dropped_iterations (6.8% mất traffic)
  - VU chạm trần 40/40
  - Latency spike phi tuyến từ 22/s
  - Bão hòa ở ~22/s

Action:
  1. Điều tra vì sao W_effective = 1.82s (quá cao)
     - Check backend CPU/memory/DB pool
     - Check external dependency timeout
  2. Tối ưu backend để giảm W_effective
  3. Nếu không giảm được W: tăng maxVUs lên ít nhất 51-60
  4. Hoặc chấp nhận SLA 22/s và scale ngang backend
  5. Rerun sau khi fix để verify
```

### 13.3. Scenario C: Transition drops — drops tập trung ở stage boundaries

#### Output mẫu

```text
iterations....................: 942   17.13/s
dropped_iterations............: 14    0.25/s
http_reqs.....................: 942   17.13/s
http_req_failed...............: 0.00%
checks........................: 100.00%
vus..........................: min=1   max=18
vus_max.......................: min=15  max=18

ramping_arrival_events_total........: 942
ramping_arrival_event_duration_ms...: avg=112.4  p(95)=195.3  p(99)=289.7
```

#### Phân tích dashboard

```text
Chart 2 (Execution timeline):
  - HẦU HẾT timeline OK
  - NHƯNG: có 2 cụm drop nhỏ:
    * t=15-17s: 6 drops (transition stage 1->2)
    * t=40-42s: 8 drops (transition stage 2->3)
  - Ngoài 2 cụm này: iter/s khớp target hoàn toàn
  - Tổng drop: 14 (~1.5%)

Chart 3 (VUs vs iter/s):
  - VUs bình thường: 3-10 trong suốt run
  - Tại t=15s: VUs tăng từ 3 lên 8 (spawn thêm 5 VU)
  - Tại t=40s: VUs tăng từ 10 lên 18 (spawn thêm 8 VU)
  - Spawn mất ~1-2s -> trong thời gian spawn, VU thiếu -> drop

Root cause: preAllocatedVUs=15 đủ cho steady state,
           nhưng spawn delay ở rate change gây drop tạm thời.
           VU_demand tăng NHANH hơn khả năng spawn.
```

#### Phân biệt với Scenario B

| Khía cạnh | Scenario B (peak drops) | Scenario C (transition drops) |
| --- | --- | --- |
| Vị trí drop | Liên tục ở peak (30-42s) | Cục bộ ở transition (15-17s, 40-42s) |
| VU pattern | Chạm maxVUs, giữ lâu | Tăng đột ngột, rồi ổn định |
| Latency | Rất cao ở peak (p95>500ms) | Bình thường (p95<200ms) |
| W_effective | Lớn (1-2s) | Nhỏ (100-200ms) |
| Nguyên nhân gốc | Backend quá tải | Spawn delay |
| Cách fix | Tối ưu backend hoặc tăng maxVUs | Tăng preAllocatedVUs hoặc giảm gradient rate |

#### Kết luận

```text
DECISION: Hệ thống CHỊU ĐƯỢC daily curve về mặt backend,
          nhưng VU pool configuration cần điều chỉnh.

Evidence:
  - Chỉ 14 drops (1.5%), tất cả ở transition
  - Latency bình thường, backend không quá tải
  - VU không chạm maxVUs (18/40)
  - Drops biến mất sau khi spawn hoàn tất

Action:
  1. Tăng preAllocatedVUs từ 15 lên 20-25
     -> spawn sẵn nhiều VU hơn, giảm spawn delay ở transition
  2. Hoặc thêm stage đệm (ví dụ: plateau 15/s trong 3s trước khi ramp lên 28/s)
  3. Rerun để verify không còn transition drops
  4. Đây là kết quả TỐT: backend OK, chỉ cần tune config
```

### 13.4. Scenario D: Tail latency ở peak — p95 spikes ở 28/s stage

#### Output mẫu

```text
iterations....................: 955   17.36/s
dropped_iterations............: 0     0/s
http_reqs.....................: 955   17.36/s
http_req_failed...............: 0.00%
checks........................: 100.00%
vus..........................: min=1   max=13
vus_max.......................: min=15  max=15

ramping_arrival_events_total........: 955
ramping_arrival_event_duration_ms...: avg=134.7  p(95)=512.3  p(99)=876.4

http_req_duration..................: avg=132.1  p(95)=508.7  p(99)=870.2
```

#### Phân tích dashboard

```text
Chart 1 (Response time):
  - Stage 1: p50~45ms, p95~90ms — đẹp
  - Stage 2: p50~80ms, p95~250ms ở nửa đầu, p95~500ms ở nửa cuối
    -> p95 TĂNG DẦN theo rate, đạt đỉnh ở gần cuối stage 2
    -> p50 vẫn ổn (80-100ms) — median user không bị ảnh hưởng
    -> p99 lên tới 800ms+ — 1% user bị chậm nghiêm trọng
  - Stage 3: p95 giảm dần về 200ms, p50 về 55ms

Chart 2 (Execution timeline):
  - iter/s theo sát target — KHÔNG drop
  - Tất cả slot được phục vụ

Chart 3 (VUs vs iter/s):
  - VUs: 2 -> 13 -> 3
  - VU_max = 13 < preAllocatedVUs=15
  - Không có dấu hiệu VU pressure
```

#### Root cause analysis

```text
Đây là LATENCY TAIL, không phải capacity issue.

Đặc điểm của tail latency:
  - Median (p50) vẫn tốt: đa số user trải nghiệm tốt
  - p95 cao: 5% user bị chậm
  - p99 rất cao: 1% user bị rất chậm
  - KHÔNG drop: tất cả request được phục vụ (nhưng một số chậm)

Nguyên nhân có thể:
  1. GC pause: một số request trùng với GC -> latency spike
  2. DB lock contention: product detail query đụng lock
  3. Connection pool exhaustion: một số request phải đợi connection
  4. Cold cache: một số product chưa được cache
  5. Network jitter: một số request bị delay ở network layer
  6. External dependency timeout: product detail có thể gọi service khác
```

#### Điều tra sâu hơn

```text
Phân tích theo tag operation:

  operation=product_list:
    p50=75ms, p95=180ms, p99=250ms -> ổn

  operation=product_detail:
    p50=120ms, p95=550ms, p99=900ms -> ĐÂY LÀ THỦ PHẠM!

-> Product detail API có tail latency.
   30% events bị ảnh hưởng bởi nhánh này.
   Cần điều tra riêng GET /api/sim/products/:id.
```

#### Kết luận

```text
DECISION: Hệ thống CHỊU ĐƯỢC daily curve về mặt throughput,
          nhưng CÓ VẤN ĐỀ LATENCY TAIL ở product detail API.

Evidence:
  - Zero drops: mọi slot được phục vụ
  - Zero failures: không có lỗi business
  - NHƯNG: p95=512ms — vượt SLO (giả sử 200ms)
  - Root cause: product_detail endpoint (30% traffic)
  - Product list endpoint OK

Action:
  1. Điều tra GET /api/sim/products/:id:
     - DB query plan (có missing index?)
     - Cache hit rate (cold product?)
     - External dependency (inventory, price service?)
  2. Nếu fix được tail latency: pass hoàn toàn
  3. Nếu không fix được: quyết định xem p95=500ms có chấp nhận được không
     - Nếu có: pass với caveat
     - Nếu không: cần optimize hoặc scale
  4. Đây là kết quả ĐÚNG của test: phát hiện vấn đề thật
```

---

## 14. "Nghịch lý" (4)

### 14.1. NL1: "Average rate 17.4/s nhưng phải size cho peak 28/s"

#### Nghịch lý

```text
Nếu nhìn qua config:
  Tổng thời gian 55s, tổng slots 958
  -> Trung bình 17.4 slots/s

Nhiều người nghĩ: "Chỉ cần đủ VU cho 17.4/s là được."
  -> SAI và NGUY HIỂM.
```

#### Vì sao phải size cho peak?

```text
ramping-arrival-rate là OPEN MODEL:
  - k6 CỐ START iteration theo lịch
  - Tại t=40s, lịch nói: "start 28 iterations trong giây này"
  - Nếu chỉ có đủ VU cho 17/s: 11 slot sẽ bị DROP
  - Không có cơ chế "dùng VU dư từ lúc trước" vì VU chỉ
    có thể chạy 1 iteration tại một thời điểm

Tương tự production:
  - Hệ thống phải chịu được peak traffic
  - Không thể nói: "trung bình tôi chỉ có 100 user,
    nên tôi chỉ cần infrastructure cho 100 user"
  - Phải scale cho peak (1000 user), dù peak chỉ kéo dài 1 giờ/ngày

Little's Law khẳng định:
  VU cần = rate × W_effective (tại thời điểm đó)
  -> VU cần tại peak = 28 × W
  -> VU cần tại average = 17.4 × W
  -> Tỉ lệ = 28/17.4 = 1.61x
```

#### Hệ quả thực tế

```text
Nếu bạn size VU pool dựa trên average rate:
  - preAllocatedVUs = ceil(17.4 × 0.5) = 9
  - Nhưng peak cần ceil(28 × 0.5) = 14
  - Thiếu 5 VU ở peak -> ~180 slots bị drop (toàn bộ stage 2-3)
  - Test fail vì config sai, không phải vì backend yếu

Bài học: VU sizing cho ramping-arrival-rate LUÔN dùng lambda_peak.
         Average rate chỉ dùng để ước tính tổng slots/số lượng test case.
```

### 14.2. NL2: "Stage 3 ramp-down 28->8/s nhưng VU vẫn cần cho in-flight iterations"

#### Nghịch lý

```text
Khi rate giảm từ 28 xuống 8/s, nhiều người nghĩ:
  "VU demand sẽ giảm ngay lập tức theo rate."

Nhưng thực tế:
  - VU demand = rate(t) × W_effective
  - rate(t) giảm, nhưng W_effective có thể vẫn CAO
  - Các iteration bắt đầu ở cuối stage 2 (rate 28/s)
    vẫn đang CHẠY DỞ trong stage 3
  - Những VU này vẫn bận, không rảnh để nhận slot mới
```

#### Ví dụ cụ thể

```text
t=40s: rate=28/s, iteration A bắt đầu (W=500ms)
       VU#10 nhận iteration A, bận đến t=40.5s

t=40.1s: rate≈27.9/s, iteration B bắt đầu
         Cần 1 VU rảnh. VU#10 đang bận với A.
         VU#11 nhận B (nếu có).

t=40.5s: iteration A finish, VU#10 rảnh
         Nhưng rate lúc này đã là ≈27.3/s
         VU#10 nhận slot mới ngay lập tức

-> Dù rate đang giảm, VU vẫn luân chuyển liên tục.
   Số VU cần = rate(t) × W_effective (công thức Little)
   KHÔNG giảm nhanh hơn rate.

t=47.5s: rate=18/s, W vẫn 500ms (backend chưa hồi phục)
         VU cần = 18 × 0.5 = 9 VU
         (vẫn cao, dù rate đã giảm 36% từ peak)

t=55s: rate=8/s, W giảm về 200ms (backend nhẹ)
       VU cần = 8 × 0.2 = 2 VU
       (giảm mạnh vì cả rate và W cùng giảm)
```

#### Hệ quả

```text
Không thể giảm preAllocatedVUs ngay khi stage 3 bắt đầu.
VU demand giảm TỪ TỪ, không phải đột ngột.
In-flight iterations từ peak vẫn tiêu thụ VU trong stage 3.

Nếu W_effective không đổi (backend vẫn chậm dù rate giảm):
  VU_demand giảm tuyến tính theo rate
  Vẫn cần VU cho đến khi rate về 0

Đây là lý do gracefulStop=3s quan trọng:
  Sau t=55s, không schedule slot mới
  Nhưng VU vẫn chạy iteration đang dở (đến 3s)
  Nếu gracefulStop quá ngắn -> iteration bị interrupt
```

### 14.3. NL3: "preAllocatedVUs=15 cho peak 28/s — tưởng ít nhưng event nhanh thì đủ"

#### Nghịch lý

```text
preAllocatedVUs=15 << lambda_peak=28

Thoạt nhìn: 15 VU cho 28 slot/s -> thiếu 13 VU -> sẽ drop?
```

#### Vì sao 15 VU có thể đủ?

```text
Little's Law: VU cần = rate × W_effective

Nếu W_effective = 100ms:
  VU cần = 28 × 0.1 = 2.8 -> 3 VU
  15 VU >> 3 VU -> DƯ RẤT NHIỀU

Nếu W_effective = 200ms:
  VU cần = 28 × 0.2 = 5.6 -> 6 VU
  15 VU >> 6 VU -> dư 2.5x

Nếu W_effective = 500ms:
  VU cần = 28 × 0.5 = 14 VU
  15 VU ≈ 14 VU -> vừa đủ

Nếu W_effective = 1000ms:
  VU cần = 28 × 1.0 = 28 VU
  15 VU < 28 VU -> thiếu 13 VU -> DROP

KẾT LUẬN: VU count (15) không thể đánh giá độc lập.
         Phải nhân với W_effective.
         15 VU có thể "nhiều" hoặc "ít" tùy vào event duration.
```

#### So sánh với closed model

```text
Trong ramping-vus (closed model):
  15 VU = 15 concurrent users
  Nếu iteration kéo dài 1s: throughput ~15 iter/s
  Nếu iteration kéo dài 100ms: throughput ~150 iter/s
  -> Throughput tỉ lệ nghịch với iteration duration

Trong ramping-arrival-rate (open model):
  15 VU = 15 workers
  Nếu rate=28/s và W=100ms: 15 VU dư, ~3 VU active
  Nếu rate=28/s và W=1000ms: 15 VU thiếu, cần 28 VU
  -> Thừa/thiếu phụ thuộc vào rate × W, không phải con số tuyệt đối
```

### 14.4. NL4: "ramping-arrival-rate vs ramping-vus: cùng stage shape, khác model"

#### Nghịch lý

```text
Cùng config stages: [{duration: "15s", target: 15}, {duration: "25s", target: 28}, ...]
Cùng số liệu: 15 và 28

Nhưng Ý NGHĨA HOÀN TOÀN KHÁC:
  ramping-arrival-rate: target = arrival rate (iterations/s)
  ramping-vus:          target = VU count (concurrent users)

Nếu không đọc kỹ executor, có thể nhầm:
  "28 VU -> 28 iter/s" (SAI với ramping-vus)
  "28 iter/s -> cần 28 VU" (SAI với ramping-arrival-rate)
```

#### Ví dụ cụ thể

```text
Test A: ramping-arrival-rate, target=28/s, W=200ms
  -> k6 start 28 iterations/s
  -> VU cần = 28 × 0.2 = 6 VU
  -> Kết luận: "Hệ thống chịu được 28 arrivals/s"
  -> Nếu pass: production có thể nhận 28 requests/s

Test B: ramping-vus, target=28 VU, W=200ms
  -> k6 chạy 28 VU concurrent
  -> Throughput = 28 / 0.2 = 140 iter/s
  -> Kết luận: "28 user online tạo ra 140 iter/s"
  -> Nếu pass: production chịu được 28 users, tạo ra 140 req/s

HAI KẾT LUẬN HOÀN TOÀN KHÁC NHAU!
Cùng số 28, nhưng:
  Test A: 28 là INPUT (rate), VU=6 là OUTPUT
  Test B: 28 là VU (INPUT), throughput=140 là OUTPUT
```

#### Bảng quyết định chọn executor

| Business question | Dùng executor | Vì sao |
| --- | --- | --- |
| "Hệ thống chịu được X requests/s không?" | ramping-arrival-rate | Rate là input, pass/fail dựa trên drop |
| "X users online tạo ra throughput bao nhiêu?" | ramping-vus | VU là user, throughput là output |
| "Cần bao nhiêu server cho peak hour?" | ramping-arrival-rate | Kiểm tra ingress capacity |
| "Cần bao nhiêu user để bão hòa hệ thống?" | ramping-vus | Tăng VU đến khi latency vượt SLO |
| "Daily traffic pattern có gây quá tải không?" | ramping-arrival-rate | Stage curve mô phỏng arrival pattern |
| "User tăng đột biến có gây quá tải không?" | ramping-vus | Stage curve mô phỏng concurrency spike |

---

## 15. Checklist

### 15.1. Pre-run checklist

| # | Mục | Check | Ghi chú |
| --- | --- | --- | --- |
| 1 | Stack up | `docker ps` thấy metrics, load-target | Nếu thiếu service, chưa chạy |
| 2 | Metrics API healthy | `curl localhost:18080/v1/capabilities` | Auth required = true |
| 3 | Load-target healthy | `curl localhost:80/health` | Status = ok |
| 4 | Token valid | `curl -H "Authorization: Bearer student-token-1234567890" localhost:18080/v1/me` | Có class_id |
| 5 | Env vars set | `$env:BASE_URL`, `$env:K6_CLOUD_HOST`, `$env:K6_CLOUD_TOKEN` | Kiểm tra bằng `ls env:` |
| 6 | Script path đúng | Test `ls` script file tồn tại | `rar-01-daily-ingress-curve.js` |
| 7 | Không còn env override từ run trước | `Remove-Item Env:RAR_01_* -ErrorAction SilentlyContinue` | Tránh config sai |
| 8 | Không active run cũ | Dashboard không còn run "running" | Nếu có, finish run cũ |
| 9 | Đã đọc case doc này | Hiểu expected output | Để biết pass/fail trông như thế nào |
| 10 | Đã tính expected slots | 958 slots, lambda_peak=28/s, average=17.4/s | Ghi ra giấy/note |

### 15.2. During-run checklist

| # | Mục | Check | Công cụ |
| --- | --- | --- | --- |
| 1 | Dashboard live update | Mở http://localhost:13001, thấy run đang chạy | Browser |
| 2 | Execution timeline có hình daily curve | iter/s tăng dần -> peak -> giảm dần | Dashboard Overview |
| 3 | VUs không chạm maxVUs | VUs < 40 (lý tưởng < 20) | Dashboard VUs chart |
| 4 | Không có error log trên CLI | Không thấy `ERRO` hoặc `WARN` bất thường | k6 CLI output |
| 5 | Không có connection refused | Không thấy `dial tcp: connect: connection refused` | k6 CLI stderr |
| 6 | Metrics push đều | Không thấy `Failed to push metrics` | k6 CLI output |

### 15.3. Post-run checklist

| # | Mục | Check | Ngưỡng pass |
| --- | --- | --- | --- |
| 1 | `dropped_iterations` | k6 summary | = 0 (hoặc < 10) |
| 2 | `iterations` | k6 summary | 940-960 |
| 3 | `http_req_failed` | k6 summary | 0.00% |
| 4 | `checks` | k6 summary | 100.00% |
| 5 | `ramping_arrival_events_failed` | k6 summary | = 0 |
| 6 | `ramping_arrival_events_total` | k6 summary | ≈ iterations |
| 7 | `ramping_arrival_api_calls_total` | k6 summary | ≈ http_reqs |
| 8 | `ramping_arrival_event_duration_ms` p95 | k6 summary | < SLO threshold |
| 9 | `http_req_duration` p95 | k6 summary | < SLO threshold |
| 10 | VU_max | k6 summary | < maxVUs (40), lý tưởng < 20 |
| 11 | Dashboard execution timeline OK | Dashboard | iter/s curve khớp target |
| 12 | Dashboard response time OK | Dashboard | Không spike bất thường |
| 13 | Dashboard VUs OK | Dashboard | VU curve theo rate curve |
| 14 | Executor tab confirm | Dashboard | executor=ramping-arrival-rate, config đúng |
| 15 | Summary-final reconcile | Dashboard + k6 CLI | Dashboard summary khớp CLI summary |

---

## 16. 5 variations với code

### 16.1. V1: Lower peak rate smoke

**Mục đích:** Verify script + stack nhanh trước khi chạy full config.

**Thay đổi:** Giảm peak rate từ 28/s xuống 10/s, rút ngắn duration.

```powershell
$env:RAR_01_START_RATE = "3"
$env:RAR_01_STAGE_1_DURATION = "5s"
$env:RAR_01_STAGE_1_TARGET = "6"
$env:RAR_01_STAGE_2_DURATION = "8s"
$env:RAR_01_STAGE_2_TARGET = "10"
$env:RAR_01_STAGE_3_DURATION = "5s"
$env:RAR_01_STAGE_3_TARGET = "4"
$env:RAR_01_PREALLOCATED_VUS = "8"
$env:RAR_01_MAX_VUS = "20"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

**Expected smoke output:**

```text
Stage 1: 5 × (3+6)/2 = 22.5 slots
Stage 2: 8 × (6+10)/2 = 64 slots
Stage 3: 5 × (10+4)/2 = 35 slots
Total ≈ 122 slots
lambda_peak = 10/s

Expected: iterations ≈ 120-122, dropped=0, failed=0
Runtime: ~18s (nhanh, phù hợp smoke)

Nếu smoke pass -> sẵn sàng chạy full config.
Nếu smoke fail -> fix stack/script trước.
```

**Cleanup:**

```powershell
Remove-Item Env:RAR_01_START_RATE, Env:RAR_01_STAGE_1_DURATION, `
  Env:RAR_01_STAGE_1_TARGET, Env:RAR_01_STAGE_2_DURATION, `
  Env:RAR_01_STAGE_2_TARGET, Env:RAR_01_STAGE_3_DURATION, `
  Env:RAR_01_STAGE_3_TARGET, Env:RAR_01_PREALLOCATED_VUS, `
  Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

### 16.2. V2: Shrink VU pool — quan sát drops ở peak

**Mục đích:** Học cách đọc `dropped_iterations` và VU pressure.

**Thay đổi:** Giảm preAllocatedVUs và maxVUs để CỐ TÌNH gây drop ở peak.

```powershell
$env:RAR_01_PREALLOCATED_VUS = "4"
$env:RAR_01_MAX_VUS = "8"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

**Expected output:**

```text
Với preAllocatedVUs=4, maxVUs=8:

Nếu W_effective ≈ 150ms:
  VU cần ở peak = ceil(28 × 0.15) = 5 VU
  maxVUs=8 > 5 -> có thể không drop, nhưng sát

Nếu W_effective ≈ 300ms:
  VU cần ở peak = ceil(28 × 0.3) = 9 VU
  maxVUs=8 < 9 -> SẼ CÓ DROP!

Kỳ vọng thấy:
  - dropped_iterations > 0 (có thể 50-200)
  - VUs chạm maxVUs=8
  - iter/s tụt ở stage 2 (không đạt 28/s)
  - Dashboard VU chart: VUs = 8 phẳng ở stage 2
  - Dashboard execution timeline: iter/s bão hòa
```

**Học được gì:**

```text
1. Mối quan hệ VU pool size và dropped_iterations
2. Cách VU ceiling giới hạn max throughput
3. Cách đọc VU chart khi bão hòa
4. Phân biệt drop do VU thiếu vs drop do backend chậm
   (Nếu latency vẫn thấp mà drop -> VU thiếu.
    Nếu latency cao + drop -> có thể cả hai.)
```

**Cleanup:**

```powershell
Remove-Item Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

### 16.3. V3: Change stage durations — shorter ramp gây stress hơn

**Mục đích:** Hiểu tác động của ramp gradient đến hệ thống.

**Thay đổi:** Rút ngắn stage 2 từ 25s xuống 10s, giữ nguyên target 28/s.

```powershell
$env:RAR_01_STAGE_2_DURATION = "10s"
# stage 2: 15 -> 28/s trong 10s (thay vì 25s)
# gradient = (28-15)/10 = 1.3/s mỗi giây (gấp 2.6x)

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

**So sánh với original:**

| Khía cạnh | Original (25s) | V3 (10s) |
| --- | --- | --- |
| Stage 2 duration | 25s | 10s |
| Gradient rate | (28-15)/25 = 0.52/s^2 | (28-15)/10 = 1.3/s^2 |
| Stage 2 slots | 537.5 | 10×(15+28)/2 = 215 |
| Tổng slots | ~958 | ~635 |
| Ramp stress | Từ từ, dễ chịu | Nhanh, áp lực cao |
| VU spawn demand | Tăng 0.24 VU/s | Tăng 0.6 VU/s |
| Khả năng drop | Thấp (spawn kịp) | Cao hơn (spawn có thể không kịp) |

**Expected observation:**

```text
- Nếu backend yếu: latency spike rõ hơn ở V3 (rate tăng nhanh)
- Nếu VU pool yếu: transition drop ở đầu stage 2 (spawn không kịp)
- Timeline: ramp dốc hơn, dễ thấy "gãy" ở execution timeline
- Bài học: ramp gradient quan trọng không kém peak rate
```

**Cleanup:**

```powershell
Remove-Item Env:RAR_01_STAGE_2_DURATION -ErrorAction SilentlyContinue
```

### 16.4. V4: Higher peak rate — push đến 40/s

**Mục đích:** Tìm capacity limit thực sự của hệ thống.

**Thay đổi:** Tăng peak rate từ 28/s lên 40/s.

```powershell
$env:RAR_01_STAGE_2_TARGET = "40"
$env:RAR_01_STAGE_3_TARGET = "12"
$env:RAR_01_PREALLOCATED_VUS = "25"
$env:RAR_01_MAX_VUS = "60"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

**Expected analysis:**

```text
lambda_peak mới = 40/s

Tính expected slots:
  Stage 1: 15 × (5+15)/2 = 150 (không đổi)
  Stage 2: 25 × (15+40)/2 = 687.5
  Stage 3: 15 × (40+12)/2 = 390
  Total ≈ 1228 slots

VU sizing với W_effective:
  W=200ms -> ceil(40×0.2) = 8 VU (dễ)
  W=350ms -> ceil(40×0.35) = 14 VU (OK)
  W=500ms -> ceil(40×0.5) = 20 VU (vẫn trong preAllocated=25)
  W=800ms -> ceil(40×0.8) = 32 VU (vượt preAllocated, cần spawn)
  W=1000ms -> ceil(40×1.0) = 40 VU (cần spawn 15 từ maxVUs)

Kỳ vọng:
  - Nếu pass: hệ thống dư capacity, có thể chịu được peak cao hơn
  - Nếu fail (drop): tìm được giới hạn thực sự
  - Ghi nhận rate tại đó latency bắt đầu spike phi tuyến
    -> đây là "capacity limit" thực sự
```

**Học được gì:**

```text
1. Cách tìm capacity limit bằng cách tăng dần peak rate
2. Mối quan hệ phi tuyến giữa rate và latency
3. Điểm "knee" trong performance curve
4. Cách xác định headroom thực sự (gap giữa current peak và limit)
```

**Cleanup:**

```powershell
Remove-Item Env:RAR_01_STAGE_2_TARGET, Env:RAR_01_STAGE_3_TARGET, `
  Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

### 16.5. V5: Add external latency ở peak stage

**Mục đích:** Mô phỏng external dependency chậm trong giờ cao điểm.

**Thay đổi:** Thêm delay nhân tạo ở 30% product detail requests trong stage 2.

```powershell
# Script cần hỗ trợ env override cho external latency
$env:RAR_01_PEAK_EXTRA_LATENCY_MS = "500"
$env:RAR_01_PEAK_LATENCY_PROBABILITY = "0.3"
$env:RAR_01_PREALLOCATED_VUS = "25"
$env:RAR_01_MAX_VUS = "60"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-daily-ingress-curve.js"
```

**Logic trong script (hypothetical):**

```js
// Trong dailyIngressCurve():
const stage2StartTime = 15; // stage 2 bắt đầu ở t=15s
const stage2EndTime = 40;   // stage 2 kết thúc ở t=40s
const currentTime = (new Date() - testStartTime) / 1000;

if (currentTime >= stage2StartTime && currentTime < stage2EndTime) {
  // Đang ở stage 2 (peak)
  if (Math.random() < peakLatencyProbability) {
    sleep(peakExtraLatencyMs / 1000); // thêm latency nhân tạo
  }
}
```

**Expected observation:**

```text
Không có external latency:
  Stage 2: p50~80ms, p95~200ms, W≈150ms
  VU cần: ~6 VU

Có external latency (500ms, 30% events):
  Stage 2: p50~90ms, p95~550ms, W≈300ms
  VU cần: ceil(28 × 0.3) = 9 VU (tăng 50%)

Tác động:
  - Latency tail xuất hiện (p95 tăng)
  - VU demand tăng
  - Nếu VU pool không đủ -> drop
  - Mô phỏng chân thực: external dependency chậm giờ cao điểm
```

**Học được gì:**

```text
1. External dependency ảnh hưởng đến toàn bộ pipeline
2. W_effective tăng -> VU demand tăng -> risk of drop
3. Importance của circuit breaker / timeout ở external call
4. Cách test "what if external service chậm"
```

**Cleanup:**

```powershell
Remove-Item Env:RAR_01_PEAK_EXTRA_LATENCY_MS, Env:RAR_01_PEAK_LATENCY_PROBABILITY, `
  Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

### 16.6. Bảng tổng hợp 5 variations

| Var | Mục đích | Thay đổi chính | Điểm học | Thời gian ~ |
| --- | --- | --- | --- | --- |
| V1 | Smoke test | Giảm peak rate, rút ngắn duration | Verify script + stack | 20s |
| V2 | Quan sát drop | Shrink VU pool (pre=4, max=8) | Hiểu VU pressure | 60s |
| V3 | Ramp gradient stress | Rút ngắn stage 2 (25s -> 10s) | Hiểu ramp impact | 45s |
| V4 | Tìm capacity limit | Tăng peak rate (28 -> 40/s) | Tìm điểm bão hòa | 60s |
| V5 | External latency | Thêm delay ở peak stage | Impact của dependency | 60s |

---

## 17. Anti-patterns

### 17.1. AP1: "Không có drop -> pass, không cần đọc latency"

#### Vì sao sai?

```text
drop là tín hiệu hệ thống KHÔNG CHỊU ĐƯỢC rate.
Nhưng không-drop KHÔNG CÓ NGHĨA hệ thống khỏe.

Ví dụ:
  - Zero drop, nhưng p95 = 2s: user phải đợi 2 giây
    -> trải nghiệm kém, có thể user bỏ đi
  - Zero drop, nhưng VU = maxVUs: không còn buffer
    -> một spike nhỏ sẽ gây drop
  - Zero drop, nhưng p50 tăng gấp 3 so với baseline
    -> hệ thống đang ở ngưỡng, sắp quá tải

Cách đúng:
  1. Check dropped_iterations = 0 -> đạt ingress contract
  2. Check latency (p50/p95/p99) -> có trong SLO không?
  3. Check VU headroom -> còn buffer không?
  4. Check latency TREND (tăng dần?) -> sắp quá tải không?
  5. Chỉ kết luận pass khi CẢ BA đều OK
```

### 17.2. AP2: "Tăng maxVUs lên thật cao cho an toàn"

#### Vì sao sai?

```text
maxVUs = 1000 không có nghĩa là an toàn hơn maxVUs = 40.

Vấn đề:
  1. Mỗi VU tiêu thụ memory (vài MB đến vài chục MB)
     -> 1000 VU = vài GB RAM -> OOM
  2. Mỗi VU mở connection đến backend
     -> 1000 VU = 1000 concurrent connections
     -> Backend có thể bị overwhelm bởi chính connection count
  3. k6 generator (máy chạy test) có giới hạn
     -> 1000 VU trên 1 máy có thể không khả thi
  4. Test không phản ánh production (production không có 1000 VU pool)

Cách đúng:
  - Size VU dựa trên lambda_peak × W_effective + buffer (20-50%)
  - Nếu W_effective = 200ms, lambda_peak = 28/s:
    preAllocatedVUs = ceil(28 × 0.2 × 1.3) = 8
    maxVUs = preAllocatedVUs × 2.5 = 20
  - Nếu test fail vì VU thiếu: ĐÓ LÀ TÍN HIỆU ĐÚNG
    -> W_effective thực tế cao hơn dự kiến
    -> Cần điều tra vì sao, không chỉ tăng VU
```

### 17.3. AP3: "Dùng average rate để tính VU"

#### Đã phân tích kỹ ở NL1. Tóm tắt:

```text
SAI: preAllocatedVUs = ceil(average_rate × W) = ceil(17.4 × W)
ĐÚNG: preAllocatedVUs = ceil(lambda_peak × W) = ceil(28 × W)

Tỉ lệ sai/đúng = 17.4/28 = 0.62 -> thiếu 38% VU ở peak.
```

### 17.4. AP4: "Stage target là rate Ở ĐẦU stage"

#### Vì sao sai?

```text
Stage target là rate Ở CUỐI stage, không phải ở đầu.

Config:
  stages: [{duration: "15s", target: 15}]

Hiểu SAI: "15s đầu tiên, rate = 15/s"
Hiểu ĐÚNG: "rate tăng từ 5/s lên 15/s trong 15s,
            target=15 là rate ở cuối stage"

Nếu hiểu sai, sẽ:
  - Tính sai scheduled slots (15×15=225 thay vì 15×10=150)
  - Đọc sai dashboard timeline (tưởng iter/s phải = 15 ngay từ t=0)
  - Sizing sai (tưởng cần VU cho rate=15 ngay từ đầu)
```

### 17.5. AP5: "So sánh iterations/s trong summary với lambda_peak"

#### Vì sao sai?

```text
Summary in:
  iterations.....: 956   17.38/s

17.38/s là AVERAGE rate trên TOÀN BỘ runtime (55s).
lambda_peak = 28/s là MAX rate ở cuối stage 2.

Không thể so sánh 17.38/s với 28/s và nói "thiếu 10.62/s".
Phải đọc dashboard timeline để thấy rate theo thời gian.

Tương tự: không thể nói "peak đạt 28/s" chỉ vì summary in 17.38/s.
Phải xem bucket ở t=39-40s trên execution timeline.
```

### 17.6. AP6: "Chỉ cần test peak rate, bỏ qua ramp-up và ramp-down"

#### Vì sao sai?

```text
Nếu chỉ test 28/s constant (bằng constant-arrival-rate):
  - Bỏ qua stage transition behavior
  - Bỏ qua cold start ở ramp-up
  - Bỏ qua recovery ở ramp-down
  - Bỏ qua in-flight iteration overlap giữa các stage

Production daily curve CÓ ramp-up và ramp-down.
Hệ thống có thể:
  - Pass 28/s constant NHƯNG fail ramp-up (cold cache, connection pool init)
  - Pass 28/s constant NHƯNG fail transition (spawn delay)
  - Pass 28/s constant NHƯNG latency không giảm ở ramp-down (memory leak)

-> Phải test TOÀN BỘ curve, không chỉ peak.
```

### 17.7. AP7: "preAllocatedVUs càng cao càng tốt"

#### Vì sao sai?

```text
preAllocatedVUs cao:
  PROS:
    - Sẵn sàng nhận slot ngay, không spawn delay
    - Tránh drop ở ramp-up
  CONS:
    - Tốn memory (mỗi VU ~vài MB)
    - Tốn thời gian khởi tạo ban đầu (initialization phase dài hơn)
    - Tốn connection (mỗi VU có thể giữ connection pool riêng)
    - Che giấu vấn đề: nếu W_effective lớn, đáng lẽ phải thấy drop
      để biết backend có vấn đề, nhưng preAllocatedVUs cao che mất

Nguyên tắc:
  preAllocatedVUs = vừa đủ cho expected VU_demand + buffer 20-30%
  Không nên = maxVUs (mất khả năng spawn linh hoạt)
  Không nên quá cao (lãng phí + che vấn đề)
```

---

## 18. Reference

### 18.1. Docs liên quan trong project

| Doc | Nội dung |
| --- | --- |
| `docs/20260518_01_ramping-arrival-rate-quick-index.md` | Quick index: tổng quan executor |
| `docs/20260518_02_ramping-arrival-rate-tham-so-cong-thuc.md` | Tham số, công thức, demo stage curve |
| `docs/20260518_03_ramping-arrival-rate-worked-example.md` | Worked example sleep(0.4) |
| `docs/20260520_00_k6-metrics-types-builtins-core-guide.md` | k6 metrics types & built-ins |
| `docs/20260520_01_k6-vu-lifecycle-open-closed-model.md` | VU lifecycle, open vs closed model |
| `docs/20260517_01_constant-arrival-rate-quick-index.md` | So sánh với constant-arrival-rate |
| `docs/20260517_01_ramping-vus-quick-index.md` | So sánh với ramping-vus |
| `docs/practice/constant-arrival-rate/00_overview.md` | Pattern tham khảo cho series practice |
| `docs/practice/ramping-arrival-rate/RUN_GUIDE.md` | Run guide chung cho series (sẽ tạo) |

### 18.2. Backend script reference (hypothetical)

```text
Source pack:
  E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\

Files:
  common.js                              — Shared helpers: buildRampingArrivalScenario, requestJson, finishEvent
  rar-01-daily-ingress-curve.js          — Case 01 script
  case-catalog.json                      — Catalog all cases
  README.md                              — Pack overview
```

### 18.3. Công thức cần nhớ (cheat sheet)

```text
SCHEDULED SLOTS (1 stage):
  slots = duration × (rate_start + rate_end) / 2

SCHEDULED SLOTS (n stages):
  total = sum_i( duration_i × (rate_start_i + rate_end_i) / 2 )

RATE TẠI THỜI ĐIỂM t TRONG STAGE:
  rate(t) = rate_prev_target + (stage.target - rate_prev_target) × t / stage.duration

LAMBDA PEAK:
  lambda_peak = max(startRate, stage[0].target, stage[1].target, ...) / timeUnit_seconds

AVERAGE TARGET RATE:
  average_target_rate = total_scheduled_slots / total_regular_duration

VU SIZING (Little's Law):
  required_vus_min = ceil(lambda_peak × W_effective)

W_EFFECTIVE:
  W_effective ≈ iteration_duration (nếu không có minIterationDuration)
  W_effective ≈ max(iteration_duration, minIterationDuration) (nếu có)

CAPACITY VỚI M VUs:
  capacity = M / W_effective  (iterations/s)

COMPLETED ITERATIONS:
  iterations ≈ scheduled_slots - dropped_iterations - interrupted_iterations

PASS/FAIL GATE:
  PASS:  dropped_iterations = 0 (hoặc < 1%)
         AND events_failed = 0
         AND p95 latency < SLO
         AND VUs < maxVUs (còn headroom)
```

### 18.4. Tỉ lệ và con số quan trọng cho case này

| Đại lượng | Giá trị | Dùng để |
| --- | --- | --- |
| `lambda_peak` | 28/s | VU sizing |
| `average_target_rate` | 17.4/s | Ước tính tổng slots |
| `peak/average ratio` | 1.61x | Nhấn mạnh vì sao không dùng average |
| `total_scheduled_slots` | ~958 | So với iterations output |
| `preAllocatedVUs` | 15 | Benchmark VU pool |
| `maxVUs` | 40 | Trần capacity |
| `max/pre ratio` | 2.67x | Buffer headroom |
| `total_duration` | 55s | Timeline length |
| `stage_2_slots/total` | 537.5/958 = 56% | Stage 2 chiếm hơn nửa traffic |

### 18.5. Thứ tự đề xuất học tập

```text
1. Đọc file này (Case 01: Daily Ingress Curve)
2. Hiểu stage math (Section 1.5)
3. Hiểu 5 RC (Section 4)
4. Chạy smoke (V1) để verify stack
5. Chạy full config, đọc output theo 5 bước (Section 11)
6. Phân tích dashboard 3 charts (Section 12)
7. Đối chiếu với 4 scenarios (Section 13)
8. Chạy V2 (shrink VU) để thấy dropped_iterations
9. Chạy V4 (tăng peak) để tìm capacity limit
10. Đọc 4 nghịch lý (Section 14) để tránh hiểu sai
11. Check anti-patterns (Section 17) trước khi tự thay đổi config
12. Đọc tiếp Case 02 khi đã thành thạo Case 01
```

---

> **Key takeaway:** `ramping-arrival-rate` dùng stage curve để mô phỏng arrival pattern biến thiên. `lambda_peak` (28/s) quyết định VU sizing, không phải `average_target_rate` (17.4/s). `preAllocatedVUs` là worker capacity, không phải user count. `dropped_iterations` là pass/fail gate chính — mỗi drop là một business event bị mất. Dashboard execution timeline phải có hình daily curve: sáng tăng, trưa peak, chiều giảm. Mọi kết luận phải dựa trên cả 3 yếu tố: throughput (drop), latency (p95), và VU headroom.

---

*Case 01 of ramping-arrival-rate practice series. Last updated: 2026-06-21.*
