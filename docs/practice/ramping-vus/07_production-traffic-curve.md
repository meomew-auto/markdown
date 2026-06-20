# Case 07: Production traffic curve

## Tình huống thực tế

Sau khi hiểu từng service riêng, platform cần một mixed production-shaped curve để xem toàn hệ thống phản ứng theo traffic curve.

Flow trộn browse, cart, auth, checkout, report. Đây là capstone case cho staged concurrency.

Case này trả lời: mixed services có chịu được 2 -> 12 -> 30 -> 8 -> 2 VUs không, và service nào kéo baseline ở peak?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 2 -> 12 -> 30 -> 8 -> 2
Scenario: production_traffic_curve
Exec function: productionTrafficCurve
Team/service focus: platform/performance/mixed services
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 2 -> 12 -> 30 -> 8 -> 2,
latency/failures/iter-s/RPS phản ứng như thế nào?
Và service nào kéo toàn bộ pool ở từng stage?
```

### Vị trí của case này trong bộ 7 case ramping-vus

Case 07 là case **cuối cùng và tổng hợp nhất** trong series ramping-vus. Nó không dạy một service riêng lẻ như các case trước, mà dạy cách đọc một mixed production curve — nơi 5 service cùng chia sẻ một pool VUs thay đổi theo stages, mỗi service có latency profile và weight khác nhau.

Bảng so sánh vị trí:

| Case | Focus | Số service | Stage shape | Độ phức tạp phân tích |
| --- | --- | --- | --- | --- |
| 01 daily traffic | products/cart/order flow cơ bản | 3 | 2->8->24->12->2 | Trung bình |
| 02 campaign spike | products/cart spike | 2 | 1->6->36->8->1 | Trung bình |
| 03 login wave | auth keepalive wave | 1 | 1->12->28->5 | Thấp |
| 04 checkout ramp | cart/order ramp | 2 | 1->8->18->1 | Trung bình |
| 05 reporting ramp | report heavy endpoints | 1 | 1->5->14->1 | Trung bình |
| 06 cart recovery wave | cart recovery spike | 1 | 1->22->8->1 | Thấp |
| **07 production curve** | **mixed 5-service weighted staged** | **5** | **2->12->30->8->2** | **Cao nhất** |

Case 07 là nơi learner học kỹ năng quan trọng nhất của ramping-vus: **đọc một test có nhiều service với weight khác nhau, qua nhiều stage concurrency, không bị aggregate metrics đánh lừa, và phát hiện service nào kéo pool ở stage nào**.

Đây không phải là một case riêng lẻ — nó là **bài tổng hợp** sau khi đã học case 01-06. Mọi root cause từ case 01-06 đều có thể xuất hiện trong case này, cộng thêm root cause riêng của mixed staged load.

## Yêu cầu cứng của case này

Case này có 2 yêu cầu cứng cốt lõi, khác biệt với các case ramping-vus khác:

### Core requirement 1: MIXED STAGED CONCURRENCY

```text
Không phải 1 service chạy qua 5 stages.
Mà là 5 service CÙNG CHẠY qua 5 stages, mỗi service có weight riêng.

Stage 1 (morning, 2->12 VUs):
  - 2-12 VUs cùng lúc, mỗi VU chọn 1 operation theo weight
  - products 50%, cart 20%, auth 15%, checkout 10%, report 5%

Stage 2 (ramp to peak, 12->30 VUs):
  - 12-30 VUs cùng lúc, weight không đổi
  - Hệ thống phải scale từ 12 lên 30 concurrent mixed users

Stage 3 (peak, 30 VUs):
  - 30 VUs cùng lúc, áp lực cao nhất
  - Đây là nơi mixed bottleneck lộ rõ nhất

Stage 4 (afternoon, 30->8 VUs):
  - Giảm từ 30 xuống 8 VUs
  - Hệ thống có recover không? Latency có về baseline không?

Stage 5 (cooldown, 8->2 VUs):
  - Về mức thấp nhất
  - In-flight iterations có finish trong gracefulRampDown không?
```

### Core requirement 2: SERVICE-SPECIFIC VISIBILITY PER STAGE

```text
KHÔNG ĐƯỢC chỉ nhìn aggregate metrics.
PHẢI breakdown theo operation/service Ở TỪNG STAGE.

Câu hỏi cho mỗi stage:
  - products-service: p95 latency ở stage này là bao nhiêu?
  - cart-service: có bị ảnh hưởng khi checkout chậm không?
  - auth-service: có bị degrade ở peak không?
  - order-service (checkout): external call có timeout ở peak không?
  - report-service: aggregation query có chậm hơn khi nhiều VUs không?

Câu hỏi cross-stage:
  - Stage 2 -> stage 3: latency tăng bao nhiêu khi VUs tăng 12->30?
  - Stage 3 -> stage 4: latency có giảm về mức stage 2 không? (recovery)
  - Stage nào là bottleneck stage cho từng service?
```

Các yêu cầu chung khác:

- Mixed branch ratio phải đọc bằng operation/service tags.
- Thresholds relaxed hơn vì production mix rộng hơn.
- Aggregate p95 phải được breakdown theo service.
- Case này tổng hợp các root causes từ cases 01-06.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

## Vì sao "Production traffic curve" nên dùng `ramping-vus`?

Production traffic curve cần active user pool thay đổi theo timeline với nhiều service. `ramping-vus` đúng vì input là VU curve, còn service-specific RPS/latency là output.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

### Tại sao production traffic curve cần ramping-vus hơn bất kỳ case nào khác?

Case 07 khác biệt ở chỗ nó có **5 service với latency profile khác nhau, chạy qua 5 stage concurrency khác nhau**. Nếu dùng constant-vus:

```text
constant-vus với 30 VUs phẳng:
  - Chỉ đo được behavior ở 1 mức concurrency (30)
  - KHÔNG thấy được điều gì xảy ra khi VUs tăng từ 2 lên 30
  - KHÔNG thấy được stage 2 (12 VUs) có khác gì stage 3 (30 VUs)
  - KHÔNG thấy được recovery behavior khi ramp-down
  - Phù hợp cho baseline, không phải production curve test
```

Nếu dùng constant-arrival-rate:

```text
constant-arrival-rate với target RPS cố định:
  - Luôn bơm đúng X request/s, bất kể backend chậm hay nhanh
  - Nếu checkout service chậm ở peak, k6 vẫn bơm đủ rate → queue
  - KHÔNG thấy được "khi checkout chậm, VUs bị giữ → pool capacity giảm"
  - Đây là open model logic, không giống production thật với active users
```

Ramping-vus cho production traffic curve vì:

```text
1. Staged VUs = production traffic pattern thật
   - Morning ramp (2->12), peak (30), afternoon decline (30->8), cooldown (8->2)
   - Mỗi stage là một observation window với concurrency khác nhau

2. Closed model = active user behavior thật
   - User không "bơm request theo rate" — user active, làm việc, rồi nghĩ
   - Nếu backend chậm, user bị giữ lâu hơn → tự nhiên ít loop hơn

3. Weighted mix qua stages = traffic mix thật
   - Ở mọi stage, user vẫn chọn operation theo weight
   - Nhưng ở peak (30 VUs), áp lực lên từng service khác với morning (12 VUs)

4. Cross-stage comparison = insight về scalability
   - Stage 2 (12 VUs) vs stage 3 (30 VUs): latency scaling thế nào?
   - Stage 3 (30 VUs) vs stage 4 (8 VUs): recovery thế nào?
   - Service nào scale kém nhất?

5. KHÔNG có target RPS cho toàn test
   - iter/s ở mỗi stage là output tự nhiên
   - So sánh iter/s giữa các stage để thấy backpressure
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. |

Kết luận cho case này:

```text
Need staged active users over time -> ramping-vus.
Need flat active users -> constant-vus, not this case.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed/timed arrivals -> arrival-rate family, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_07_START_VUS = 2
RV_07_MID_VUS = 12
RV_07_PEAK_VUS = 30
RV_07_LATE_VUS = 8
RV_07_DURATION_SCALE = 0.25
RV_07_SLEEP_SECONDS = 0.5
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_07_START_VUS | 2 | Low-traffic starting point, mô phỏng sáng sớm |
| RV_07_MID_VUS | 12 | Morning/mid traffic trước peak |
| RV_07_PEAK_VUS | 30 | Peak business hours |
| RV_07_LATE_VUS | 8 | Afternoon/evening decline |
| RV_07_DURATION_SCALE | 0.25 | Co ngắn timeline để test nhanh hơn |
| RV_07_SLEEP_SECONDS | 0.5 | Think time giữa các mixed operation |
| gracefulRampDown | 20s | Grace time cho in-flight iterations khi ramp-down |

Weighted mix expected:

| Branch | Weight | Service |
| --- | --- | --- |
| browse (products) | 50% | products-service |
| cart | 20% | cart-service |
| auth | 15% | auth-service |
| checkout | 10% | order-service |
| report | 5% | report-service |

### Tại sao weight được chọn như vậy?

Weight mô phỏng một production e-commerce điển hình qua một ngày:

```text
Browse/products (50%):
  - Đây là phần lớn traffic của một storefront
  - User duyệt sản phẩm nhiều hơn là mua
  - products-service nhận ~50% request volume
  - Đây là "background noise" — volume cao, latency thấp

Cart (20%):
  - Không phải user nào cũng thêm vào cart
  - Nhưng đủ để tạo write traffic ổn định
  - cart-service là write-heavy, latency trung bình

Auth (15%):
  - User cần auth/session check định kỳ
  - auth-service thường nhanh (session cache)
  - Nhưng nếu auth chậm → ảnh hưởng mọi operation khác

Checkout (10%):
  - Tỉ lệ chuyển đổi ~10% là thực tế
  - Nhưng checkout thường là operation chậm nhất (external payment, inventory)
  - 10% weight nhưng có thể chiếm 30-40% contribution vào p95

Report (5%):
  - Một số ít user xem report/summary
  - Report query thường nặng (aggregation, JOIN)
  - 5% weight nhưng latency contribution có thể cao ngang checkout
```

Điểm mấu chốt: **weight quyết định COUNT, không quyết định LATENCY contribution**. Một branch 5% weight có latency 2000ms sẽ kéo p95 mạnh hơn branch 50% weight có latency 100ms. Điều này càng rõ trong staged model vì ở mỗi stage, số lượng sample khác nhau.

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 12 | morning/mid traffic |
| 2 | 90s | 23s | 30 | ramp to peak |
| 3 | 150s | 38s | 30 | sustained peak |
| 4 | 90s | 23s | 8 | late traffic |
| 5 | 45s | 11s | 2 | cooldown |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Expected behavior per stage

```text
Stage 1 — Morning ramp (2 -> 12 VUs):
  - VUs tăng từ 2 lên 12
  - iter/s tăng dần theo VUs
  - Latency thấp vì load nhẹ
  - Operation mix bắt đầu hình thành

Stage 2 — Ramp to peak (12 -> 30 VUs):
  - VUs tăng từ 12 lên 30
  - Đây là giai đoạn quan trọng: iter/s có tăng tuyến tính không?
  - Nếu iter/s flatten khi VUs > 20 → saturation bắt đầu
  - Service nào bắt đầu chậm ở giai đoạn này?

Stage 3 — Sustained peak (30 VUs):
  - 30 VUs phẳng, áp lực cao nhất
  - Đây là nơi mixed bottleneck lộ rõ nhất
  - Nếu checkout/report chậm → kéo toàn bộ pool
  - iter/s ở stage này là throughput tối đa với 30 VUs

Stage 4 — Afternoon decline (30 -> 8 VUs):
  - VUs giảm mạnh từ 30 xuống 8
  - Hệ thống có recover không?
  - Latency có về mức stage 1-2 không?
  - In-flight iterations có finish trong gracefulRampDown không?

Stage 5 — Cooldown (8 -> 2 VUs):
  - Về mức thấp nhất
  - Tail iterations có thể xuất hiện (gracefulRampDown)
  - KHÔNG đọc tail iterations như "test chạy quá lâu"
```

## Technical semantics: staged active pool, closed model, graceful ramp-down

Trong ramping-vus:

```text
startVUs = active users at scenario start
stages[].target = absolute active user target at stage end
stages[].duration = time to move from previous target to new target
gracefulRampDown = grace when VUs are stopped during ramp-down
```

Không có fixed target cho:

```text
iterations
http_reqs
RPS
iter/s
```

Nếu VUs tăng nhưng iter/s không tăng:

```text
ramping_flow_duration_ms có thể đã tăng
backend/service có thể đã saturated
```

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:

```text
gracefulRampDown có thể đang cho in-flight loops finish
```

### Identity model cho production traffic curve: mỗi VU là một mixed user

Trong case 07, identity model phức tạp hơn các case single-service:

```text
VU 1 = mixed user 1
  Stage 1 (morning, 2-12 VUs):
    Loop 1: user 1 -> browse/products (50% chance)
    Loop 2: user 1 -> cart (20% chance)
    Loop 3: user 1 -> auth (15% chance)
    Loop 4: user 1 -> browse/products (50% chance)
    ...
  Stage 3 (peak, 30 VUs):
    Loop N: user 1 -> checkout (10% chance) → bị giữ 2000ms
    Loop N+1: user 1 -> browse/products (50% chance)
    ...

VU 2 = mixed user 2
  Tương tự, mỗi loop chọn operation theo weight

Mỗi VU = một user identity ổn định XUYÊN SUỐT CÁC STAGE
Nhưng mỗi loop của user đó = một operation NGẪU NHIÊN theo weight
```

Điều này khác với case 01 daily traffic curve (mỗi loop = 1 flow cố định: list -> detail -> cart -> checkout). Ở đây, mỗi loop CHỈ làm 1 operation, và operation được chọn theo weighted random.

Lý do thiết kế này:

```text
1. Mô phỏng user thật: user không làm tất cả mọi thứ mỗi lần
   - Lần này duyệt sản phẩm, lần sau thêm cart, lần khác checkout

2. Tạo weighted mix tự nhiên qua nhiều loop và nhiều stage:
   - Sau stage 3 (peak, 38s, 30 VUs): ~1500 loops → phân phối gần đúng weight
   - Tổng cả test 5 stage: ~4000+ loops → hội tụ tốt

3. Mỗi operation đo latency ĐỘC LẬP:
   - Checkout latency không bị "pha loãng" bởi products latency trong cùng loop
   - Dễ breakdown theo operation tag ở từng stage

4. Cross-stage identity:
   - VU 1 ở stage 2 (12 VUs) và VU 1 ở stage 3 (30 VUs) là cùng một "user"
   - Nhưng latency nó trải qua khác nhau vì tổng pool khác nhau
   - Đây là closed-model behavior: pool đông hơn → mỗi user có thể bị ảnh hưởng
```

### Weighted random selection: cơ chế

Code pattern cho weighted random:

```js
function weightedRandom(choices) {
  const totalWeight = choices.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * totalWeight;
  for (const choice of choices) {
    r -= choice.weight;
    if (r <= 0) return choice;
  }
  return choices[choices.length - 1]; // fallback
}

const OPERATIONS = [
  { name: "production_curve_browse",   weight: 50, fn: browseProducts },
  { name: "production_curve_cart_add", weight: 20, fn: cartAdd },
  { name: "production_curve_auth_me",  weight: 15, fn: authMe },
  { name: "production_curve_checkout", weight: 10, fn: checkout },
  { name: "production_curve_report",   weight: 5,  fn: report },
];

export default function () {
  const op = weightedRandom(OPERATIONS);
  op.fn();  // Gọi operation được chọn
  sleep(0.5);
}
```

Sau toàn bộ 5 stage với peak 30 VUs:

```text
total loops ≈ 4000+ (tùy backend latency)
browse:   ~2000 (50%)
cart:     ~800  (20%)
auth:     ~600  (15%)
checkout: ~400  (10%)
report:   ~200  (5%)
```

## Technical root causes this case catches

Case này có 5 root causes — nhiều nhất trong toàn bộ series ramping-vus. Mỗi root cause là một lớp insight về mixed staged closed-model testing.

### Nguyên nhân kỹ thuật 1: Mixed traffic hides service bottlenecks

Aggregate metrics không đủ; phải lọc service/operation. Trong staged model, điều này còn nguy hiểm hơn vì bottleneck có thể chỉ xuất hiện ở một stage.

**Phân tích sâu**:

```text
Trên dashboard, nếu chỉ nhìn aggregate:
  Stage 2 (12 VUs): aggregate p95 = 200ms → "ổn"
  Stage 3 (30 VUs): aggregate p95 = 450ms → "hơi chậm, không nghiêm trọng"

Nhưng breakdown theo operation:
  Stage 2 (12 VUs):
    browse:   p95=150ms
    cart:     p95=200ms
    auth:     p95=100ms
    checkout: p95=1800ms  ← đã chậm nhưng bị 50% browse sample che
    report:   p95=900ms

  Stage 3 (30 VUs):
    browse:   p95=180ms  ← vẫn ổn
    cart:     p95=250ms  ← vẫn ổn
    auth:     p95=120ms  ← vẫn ổn
    checkout: p95=5000ms ← TĂNG 2.8× so với stage 2!
    report:   p95=2000ms ← TĂNG 2.2× so với stage 2!

  AGGREGATE P95 CHE HOÀN TOÀN CHECKOUT BOTTLENECK Ở STAGE 3.
  Nhìn aggregate: 200ms -> 450ms (tăng 2.25×, có vẻ chấp nhận được)
  Nhìn checkout: 1800ms -> 5000ms (tăng 2.8×, NGHIÊM TRỌNG!)

  → LUÔN LUÔN breakdown theo operation. LUÔN LUÔN so sánh giữa các stage.
```

Hành động khi đọc:

```text
1. Xem aggregate p95 ở từng stage → cảm nhận ban đầu
2. Filter theo operation ở TỪNG STAGE → tìm operation chậm
3. So sánh cùng operation giữa stage 2 và stage 3 → scaling behavior
4. Nếu một operation p95 tăng đột biến ở stage 3 → đó là bottleneck
5. Route vấn đề về đúng service owner
```

### Nguyên nhân kỹ thuật 2: Browse dominates volume

Browse 50 weight thường chiếm count nhiều nhất, ảnh hưởng average/RPS. Trong staged model, điều này có nghĩa là browse "pha loãng" các tín hiệu từ operation khác.

**Phân tích sâu — vì sao browse dominance nguy hiểm trong staged model**:

```text
Stage 3 (peak, 30 VUs, 38s):
  Tổng sample: ~1500 requests
  browse: ~750 requests (50%)
  cart:   ~300 requests (20%)
  auth:   ~225 requests (15%)
  checkout: ~150 requests (10%)
  report: ~75 requests (5%)

Aggregate p95 của 1500 sample:
  - 95% sample nhanh nhất ≤ X
  - 5% sample chậm nhất > X
  - 5% của 1500 = 75 sample
  - checkout (10%) = 150 sample → ít nhất 75 checkout sample nằm TRONG p95
  - Nếu checkout p95 = 5000ms → aggregate p95 chắc chắn bị kéo lên

Nhưng vấn đề là:
  - 750 browse sample (50%) kÉO aggregate p95 XUỐNG
  - 150 checkout sample (10%) kÉO aggregate p95 LÊN
  - Kết quả: aggregate p95 nằm đâu đó ở giữa (~450ms)
  - Con số 450ms này KHÔNG đại diện cho browse (p95=180ms)
  - CŨNG KHÔNG đại diện cho checkout (p95=5000ms)
  - Nó là CON SỐ VÔ NGHĨA nếu không breakdown

Tệ hơn nữa: browse volume còn thay đổi theo stage:
  Stage 1 (2-12 VUs): ít sample → weight chưa hội tụ
  Stage 2 (12-30 VUs): sample tăng dần
  Stage 3 (30 VUs): sample lớn nhất → weight hội tụ tốt nhất
  Stage 4 (30-8 VUs): sample giảm dần
  Stage 5 (8-2 VUs): ít sample → weight dao động

→ Aggregate p95 ở mỗi stage có Ý NGHĨA KHÁC NHAU vì sample size khác nhau.
→ Càng có lý do phải breakdown theo operation ở từng stage.
```

Hành động:

```text
1. Đừng dùng aggregate p95 để kết luận "hệ thống chậm"
2. LUÔN breakdown: browse p95 riêng, checkout p95 riêng, report p95 riêng
3. So sánh từng operation p95 giữa các stage
4. Browse p95 thấp + checkout p95 cao = vấn đề ở order-service, không phải products-service
```

### Nguyên nhân kỹ thuật 3: Checkout/report can dominate tail

Dù weight nhỏ, checkout/report có external/report cost nên kéo p95/p99. Trong staged model, effect này trầm trọng hơn ở peak stage.

**Phân tích sâu — vì sao branch nhỏ lại kéo latency toàn test ở peak**:

```text
Checkout thường chậm vì:
  - External payment gateway (network hop + processing)
  - Inventory check/reservation (DB lock, row contention)
  - Order creation (multi-table insert transaction)
  - Email/notification trigger (async nhưng vẫn blocking trong test)

Report thường chậm vì:
  - Aggregation query (SUM, GROUP BY trên bảng lớn)
  - JOIN nhiều bảng (orders + items + products)
  - Không có cache (mỗi user có report khác nhau)
  - Time-range scan (quét nhiều row)

Ở stage 3 (peak, 30 VUs):
  - 30 VUs cùng chạy → 30 concurrent requests có thể
  - Nếu 3 VUs cùng hit checkout (10% × 30 = 3 expected):
    3 checkout concurrent → external payment gateway bị 3 connection
    → DB lock contention tăng (cùng inventory row)
    → Checkout latency tăng từ 2000ms lên 5000ms

  - Nếu 1-2 VUs hit report (5% × 30 = 1.5 expected):
    Report aggregation query chạy khi DB đang bận với checkout
    → Report latency tăng từ 800ms lên 2000ms

  - 3 VUs bị checkout giữ 5000ms + 1.5 VUs bị report giữ 2000ms
    = 4.5 VUs "mất tích" khỏi pool 30 VUs
    = effective pool còn 25.5 VUs
    → iter/s giảm ~15%
```

Demo đóng góp latency theo weight và latency ở stage 3:

```text
Giả sử latency mỗi operation ở stage 3 (peak):
  production_curve_browse:   avg=120ms, p95=200ms  (weight 50%)
  production_curve_cart_add: avg=180ms, p95=300ms  (weight 20%)
  production_curve_auth_me:  avg=80ms,  p95=150ms  (weight 15%)
  production_curve_checkout: avg=2000ms, p95=5000ms (weight 10%)
  production_curve_report:   avg=1000ms, p95=2500ms (weight 5%)

Aggregate avg (weighted):
  = 0.50×120 + 0.20×180 + 0.15×80 + 0.10×2000 + 0.05×1000
  = 60 + 36 + 12 + 200 + 50
  = 358ms

Checkout contribution: 0.10 × 2000 = 200ms → 200/358 = 56% avg latency!
Report contribution:   0.05 × 1000 = 50ms  → 50/358  = 14% avg latency!
Browse contribution:   0.50 × 120  = 60ms  → 60/358  = 17% avg latency!

CHECKOUT 10% WEIGHT → 56% LATENCY CONTRIBUTION!
BROWSE 50% WEIGHT   → 17% LATENCY CONTRIBUTION!
```

Kết luận:

```text
Dù checkout chỉ 10% weight, latency 2000ms của nó:
  - Kéo aggregate p95 lên (có thể từ ~200ms lên ~800ms+)
  - Kéo aggregate max lên 5000ms+
  - Kéo LOOP DURATION của mọi VU hit checkout
  - Ở stage 3 (30 VUs), concurrent checkout làm mọi thứ tệ hơn

Hành động:
  1. Đừng nhìn aggregate p95 rồi kết luận "hệ thống chậm"
  2. Breakdown: browse p95=200ms (OK), checkout p95=5000ms (cần điều tra)
  3. Route vấn đề về đúng service owner: order-service
  4. So sánh checkout p95 giữa stage 2 (12 VUs) và stage 3 (30 VUs)
  5. Nếu checkout p95 tăng mạnh ở stage 3 → concurrent checkout issue
```

### Nguyên nhân kỹ thuật 4: Relaxed thresholds reflect broader curve

98%/2% thresholds phù hợp mixed production curve hơn strict service isolated case. Trong staged model, không phải stage nào cũng có thể đáp ứng strict latency target.

**Phân tích sâu — vì sao threshold phải relaxed cho case này**:

```text
Case 01 (daily traffic, 3 service, peak 24 VUs):
  Threshold: checks>0.99, http_req_failed<0.01

Case 07 (production curve, 5 service, peak 30 VUs):
  Threshold: checks>0.98, http_req_failed<0.02

Tại sao relaxed hơn?
  1. 5 service thay vì 3 → nhiều điểm fail hơn
  2. Peak 30 VUs thay vì 24 → áp lực cao hơn
  3. Mixed weighted flow → checkout/report tự nhiên chậm hơn
  4. 5 stage shape → mỗi stage có latency profile khác nhau
  5. KHÔNG thể đòi hỏi stage 3 (30 VUs) có latency bằng stage 1 (2-12 VUs)

Nếu dùng threshold quá chặt:
  - http_req_failed<0.01: có thể fail vì checkout external thỉnh thoảng timeout
  - Đây là EXPECTED behavior với external dependency
  - Fail threshold không có ý nghĩa — nó không phản ánh vấn đề thật

Relaxed threshold không có nghĩa là "dễ dãi":
  - checks>0.98: vẫn đòi hỏi 98% request pass contract
  - http_req_failed<0.02: vẫn đòi hỏi 98% request không fail
  - ramping_active_iterations_failed<50: cho phép một số loop fail (mixed flow phức tạp)
  - Nhưng đủ chặt để bắt vấn đề nghiêm trọng (>2% fail là có vấn đề)
```

### Nguyên nhân kỹ thuật 5: Synthesis after cases 01-06

Case này dùng để so kết quả tổng hợp sau khi đã hiểu từng service/ramp riêng. Đây là bài kiểm tra cuối cùng: learner có tổng hợp được tất cả insight từ 6 case trước không?

**Phân tích sâu — case 07 là bài tổng hợp của những gì**:

```text
Từ case 01 (daily traffic curve):
  → Cách đọc staged VU shape
  → Cách đọc iter/s thay đổi theo stage
  → Cách phát hiện saturation khi VUs tăng nhưng iter/s flatten

Từ case 02 (campaign launch spike):
  → Cách đọc spike behavior (VUs tăng đột ngột)
  → Cách đọc recovery sau spike
  → Cách phân biệt spike degradation với sustained degradation

Từ case 03 (login wave):
  → Cách đọc auth service dưới ramp
  → Auth chậm ảnh hưởng toàn bộ flow thế nào

Từ case 04 (checkout ramp):
  → Cách đọc checkout/external dependency dưới ramp
  → Checkout kéo tail latency thế nào
  → External timeout pattern

Từ case 05 (reporting ramp):
  → Cách đọc report/aggregation query dưới ramp
  → Report chậm khác với checkout chậm thế nào
  → DB-heavy operation dưới concurrent load

Từ case 06 (cart recovery wave):
  → Cách đọc short wave pattern
  → Write-heavy operation dưới concurrent load
  → Wave drain behavior

Case 07 TỔNG HỢP TẤT CẢ:
  → 5 service cùng chạy (không phải 1-3 như case 01-06)
  → Mỗi service có latency profile riêng
  → Weighted mix → noisy neighbor effect
  → Staged concurrency → mỗi stage là một observation window
  → Cross-stage comparison → scalability insight
  → Aggregate metrics che bottleneck → phải breakdown
  → Tất cả root cause từ case 01-06 CÓ THỂ xuất hiện đồng thời
```

Đây là lý do case 07 là case cuối cùng: nó đòi hỏi learner đã có toàn bộ kiến thức từ 6 case trước.

---

## STAGE INTERACTION ANALYSIS — "Noisy Neighbor" across stages

Đây là phần độc nhất của case 07, không có ở bất kỳ case ramping-vus nào khác. Khi 5 service cùng chia sẻ một pool VUs thay đổi theo stages trong closed model, một service chậm ở stage peak sẽ kéo throughput của TẤT CẢ các service khác — và effect này THAY ĐỔI THEO TỪNG STAGE.

### Setup demo

Giả sử backend có latency profile như sau:

```text
production_curve_browse:   avg=120ms  (weight 50%)
production_curve_cart_add: avg=180ms  (weight 20%)
production_curve_auth_me:  avg=80ms   (weight 15%)
production_curve_checkout: avg=2000ms (weight 10%)
production_curve_report:   avg=1000ms (weight 5%)

sleep giữa các loop: 500ms
```

### Tính expected loop duration và iter/s per stage

```text
avg API time (weighted):
  = 0.50×120 + 0.20×180 + 0.15×80 + 0.10×2000 + 0.05×1000
  = 60 + 36 + 12 + 200 + 50
  = 358ms

avg loop duration = 358ms + 500ms (sleep) = 858ms

Stage 1 (2->12 VUs, avg ~7 VUs):
  expected iter/s ≈ 7 / 0.858 ≈ 8.2 iter/s

Stage 2 (12->30 VUs, avg ~21 VUs):
  expected iter/s ≈ 21 / 0.858 ≈ 24.5 iter/s

Stage 3 (30 VUs, phẳng):
  expected iter/s ≈ 30 / 0.858 ≈ 35.0 iter/s

Stage 4 (30->8 VUs, avg ~19 VUs):
  expected iter/s ≈ 19 / 0.858 ≈ 22.1 iter/s

Stage 5 (8->2 VUs, avg ~5 VUs):
  expected iter/s ≈ 5 / 0.858 ≈ 5.8 iter/s
```

### Phân tích: Checkout contribution vào loop duration

```text
Checkout chỉ 10% weight, nhưng contribution vào avg API time:
  Checkout contribution = 0.10 × 2000ms = 200ms
  Tổng avg API time = 358ms
  → Checkout đóng góp 200/358 = 55.9% avg API time!

Trong khi browse (50% weight):
  Browse contribution = 0.50 × 120ms = 60ms
  → Browse đóng góp 60/358 = 16.8% avg API time

Kết luận gây sốc:
  Checkout 10% weight → 56% loop duration contribution
  Browse 50% weight → 17% loop duration contribution

  CHECKOUT KÉO LOOP DURATION MẠNH GẤP 3.3 LẦN BROWSE DÙ CHỈ BẰNG 1/5 VỀ COUNT!
```

### Scenario: Checkout external bị chậm ở peak stage

```text
Bình thường (tất cả stage):
  checkout avg = 2000ms
  avg_loop = 858ms
  stage 3 iter/s ≈ 35.0

Checkout external gặp vấn đề ở stage 3 (payment gateway chậm khi nhiều concurrent):
  checkout avg = 5000ms (tăng 3000ms)

  avg API time mới:
    = 0.50×120 + 0.20×180 + 0.15×80 + 0.10×5000 + 0.05×1000
    = 60 + 36 + 12 + 500 + 50
    = 658ms

  avg loop duration mới = 658 + 500 = 1158ms

  stage 3 iter/s mới = 30 / 1.158 ≈ 25.9 iter/s

  Throughput drop ở stage 3:
    = (35.0 - 25.9) / 35.0 ≈ 26.0% giảm!

QUAN TRỌNG: Stage 1, 2, 4, 5 vẫn bình thường (checkout 2000ms).
Chỉ stage 3 bị ảnh hưởng vì checkout chậm do concurrent pressure.
```

### Sốc hơn: Browse throughput ở stage 3 cũng giảm dù products-service KHÔNG thay đổi!

```text
Products-service latency vẫn 120ms (hoàn toàn bình thường).
Nhưng tổng iter/s ở stage 3 giảm từ 35.0 xuống 25.9.

Số browse requests ở stage 3 trước đây (38s, 30 VUs):
  = 35.0 iter/s × 38s × 50% = 665 requests

Số browse requests ở stage 3 sau khi checkout chậm:
  = 25.9 iter/s × 38s × 50% = 492 requests

Browse throughput drop = (665 - 492) / 665 ≈ 26.0%

PRODUCTS-SERVICE KHÔNG THAY ĐỔI, nhưng browse throughput giảm 26% ở stage 3!
Stage 1, 2, 4, 5: browse throughput bình thường.
```

**Đây là "noisy neighbor" effect trong staged closed model**:

```text
1. Checkout service chậm ở stage 3 (vấn đề của order-service, chỉ ở peak)
2. Mỗi lần một VU hit checkout ở stage 3 → VU đó bị giữ 5000ms thay vì 2000ms
3. Trong 5000ms đó, VU KHÔNG THỂ chạy loop khác (kể cả browse)
4. 30 VUs, checkout 10% → trung bình 3 VU luôn đang ở checkout
5. Khi checkout chậm, 3 VU đó bị giữ lâu hơn → giảm effective pool size
6. 27 VUs còn lại vẫn phải phục vụ TOÀN BỘ traffic
7. → Tổng iter/s ở stage 3 giảm → TẤT CẢ operation đều giảm throughput ở stage 3
8. Stage 1, 2, 4, 5 không bị ảnh hưởng → vấn đề CHỈ ở peak

Products team nhìn dashboard: "Sao browse throughput tụt ở peak? Code bọn tao đâu có đổi?"
→ Câu trả lời: checkout kéo cả test xuống ở peak stage. Đây là systemic effect.
→ Không phải products bug. Là noisy neighbor từ order-service.
```

### Minh họa bằng trace 5 VUs trong stage 3 (peak, 30 VUs thực tế)

```text
5 VUs trong pool 30 VUs, mỗi loop = 1 operation (weighted random) + 0.5s sleep
Bỏ qua sleep để thấy rõ effect. Giả sử checkout đang degraded (5000ms).

T=0.0s:  5 VUs cùng start loop
  VU=1: checkout   (5000ms) ← bị giữ rất lâu
  VU=2: browse     (120ms)
  VU=3: cart_add   (180ms)
  VU=4: browse     (120ms)
  VU=5: auth_me    (80ms)

T=0.1s: VU=5 xong → loop 2: report (1000ms) ← bị giữ
         VU=2 xong → loop 2: browse (120ms)
         VU=4 xong → loop 2: cart_add (180ms)

T=0.2s: VU=2 xong → loop 3: browse (120ms)
         VU=3 xong → loop 2: auth_me (80ms)

T=0.3s: VU=2 xong → loop 4: checkout (5000ms) ← VU=2 cũng bị kẹt!
         VU=3 xong → loop 3: browse (120ms)
         VU=4 xong → loop 3: browse (120ms)

...VU=2, VU=3, VU=4 chạy thêm vài loop nhanh...

T=1.0s: VU=5 xong (report) → loop 3: browse (120ms)
T=1.1s: VU=5 xong → loop 4: cart_add (180ms)
...

T=5.0s: VU=1 xong (checkout) ← MÃI TỚI 5 GIÂY MỚI XONG!
T=5.3s: VU=2 xong (checkout) ← VU=2 cũng mất 5s

Tổng kết 5 giây:
  VU=1: 1 loop  (bị checkout giữ 5s)
  VU=2: ~5 loops (4 nhanh + 1 checkout 5s)
  VU=3: ~15 loops (toàn browse/cart/auth — nhanh)
  VU=4: ~15 loops
  VU=5: ~4 loops (bị report giữ 1 lần, còn lại nhanh)

Tổng loops trong 5s: 1+5+15+15+4 = 40 loops
→ iter/s = 8 (cho 5 VUs này)

Nếu tất cả VU đều browse (120ms):
  5 VUs × (5000ms / 120ms) ≈ 208 loops trong 5s
  → iter/s = 41.6

Checkout làm iter/s giảm 81% (từ 41.6 xuống 8) trong trace này!
Và VU=1 gần như "mất tích" khỏi pool suốt 5 giây.
```

### Hệ quả thực tế cho người đọc dashboard

```text
Khi thấy iter/s ở stage 3 thấp hơn mong đợi:

1. ĐỪNG kết luận "k6 không bơm đủ" — ramping-vus không có target RPS

2. ĐỪNG kết luận "products-service chậm" nếu browse p95 vẫn thấp
   → Browse có thể vẫn nhanh, nhưng checkout/report kéo iter/s

3. HÃY so sánh iter/s giữa các stage:
   - Stage 2 (avg 21 VUs): iter/s = 24 → 24/21 = 1.14 iter/s/VU
   - Stage 3 (30 VUs): iter/s = 26 → 26/30 = 0.87 iter/s/VU
   - iter/s/VU giảm 24% → CÓ VẤN ĐỀ ở stage 3

4. HÃY breakdown theo operation ở TỪNG STAGE:
   - Stage 2: checkout p95 = 2000ms
   - Stage 3: checkout p95 = 5000ms → ĐÂY LÀ NGUYÊN NHÂN
   - Browse p95 không đổi giữa 2 stage → products-service OK

5. HÃY tính expected iter/s từ operation latency per stage:
   - Stage 3 expected iter/s = 30 / (weighted_avg_latency + sleep)
   - Nếu actual << expected → có vấn đề ngoài latency (connection, DNS, ...)

6. HÃY check per-stage operation count:
   - Stage 3 checkout count có ít hơn expected không?
   - Nếu ít hơn → VUs bị checkout giữ quá lâu → ít checkout loop hoàn tất
   - Đây là vòng xoáy closed-model: chậm → ít loop → càng ít sample
```

### Demo tính toán ngược từ actual iter/s để tìm operation chậm ở stage 3

```text
Stage 3 actual iter/s = 28 (từ dashboard)
VUs = 30
→ actual avg_loop = 30 / 28 = 1.071s

Biết sleep = 0.5s
→ actual avg API time = 1.071 - 0.5 = 0.571s = 571ms

So với expected API time (khi tất cả service khỏe):
  expected API time = 0.50×120 + 0.20×180 + 0.15×80 + 0.10×500 + 0.05×400
                    = 60 + 36 + 12 + 50 + 20 = 178ms

571ms >> 178ms → có operation nào đó chậm hơn expected RẤT NHIỀU

Check từng operation p95 ở stage 3:
  browse:   p95=200ms → OK, gần expected
  cart:     p95=300ms → OK
  auth:     p95=150ms → OK
  checkout: p95=5000ms → ĐÂY! Chậm gấp 10 lần expected (500ms)
  report:   p95=1000ms → hơi cao nhưng không đủ giải thích 571ms

Checkout contribution thực tế:
  = 0.10 × (5000ms avg thực tế) = 500ms
  → Checkout đóng góp 500/571 = 87.6% avg API time!

→ Kết luận: checkout service đang có vấn đề NGHIÊM TRỌNG ở stage 3
→ Hành động: route vấn đề về order-service team
→ Kiểm tra: external payment gateway có bị quá tải ở 30 concurrent không?
```

---

## PRODUCTION CURVE PHILOSOPHY — Vì sao case này tồn tại

Case 07 không phải là một test pass/fail thông thường. Nó là **bài tổng hợp** — nơi tất cả kiến thức từ case 01-06 được áp dụng đồng thời để đọc một mixed staged production curve.

### Mục đích tồn tại của case 07

```text
Case 07 = "production traffic pattern validation"
         = "hệ thống hoạt động thế nào khi traffic đi theo curve thật?"

Nó trả lời:
  - Ở mỗi stage (morning/peak/afternoon/cooldown), service nào chậm?
  - Ở peak (30 VUs), service nào là bottleneck?
  - Throughput scaling từ stage 1 đến stage 3 có tuyến tính không?
  - Recovery từ stage 3 về stage 4 có mượt không?
  - Mixed traffic có che bottleneck nào không?

Nó KHÔNG trả lời:
  - Hệ thống chịu được bao nhiêu users tối đa? (cần ramp lên cao hơn)
  - Hệ thống giữ được RPS target không? (cần constant-arrival-rate)
  - Baseline phẳng ở 30 VUs là gì? (cần constant-vus)
```

### Case 07 trong performance testing pipeline

```text
Performance testing pipeline cho mixed services:

Step 1: SINGLE-SERVICE BASELINE (constant-vus, từng service riêng)
  - Mục tiêu: Đo natural behavior của TỪNG service
  - Câu hỏi: "Mỗi service chạy thế nào khi chỉ có mình nó?"
  - Output: baseline latency, RPS, error rate per service

Step 2: MIXED BASELINE (constant-vus, 30 VUs phẳng, mixed)
  - Mục tiêu: Đo natural behavior khi TẤT CẢ service cùng chạy
  - Câu hỏi: "Có noisy neighbor effect ngay cả ở concurrency phẳng không?"
  - Output: mixed baseline latency per service

Step 3: SINGLE-SERVICE STAGED (ramping-vus, từng case 01-06)
  - Mục tiêu: Hiểu từng service dưới staged concurrency
  - Câu hỏi: "Service X phản ứng thế nào khi VUs thay đổi theo stage?"
  - Output: per-service scalability insight

Step 4: MIXED STAGED (ramping-vus, case 07 — THIS CASE)
  - Mục tiêu: TỔNG HỢP — tất cả service cùng chạy qua production curve
  - Câu hỏi: "Production traffic curve có vấn đề gì không?"
  - Output: cross-service, cross-stage bottleneck analysis

Step 5: CAPACITY (constant-arrival-rate với target RPS)
  - Mục tiêu: Đo khả năng giữ target RPS
  - Câu hỏi: "Hệ thống giữ được target RPS = production peak × 1.2 không?"
  - Output: drop rate, latency at target RPS

Không có Step 4, bạn không biết production curve thật có vấn đề gì.
Các step trước chỉ là chuẩn bị — Step 4 mới là "prove it in production-shape".
```

## Service/API flow

Flow pattern:

```text
Weighted mixed production flow: browse 50, cart 20, auth 15, checkout 10, report 5.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| production_curve_browse | products-service | GET | /api/sim/products | 200 | Browse branch. |
| production_curve_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart branch. |
| production_curve_auth_me | auth-service | GET | /api/sim/auth/me | 200 | Auth/session branch. |
| production_curve_checkout | order-service | POST | /api/sim/checkout | 200 | Checkout branch. |
| production_curve_report | report-service | GET | /api/sim/report | 200 | Report branch. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm — đặc biệt qua các stage có sample size khác nhau.

### Đặc điểm latency của từng operation

```text
production_curve_browse (50%):
  - GET request, thường có cache
  - Query: SELECT products với limit, sort, filter
  - Expected latency: thấp nhất trong 5 operation
  - Risk: cache miss, full table scan nếu thiếu index
  - Stage behavior: latency thường ổn định qua các stage

production_curve_cart_add (20%):
  - POST request, write operation
  - INSERT/UPDATE vào cart table
  - Expected latency: trung bình
  - Risk: lock contention nếu nhiều user cùng cart, DB write bottleneck
  - Stage behavior: có thể tăng ở peak do write contention

production_curve_auth_me (15%):
  - GET request, session validation
  - Thường dùng cache (Redis/session store)
  - Expected latency: thấp (cache hit)
  - Risk: session store chậm, cache miss
  - Stage behavior: thường ổn định, ít bị ảnh hưởng bởi concurrency

production_curve_checkout (10%):
  - POST request, multi-step transaction
  - Có thể gọi external (payment, inventory, shipping)
  - Expected latency: CAO NHẤT trong 5 operation
  - Risk: external timeout, DB transaction lock, inventory row contention
  - Stage behavior: LATENCY TĂNG MẠNH Ở PEAK do concurrent external calls

production_curve_report (5%):
  - GET request, aggregation query
  - SUM, GROUP BY, JOIN trên nhiều bảng
  - Expected latency: cao thứ nhì
  - Risk: full scan, missing aggregate index, large dataset
  - Stage behavior: có thể tăng ở peak do DB đang bận với checkout
```

## Metrics và tags cần đọc

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_active_iterations` | Counter | Số user loops hoàn tất trong staged run. Đây là output, không phải target. |
| `ramping_active_iterations_failed` | Counter | Số loops có ít nhất một API required fail. Đây là business-flow failure counter. |
| `ramping_api_calls_total` | Counter | Tổng API calls do ramping user pool tạo ra. Dùng để sanity check operation mix. |
| `ramping_flow_duration_ms` | Trend | End-to-end duration của một user loop. Metric chính để giải thích iter/s flatten. |
| `ramping_sleep_seconds` | Counter | Think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |
| `vus` | Gauge | Active VUs sampled over time; phải đi theo stage shape. |
| `vus_max` | Gauge | Max VUs observed/reserved, dùng để đối chiếu peak target. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-07-production-traffic-curve`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-07-production-traffic-curve
business_case = production_traffic_curve
workload      = staged_concurrency
```

### Tại sao tag `operation` và `service` là bắt buộc với case 07?

```text
Không có operation tag:
  - http_req_duration aggregate = 450ms
  - Không biết operation nào chậm
  - Không biết operation nào chậm ở stage nào
  - Không biết service nào cần điều tra
  → VÔ DỤNG cho debugging

CÓ operation tag:
  - http_req_duration{operation:production_curve_browse} p95 = 200ms
  - http_req_duration{operation:production_curve_checkout} p95 = 5000ms
  - http_req_duration{operation:production_curve_report} p95 = 2000ms
  → Biết chính xác checkout và report cần điều tra
  → Route vấn đề đến order-service và report-service

CÓ service tag:
  - http_req_duration{service:products-service} p95 = 220ms
  - http_req_duration{service:order-service} p95 = 5000ms
  - http_req_duration{service:report-service} p95 = 2000ms
  → Biết service nào cần owner xem

CÓ stage context (qua time range hoặc custom tag):
  - Stage 2 (12->30 VUs): checkout p95 = 2000ms
  - Stage 3 (30 VUs): checkout p95 = 5000ms ← TĂNG 2.5×!
  → Biết chính xác vấn đề xảy ra ở peak stage
  → KHÔNG phải checkout luôn chậm — chỉ chậm ở peak
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.98
http_req_failed: rate<0.02
ramping_active_iterations_failed: count<50
```

Các counters/trends cần sanity check:

```text
ramping_active_iterations
ramping_active_iterations_failed
ramping_api_calls_total
ramping_flow_duration_ms
ramping_sleep_seconds
iterations
http_reqs
vus / vus_max
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

### Sanity check chi tiết

```text
1. ramping_active_iterations ≈ iterations
   - Mỗi iteration = 1 loop của 1 VU
   - Nếu chênh lệch > 5% → có thể có iteration không được count đúng

2. ramping_api_calls_total ≈ http_reqs
   - Mỗi loop = 1 operation = 1 HTTP request
   - Nếu chênh lệch → có operation không gọi HTTP, hoặc HTTP bị drop

3. Weighted mix sanity:
   - Sau toàn bộ 5 stage, operation counts nên approximate weights
   - browse / total ≈ 0.50 (± 5% với sample lớn)
   - checkout / total ≈ 0.10
   - Nếu lệch xa (> 10%) → script bug hoặc weighted random implementation sai

4. Weighted mix PER STAGE:
   - Stage 1 (sample nhỏ, ~200-300 requests): weight có thể dao động ±15%
   - Stage 3 (sample lớn, ~1500 requests): weight nên hội tụ ±5%
   - Nếu stage 3 vẫn lệch > 10% → script bug

5. ramping_sleep_seconds:
   - Expected: total_iterations × 0.5s
   - Nếu chênh lệch → sleep không được gọi đúng, hoặc bị skip ở branch nào đó

6. vus shape:
   - vus_max nên gần peak target (30)
   - vus chart phải đi theo 2->12->30->8->2
   - Nếu không → config/dashboard issue

7. Cross-stage iter/s scaling:
   - iter/s_stage3 / VUs_stage3 so với iter/s_stage2 / VUs_stage2
   - Nếu giảm > 20% → saturation hoặc noisy neighbor
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

### Override config qua env vars

```powershell
# Tăng peak VUs để tìm capacity knee
$env:RV_07_PEAK_VUS = 50
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js

# Tăng duration scale để chạy gần business timeline hơn
$env:RV_07_DURATION_SCALE = 1.0
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js

# Giảm sleep để thấy throughput maximum
$env:RV_07_SLEEP_SECONDS = 0.1
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js

# Thay đổi weight distribution (cần sửa script, không phải env var)
# Xem phần Mở rộng bên dưới
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = production_traffic_curve
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 2 -> 12 -> 30 -> 8 -> 2
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
ramping_active_iterations
ramping_api_calls_total
```

Nhớ:

```text
iterations/RPS là output, không có exact expected target.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Branch mix 50/20/15/10/5 là expected ratio over enough loops.
- Aggregate p95 xấu phải breakdown trước khi route issue.
- RPS thấp hơn baseline có thể do một service branch kéo flow duration.

### Bước 6 (RIÊNG CHO CASE 07) — Service breakdown per stage

Đây là bước quan trọng nhất cho mixed production curve:

```text
1. Lấy http_req_duration breakdown theo operation, ở TỪNG STAGE:
   - Stage 2 (12->30 VUs): mỗi operation p95
   - Stage 3 (30 VUs, peak): mỗi operation p95
   - Stage 4 (30->8 VUs): mỗi operation p95

2. So sánh p95 giữa các stage cho CÙNG operation:
   - checkout: stage 2 p95 vs stage 3 p95 → scaling behavior
   - report: stage 2 p95 vs stage 3 p95
   - browse: stage 2 p95 vs stage 3 p95 (nên ổn định)

3. Tính contribution vào avg loop duration per stage:
   - contribution_i = weight_i × avg_latency_i
   - Operation có contribution cao nhất = kéo loop duration mạnh nhất ở stage đó
   - Contribution này có THAY ĐỔI giữa các stage không?

4. So sánh actual iter/s với expected per stage:
   - expected_loop = weighted_avg(latency) + sleep
   - expected_iter_s = vus / expected_loop
   - Nếu actual << expected → có vấn đề ngoài latency (connection, DNS, ...)

5. Check cross-stage throughput scaling:
   - iter/s_stage2 / avg_VUs_stage2 = efficiency_2
   - iter/s_stage3 / avg_VUs_stage3 = efficiency_3
   - Nếu efficiency_3 < efficiency_2 × 0.8 → saturation/noisy neighbor ở peak

6. Check operation count distribution PER STAGE:
   - Stage 3 operation counts có approximate weights không?
   - Nếu checkout count ít hơn expected → VUs bị checkout giữ quá lâu
   - Nếu report count ít hơn expected → tương tự
```

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #57

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_07_START_VUS=2
RV_07_MID_VUS=12
RV_07_PEAK_VUS=30
RV_07_LATE_VUS=8
RV_07_DURATION_SCALE=0.25
RV_07_SLEEP_SECONDS=0.5
```

| Item | Value |
| --- | --- |
| Script | `rv-07-production-traffic-curve.js` |
| Run ID | `57` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `2 -> 12 -> 30 -> 8 -> 2` |
| Observed `vus` min/max | 2 / 30 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (4171/4171) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/4171) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 4171 (37.75/s) | Output, không phải target. |
| `http_reqs` | 4171 (37.75/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 4171 | Completed user loops. |
| `ramping_api_calls_total` | 4171 | Custom API counter. |
| `ramping_sleep_seconds` | 2085.5s | Think time do script thêm. |
| `http_req_duration` | avg 33.3ms, p95 153ms, p99 683ms, max 1.41s | Request-level latency. |
| `ramping_flow_duration_ms` | avg 33.4ms, p95 154ms, p99 683ms, max 1.41s | Full user-loop latency. |
| `iteration_duration` | avg 534ms, p95 653ms, p99 1.18s, max 1.91s | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `production_curve_browse` | GET | 200 | 2068 | 49.58% |
| `production_curve_cart_add` | POST | 200 | 814 | 19.52% |
| `production_curve_auth_me` | GET | 200 | 649 | 15.56% |
| `production_curve_checkout` | POST | 200 | 410 | 9.83% |
| `production_curve_report` | GET | 200 | 230 | 5.51% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Mixed production curve có p95 cao hơn case đơn giản do checkout/report/product mix, nhưng không còn 429/failed request.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 3587 |
| Avg của các window avg | 37.7ms |
| Max window p95 | 1.40s |
| Max window p99 | 1.40s |
| Max request window | 1.41s |
| Windows p95 > 100ms | 234 |
| Windows p95 > 500ms | 63 |

#### 2. Execution timeline chart

Không có failed iterations. Tất cả operation trong mix đều status 200.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 4171 |
| Sum `http_reqs` buckets | 4171 |
| Peak iter/s bucket | 60 |
| Peak http_req/s bucket | 60 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 30 đúng contract gốc, không phải bản giảm tải 24 VUs. Đây là tín hiệu tốt: production curve đã pass theo đúng tài liệu đề ra.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 110 |
| VUs min/max series | 2 / 30 |
| Avg VUs series | 20.20 |
| Peak iter/s bucket | 60 |

### Kết luận contract rerun #57

OK theo contract gốc.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 07

> Phần này giữ cách đọc dashboard chung; số thật của run gần nhất nằm ở section `Real run` phía trên.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? | Business correctness nếu không đọc failures |

### Chart 1 — Response time

Đọc theo `operation`:

```text
production_curve_browse: GET /api/sim/products
production_curve_cart_add: POST /api/sim/cart/add
production_curve_auth_me: GET /api/sim/auth/me
production_curve_checkout: POST /api/sim/checkout
production_curve_report: GET /api/sim/report
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

Case-specific hints:

- Response time: products/cart/auth/order/report breakdown bắt buộc.
- Execution timeline: failures ở peak có thể chỉ một service gây ra.
- VUs vs iter/s: 30 VUs peak mà iter/s flatten là mixed-system saturation signal.

#### Phân tích sâu Chart 1 cho case 07

Với case 07, Response time chart cần được đọc theo 3 lớp và theo TỪNG STAGE:

**Lớp 1 — Aggregate (cảnh báo ban đầu)**:

```text
http_req_duration aggregate:
  - avg: baseline tổng thể
  - p95: có operation nào kéo tail không?
  - max: spike lớn nhất

  Nếu aggregate p95 cao (> 1s) → CÓ vấn đề ở đâu đó
  Nhưng KHÔNG BIẾT ở đâu, KHÔNG BIẾT ở stage nào → cần lớp 2
```

**Lớp 2 — Breakdown theo operation (xác định bottleneck)**:

```text
Filter theo operation:

  production_curve_browse:
    - p95 thường thấp nhất (~100-300ms)
    - Nếu cao → products-service hoặc DB query vấn đề
    - Nên ổn định qua các stage

  production_curve_cart_add:
    - p95 trung bình (~150-500ms)
    - Nếu cao → DB write contention
    - Có thể tăng ở peak stage

  production_curve_auth_me:
    - p95 thường thấp (~50-200ms)
    - Nếu cao → session store/cache vấn đề
    - Thường ổn định qua các stage

  production_curve_checkout:
    - p95 CAO NHẤT (~1000-5000ms)
    - Đây là EXPECTED với checkout (external calls)
    - Nhưng nếu > 5000ms → external timeout hoặc DB lock
    - SO SÁNH stage 2 vs stage 3: tăng bao nhiêu?

  production_curve_report:
    - p95 cao thứ nhì (~500-2000ms)
    - Nếu > 3000ms → aggregation query thiếu index
    - Có thể tăng ở peak do DB bận
```

**Lớp 3 — So sánh p95 contribution (hiểu systemic impact)**:

```text
Sau khi có p95 từng operation, tính "weighted drag":

  drag_i = weight_i × p95_i

  production_curve_browse:   0.50 × 200ms  = 100ms
  production_curve_cart_add: 0.20 × 300ms  = 60ms
  production_curve_auth_me:  0.15 × 150ms  = 22.5ms
  production_curve_checkout: 0.10 × 3000ms = 300ms  ← DRAG LỚN NHẤT
  production_curve_report:   0.05 × 1500ms = 75ms

  → Checkout drag 300ms, dù weight chỉ 10%
  → Browse drag 100ms với weight 50%
  → Checkout cần optimize ĐẦU TIÊN, sau đó đến report
```

**Lớp 4 — Cross-stage latency comparison (RIÊNG CHO CASE 07)**:

```text
Cùng operation, so sánh p95 giữa các stage:

  production_curve_checkout:
    Stage 2 (12->30 VUs): p95 = 2000ms
    Stage 3 (30 VUs):     p95 = 5000ms  ← TĂNG 2.5×
    Stage 4 (30->8 VUs):  p95 = 2200ms  ← GIẢM, về gần stage 2

  → Checkout bị ảnh hưởng NẶNG ở peak (30 VUs)
  → Recovery tốt ở stage 4 (về gần stage 2 level)
  → Đây là concurrent external call bottleneck

  production_curve_report:
    Stage 2 (12->30 VUs): p95 = 900ms
    Stage 3 (30 VUs):     p95 = 2000ms  ← TĂNG 2.2×
    Stage 4 (30->8 VUs):  p95 = 1000ms  ← GIẢM, về gần stage 2

  → Report cũng bị ảnh hưởng ở peak, nhưng ít hơn checkout
  → DB đang bận với checkout → report query chậm hơn

  production_curve_browse:
    Stage 2: p95 = 180ms
    Stage 3: p95 = 200ms  ← HẦU NHƯ KHÔNG ĐỔI
    Stage 4: p95 = 185ms

  → Browse ổn định qua mọi stage → products-service KHÔNG có vấn đề
```

**Shape xấu cần chú ý trên Chart 1**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Aggregate p95 cao, nhưng tất cả operation p95 thấp | Có operation "ma" không được tag | Kiểm tra script — thiếu tag operation ở đâu đó |
| Browse p95 ổn, checkout p95 spike ở stage 3 | External payment/service chậm ở peak | Route về order-service |
| Report p95 tăng dần theo thời gian (không giảm ở stage 4) | Memory/DB state phình, không recover | Kiểm report query plan, DB connection pool |
| Tất cả operation p95 tăng cùng lúc ở stage 3 | Vấn đề systemic (network, DB, infra) ở peak | Kiểm infrastructure, không phải service code |
| Checkout p95 = max (timeout) | External hoàn toàn không phản hồi | Block, điều tra external dependency |
| Cart add p95 tăng nhưng browse ổn | DB write bottleneck riêng | Kiểm cart table lock, DB write capacity |
| Auth p95 tăng ở stage 3 | Session store quá tải ở peak | Kiểm session cache/Redis |

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 2 -> 12 -> 30 -> 8 -> 2.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Phân tích sâu Chart 2 cho case 07

Chart Execution timeline cho case 07 có thêm chiều `operation` và chiều `stage`:

```text
Nhìn chart, filter theo operation để thấy:
  - Mỗi giây có bao nhiêu browse request?
  - Mỗi giây có bao nhiêu checkout request?
  - Tỉ lệ có khớp weight không?
  - Tỉ lệ có THAY ĐỔI theo stage không?

Nếu checkout request đột ngột biến mất ở stage 3:
  → Checkout service có thể bị down/lỗi ở peak
  → Nhưng VU vẫn chạy, chỉ là checkout branch fail
  → ramping_active_iterations_failed sẽ tăng

Nếu report request giảm dần trong stage 3:
  → Report query ngày càng chậm, VU bị giữ lâu hơn
  → Dẫn đến ít loop hơn → ít report request hơn
  → Đây là vòng xoáy closed-model: chậm → ít loop → càng ít request
```

**Patterns cần chú ý trên Chart 2 cho mixed production curve**:

| Pattern | Nghĩa | Hành động |
| --- | --- | --- |
| Một operation biến mất khỏi chart ở stage 3 | Service đó bị down hoặc all request fail ở peak | Kiểm operation failed count |
| Tỉ lệ operation không khớp weight ở stage 3 | Weighted random bug hoặc một operation fail nhiều ở peak | Kiểm script, kiểm error rate |
| RPS tăng theo VUs nhưng flatten ở stage 3 | Saturation ở peak | Phân tích operation latency |
| RPS giảm, tất cả operation cùng giảm ở stage 3 | Closed-model backpressure từ 1+ operation chậm | Tìm operation p95 tăng ở stage 3 |
| RPS spike ở đầu mỗi stage rồi ổn định | Cold start mỗi stage, cache warm-up | Bình thường nếu ổn định sau vài giây |
| RPS tụt đột ngột giữa stage 3 | External dependency fail, hoặc DB lock | Điều tra thời điểm tụt |
| RPS không tăng khi VUs ramp 12->30 (stage 2) | Saturation bắt đầu TRƯỚC peak | Hệ thống bão hòa sớm — kiểm tra ngay |
| RPS giảm chậm ở stage 4 (ramp-down) | gracefulRampDown behavior bình thường | KHÔNG đọc là vấn đề |

### Chart 3 — VUs vs iter/s

Expected:

```text
VUs: ramp/plateau/ramp-down theo stages
iter/s: tăng theo VUs nếu backend còn capacity
iter/s: flatten/fall nếu flow duration tăng hoặc backend saturated
```

Bad/important shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs follow stages, iter/s follows roughly | Healthy scaling shape |
| VUs rise, iter/s flat | Possible saturation/backpressure |
| VUs fall, iterations continue briefly | gracefulRampDown behavior |
| VUs not matching stages | Config/env/dashboard issue |

#### Phân tích sâu Chart 3 cho case 07

VUs vs iter/s là chart **quan trọng nhất** để hiểu closed-model behavior của staged mixed load.

```text
Tại sao chart này quan trọng với case 07?

Vì nó cho thấy MỐI QUAN HỆ giữa:
  - Active users (VUs thay đổi theo stage)
  - Throughput (iter/s, dao động theo VUs và latency)

Nếu VUs tăng mà iter/s tăng gần tuyến tính:
  → Hệ thống scale tốt, chưa saturated
  → Tất cả service đang khỏe

Nếu VUs tăng mà iter/s flatten:
  → Closed-model backpressure: VUs vẫn active, nhưng mỗi loop chậm hơn
  → Phải tìm operation nào làm loop chậm (dùng Chart 1)
  → Phải tìm STAGE nào bắt đầu flatten (dùng stage transition)

Nếu VUs giảm mà iter/s giảm nhanh hơn expected:
  → Có thể VUs bị dừng đột ngột (gracefulRampDown quá ngắn)
  → Hoặc operation đang chạy dở bị ngắt
```

**Cách đọc chart cho mixed production curve qua 5 stage**:

```text
Stage 1 — Morning ramp (VUs: 2->12):
  - iter/s tăng từ ~2 lên ~14 (tăng theo VUs)
  - Nếu iter/s không tăng → vấn đề ngay từ đầu
  - ĐÂY LÀ BASELINE REFERENCE cho scaling

Stage 2 — Ramp to peak (VUs: 12->30):
  - iter/s tiếp tục tăng từ ~14 lên ~35?
  - HAY iter/s flatten ở ~25 khi VUs > 20?
  - Nếu flatten → saturation bắt đầu ở ~20 VUs
  - ĐÂY LÀ GIAI ĐOẠN QUAN TRỌNG NHẤT để tìm saturation point

Stage 3 — Sustained peak (VUs: 30 phẳng):
  - iter/s dao động quanh giá trị ổn định
  - Nếu iter/s giảm dần trong stage 3 → degradation theo thời gian
  - Nếu iter/s ổn định → peak bền vững

Stage 4 — Afternoon decline (VUs: 30->8):
  - iter/s giảm từ ~35 xuống ~10
  - Nếu giảm tuyến tính theo VUs → recovery tốt
  - Nếu giảm chậm hơn → in-flight iterations đang finish (bình thường)

Stage 5 — Cooldown (VUs: 8->2):
  - iter/s về thấp
  - Tail iterations có thể xuất hiện → gracefulRampDown
  - KHÔNG dùng stage 5 để kết luận
```

**Shape cần chú ý cho mixed production curve**:

| Shape | Nghĩa cho case 07 | Hành động |
| --- | --- | --- |
| VUs theo shape, iter/s scale gần tuyến tính | Tất cả service ổn, production curve sạch | Ghi nhận production baseline |
| VUs tăng 12->30, iter/s flatten ở ~20 VUs | Saturation bắt đầu trước peak | So Chart 1 tìm operation chậm ở stage 2 |
| VUs=30, iter/s giảm dần trong stage 3 | 1+ operation ngày càng chậm (leak, DB phình) | So Chart 1 tìm operation tăng dần |
| VUs=30, iter/s dao động mạnh | Checkout/report weight nhỏ gây spike khi hit | Bình thường với mixed weight, kiểm operation p95 |
| VUs giảm 30->8, iter/s vẫn cao một lúc | gracefulRampDown cho in-flight finish | Bình thường, không phải vấn đề |
| VUs tụt giữa test | VU crash, OOM, hoặc error | Kiểm k6 logs |
| VUs không theo shape 2->12->30->8->2 | Config/dashboard issue | Sửa config trước khi phân tích gì khác |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

#### Checklist đọc dashboard cho case 07

```text
1. Overview KPI
   - checks > 98%?
   - http_req_failed < 2%?
   - ramping_active_iterations_failed < 50?
   - VUs đi theo shape 2->12->30->8->2?
   - vus_max ≈ 30?

2. Response time chart
   - Đã filter theo operation chưa?
   - Operation nào p95 cao nhất?
   - Operation p95 cao có weight thấp không? (noisy neighbor)
   - Operation nào drag nhiều nhất?
   - SO SÁNH p95 CỦA CÙNG OPERATION GIỮA CÁC STAGE?
   - Operation nào tăng mạnh ở stage 3?
   - Có operation nào tăng dần theo thời gian không?

3. Execution timeline
   - Live VUs có theo stage shape không?
   - RPS có tăng theo VUs không?
   - Ở stage 3, RPS có flatten không?
   - Operation mix có approximate weight không?
   - Có operation nào biến mất ở stage 3 không?

4. VUs vs iter/s
   - VUs có theo shape 2->12->30->8->2 không?
   - iter/s có tăng gần tuyến tính với VUs không?
   - iter/s flatten ở VUs nào? (saturation point)
   - iter/s có giảm dần trong stage 3 không?
   - Recovery ở stage 4 có mượt không?
   - Tail ở stage 5 có bất thường không?

5. Cross-stage analysis (RIÊNG CASE 07)
   - Stage 2 vs Stage 3: latency scaling thế nào?
   - Stage 3 vs Stage 4: recovery thế nào?
   - Service nào scale kém nhất?
   - Service nào là bottleneck ở peak?

6. Business decision
   - Production curve đã pass chưa?
   - Service nào cần điều tra?
   - Service nào cần route vấn đề?
   - Saturation point ở đâu?
   - Sẵn sàng cho capacity test (constant-arrival-rate) chưa?
```

## Kết luận thực tế: output -> quyết định

Case 07 có 5 kịch bản output -> quyết định, phản ánh các tình huống thực tế khi chạy mixed staged production curve.

### Kịch bản 1 — All clean: PRODUCTION CURVE PASS

```text
checks............: 100.00%
http_req_failed...: 0.00%
ramping_active_iterations_failed: 0
VUs...............: 2->12->30->8->2 (đúng shape)
vus_max...........: 30

http_req_duration by operation (stage 3 peak):
  production_curve_browse:   p95=180ms
  production_curve_cart_add: p95=250ms
  production_curve_auth_me:  p95=120ms
  production_curve_checkout: p95=1800ms
  production_curve_report:   p95=900ms

iter/s scale gần tuyến tính với VUs
Stage 3 iter/s ≈ 35-40
```

Kết luận thực tế:

```text
- Tất cả checks pass, không có failure
- Browse latency thấp (~180ms) → products-service OK
- Checkout p95=1800ms → bình thường với external calls
- Report p95=900ms → chấp nhận được
- iter/s scale tốt theo VUs → không có saturation
- Recovery ở stage 4 mượt → không có leak

=> QUYẾT ĐỊNH: Production curve pass. Hệ thống sẵn sàng cho production traffic.
   Đây là tín hiệu tốt nhất: mixed services chịu được curve 2->12->30->8->2.
   Ghi nhận toàn bộ số làm production baseline reference.
```

### Kịch bản 2 — Checkout degrades at peak: ROUTE TO ORDER-SERVICE

```text
checks............: 99.5%
http_req_failed...: 0.5%
ramping_active_iterations_failed: 8 (toàn checkout)

http_req_duration by operation:
  Stage 2 (12->30 VUs):
    production_curve_checkout: p95=2000ms  ← bình thường

  Stage 3 (30 VUs):
    production_curve_browse:   p95=190ms  ← OK
    production_curve_cart_add: p95=270ms  ← OK
    production_curve_auth_me:  p95=130ms  ← OK
    production_curve_checkout: p95=5000ms ← RẤT CAO! Tăng 2.5×
    production_curve_report:   p95=950ms  ← OK

  Stage 4 (30->8 VUs):
    production_curve_checkout: p95=2100ms ← GIẢM, về gần stage 2 level

iter/s stage 2: 24 (21 avg VUs) → 1.14 iter/s/VU
iter/s stage 3: 26 (30 VUs)     → 0.87 iter/s/VU ← GIẢM 24%!
iter/s stage 4: 20 (19 avg VUs) → 1.05 iter/s/VU ← RECOVER
```

Kết luận thực tế:

```text
- Browse, cart, auth đều OK ở mọi stage
- Checkout p95 tăng 2.5× ở stage 3 → external payment gateway có vấn đề ở peak
- 8 loop failed đều là checkout → consistent issue
- iter/s/VU giảm 24% ở stage 3 vì checkout kéo loop duration
- Recovery tốt ở stage 4 → vấn đề CHỈ ở peak, không phải permanent degradation

=> QUYẾT ĐỊNH: Route vấn đề về order-service team.
   Products-service KHÔNG CÓ VẤN ĐỀ (dù iter/s giảm ở peak).
   Đây là noisy neighbor effect ở peak: checkout kéo toàn bộ pool.
   Kiểm tra: external payment gateway có bị quá tải ở 30 concurrent không?
   Có cần connection pool lớn hơn cho external calls không?
```

### Kịch bản 3 — Report dominates tail at peak: ROUTE TO REPORT-SERVICE

```text
checks............: 99.8%
http_req_failed...: 0.2%

http_req_duration by operation:
  Stage 2 (12->30 VUs):
    production_curve_report: p95=900ms  ← bình thường

  Stage 3 (30 VUs):
    production_curve_browse:   p95=185ms  ← OK
    production_curve_cart_add: p95=260ms  ← OK
    production_curve_auth_me:  p95=125ms  ← OK
    production_curve_checkout: p95=1900ms ← OK (bình thường)
    production_curve_report:   p95=4000ms ← RẤT CAO! Tăng 4.4×

iter/s stage 3: 28 (thấp hơn expected 35)
```

Kết luận thực tế:

```text
- Checkout p95=1900ms là bình thường
- Report p95=4000ms ở stage 3 → aggregation query có vấn đề ở peak
  (thiếu index, full scan, hoặc DB quá tải vì checkout concurrent)
- Browse, cart, auth vẫn OK

=> QUYẾT ĐỊNH: Route về report-service team.
   Kiểm tra: query plan, index, data volume, cache strategy.
   Report 5% weight nhưng drag = 0.05 × 4000 = 200ms → kéo loop duration.
   Có thể DB đang bận với checkout transaction → report query chậm theo.
   Cần kiểm tra DB connection pool và query isolation.
```

### Kịch bản 4 — One service drags throughput: NOISY NEIGHBOR CONFIRMED

```text
Stage 3 (peak, 30 VUs):
  expected iter/s (từ stage 2 scaling): ~35
  actual iter/s: ~25  ← GIẢM 29%

http_req_duration by operation (stage 3):
  production_curve_browse:   p95=195ms  ← OK, không đổi so với stage 2
  production_curve_cart_add: p95=280ms  ← OK
  production_curve_auth_me:  p95=130ms  ← OK
  production_curve_checkout: p95=6000ms ← TĂNG 3× so với stage 2 (2000ms)
  production_curve_report:   p95=2500ms ← TĂNG 2.5× so với stage 2 (1000ms)

Phân tích:
  - Browse, cart, auth: latency không đổi → service code OK
  - Checkout: latency tăng 3× → external/DB bottleneck ở peak
  - Report: latency tăng 2.5× → DB bận vì checkout
  - iter/s giảm 29%: VUs bị checkout/report giữ lâu → pool capacity giảm

Tính toán:
  - 30 VUs, checkout 10% → ~3 VUs luôn trong checkout
  - 3 VUs × 6000ms = 18 "VU-giây" bị checkout chiếm mỗi loop
  - 30 VUs, report 5% → ~1.5 VUs luôn trong report
  - 1.5 VUs × 2500ms = 3.75 "VU-giây" bị report chiếm
  - Tổng: ~21.75 "VU-giây" bị chiếm → effective pool ~27.3 VUs
  - 27.3/30 = 91% → capacity loss ~9%
  - Nhưng iter/s giảm 29% → còn có thêm yếu tố khác (network, connection pool)
```

Kết luận thực tế:

```text
- Đây là noisy neighbor effect kinh điển trong staged mixed load
- Checkout (order-service) là "hàng xóm ồn ào" ở peak
- Report (report-service) bị ảnh hưởng gián tiếp (DB contention)
- Browse, cart, auth bị giảm throughput dù code không đổi

=> QUYẾT ĐỊNH:
   1. Ưu tiên 1: Tối ưu checkout external call (timeout, connection pool)
   2. Ưu tiên 2: Tối ưu report query (index, cache)
   3. Ưu tiên 3: Kiểm tra DB connection pool size
   4. Sau khi tối ưu, chạy lại case 07 để xác nhận iter/s cải thiện
```

### Kịch bản 5 — Operation mix lệch xa weight: SCRIPT BUG

```text
Operation counts (toàn test):
  production_curve_browse:   2500 (60%)  ← expected 50%
  production_curve_cart_add: 600  (14%)  ← expected 20%
  production_curve_auth_me:  500  (12%)  ← expected 15%
  production_curve_checkout: 400  (10%)  ← expected 10% (OK)
  production_curve_report:   171  (4%)   ← expected 5%

Tổng: 4171 loops
```

Kết luận thực tế:

```text
- Browse 60% thay vì 50% → lệch
- Cart 14% thay vì 20% → thiếu
- Report 4% thay vì 5% → hơi thiếu

=> QUYẾT ĐỊNH: KHÔNG kết luận gì về backend.
   Kiểm tra script: weighted random implementation sai?
   Hoặc: một operation fail → VU retry? skip? → ảnh hưởng mix.
   Với 4171 sample, weight nên hội tụ ±2-3%.
   Nếu lệch > 5% → script bug, không phải ngẫu nhiên.
   Sửa script, chạy lại.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean mixed curve, all stages OK | Production-shaped baseline acceptable | Use as production reference |
| Overall p95 bad but one service dominates | Service-specific bottleneck | Route to service owner |
| Checkout p95 spike at stage 3 only | Peak concurrent external call issue | Investigate order-service external deps |
| Report p95 spike at stage 3 only | DB overload at peak due to checkout | Investigate report query + DB pool |
| iter/s flatten at VUs > 20 | Saturation starts before peak | Investigate which service saturates first |
| Failures in low-volume branch | Small branch business-critical issue | Do not ignore |
| Weighted mix wrong | Test invalid until distribution understood | Validate script/tags |
| VUs not matching shape | Config/env/dashboard issue | Fix config first |
| Stage 4 recovery not smooth | Possible resource leak | Check DB connections, memory |

## Nghịch lý và misconceptions của ramping-vus

Đừng dùng case này để claim max RPS. Nó là active-user production curve, không phải arrival-rate capacity test.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

### Nghịch lý 1: "Aggregate p95 ổn nhưng một service đang fail?"

```text
Learner hỏi: "Aggregate p95 chỉ 450ms, sao lại nói checkout có vấn đề?"

Trả lời: Vì aggregate p95 trong mixed test là CON SỐ VÔ NGHĨA nếu không breakdown.

Ở stage 3 (peak, 30 VUs):
  1500 requests, breakdown:
    browse:   750 requests, p95=180ms  (50%)
    cart:     300 requests, p95=250ms  (20%)
    auth:     225 requests, p95=120ms  (15%)
    checkout: 150 requests, p95=5000ms (10%)
    report:   75 requests,  p95=2000ms (5%)

  Aggregate p95 của 1500 sample:
    - 95% × 1500 = 1425 sample nhanh nhất ≤ X
    - 5% × 1500 = 75 sample chậm nhất > X
    - checkout đã có 150 sample, report 75 sample
    - 150 + 75 = 225 sample "chậm" = 15% tổng
    - 5% chậm nhất nằm TRONG tập checkout + report
    - Nhưng aggregate p95 sẽ là giá trị ở khoảng 95th percentile
    - 95th percentile của tập: 50% sample 180ms + 20% 250ms + 15% 120ms + ...
    - p95 rơi vào khoảng checkout/report sample
    - aggregate p95 ≈ 2000-3000ms (không phải 450ms như kỳ vọng sai)

  THỰC TẾ: aggregate p95 sẽ bị kéo lên bởi checkout/report.
  Nhưng nếu sample đủ lớn, aggregate p95 có thể vẫn "chỉ" 500-800ms
  vì 85% sample vẫn nhanh (browse, cart, auth).
  
  CON SỐ 500ms NÀY CHE GIẤU checkout p95=5000ms!

Bài học:
  - Aggregate p95 = 500ms → nhìn có vẻ "hơi chậm, không nghiêm trọng"
  - Checkout p95 = 5000ms → ORDER-SERVICE ĐANG GẶP VẤN ĐỀ NGHIÊM TRỌNG
  - Nếu chỉ nhìn aggregate, MISS hoàn toàn vấn đề!
  - Breakdown là BẮT BUỘC với mixed test.
```

### Nghịch lý 2: "Browse OK ở peak nhưng report fail — sao có thể?"

```text
Learner hỏi: "Browse 50% weight, p95=180ms ở stage 3. Vậy là ổn.
             Nhưng report 5% weight, p95=4000ms. Sao report fail mà browse OK?
             Cả 2 cùng chạy trên cùng hệ thống mà?"

Trả lời: Vì browse và report dùng TÀI NGUYÊN KHÁC NHAU.

Browse (GET /api/sim/products):
  - Query nhẹ: SELECT với LIMIT, có cache
  - Không JOIN, không aggregate
  - CPU thấp, IO thấp
  → KHÔNG bị ảnh hưởng bởi DB load

Report (GET /api/sim/report):
  - Query nặng: SUM, GROUP BY, JOIN nhiều bảng
  - Full scan nếu thiếu index
  - CPU cao, IO cao
  → BỊ ẢNH HƯỞNG NẶNG bởi DB load

Ở stage 3 (30 VUs):
  - 30 VUs tạo ~30 requests/s
  - ~3 checkout/s (10%) → DB transaction lock
  - ~1.5 report/s (5%) → DB aggregation query
  - DB đang bận với checkout transaction → report query phải đợi
  - Browse query nhẹ → không bị ảnh hưởng

Đây là lý do cần PER-SERVICE analysis:
  - Cùng infrastructure, nhưng query profile khác → latency khác
  - KHÔNG thể kết luận "hệ thống ổn" vì browse nhanh
  - Report chậm là vấn đề THẬT, dù browse vẫn nhanh
```

### Nghịch lý 3: "30 VUs peak mà iter/s không gấp 3 lần 10 VUs?"

```text
Learner hỏi: "Stage 1 avg 7 VUs → iter/s = 8.
             Stage 3 30 VUs → iter/s = 28.
             Sao không gấp 4.3 lần? (30/7 = 4.3× VUs, nhưng iter/s chỉ 28/8 = 3.5×)"

Trả lời: Vì iter/s không tuyến tính với VUs trong closed model.
Công thức iter/s = VUs / loop_duration chỉ đúng nếu loop_duration KHÔNG ĐỔI.

Nhưng khi tăng VUs:
  - Nhiều request đồng thời hơn → DB connection pool cạnh tranh
  - Nhiều transaction đồng thời → lock contention tăng
  - CPU/IO chia sẻ nhiều hơn → mỗi request chậm hơn
  → loop_duration TĂNG khi VUs tăng

Stage 1 (7 VUs): loop_duration = 7/8 = 0.875s
Stage 3 (30 VUs): loop_duration = 30/28 = 1.071s
→ loop_duration tăng 22% khi VUs tăng 4.3×

Đây là sub-linear scaling — ĐIỀU BÌNH THƯỜNG trong hệ thống thật.
KHÔNG kỳ vọng iter/s tuyến tính với VUs.
Đó là lý do cần chạy ramping-vus để đo SCALABILITY CURVE.
```

### Nghịch lý 4: "Stage 4 giảm VUs nhưng iter/s vẫn cao — lỗi à?"

```text
Learner hỏi: "Stage 4 target 8 VUs, nhưng iter/s vẫn ~15 trong mấy giây đầu.
             Sao iter/s không giảm ngay khi VUs giảm?"

Trả lời: Vì gracefulRampDown. Khi ramping-vus giảm VUs từ 30 xuống 8,
nó không kill VUs ngay lập tức. Nó chọn VUs để dừng, nhưng cho chúng
thời gian (gracefulRampDown = 20s) để hoàn tất iteration đang chạy.

Kết quả:
  - VU chart: VUs giảm nhanh (k6 deactivate VUs)
  - iter/s chart: iter/s giảm CHẬM HƠN (in-flight iterations finish)
  - Đây là BÌNH THƯỜNG, không phải lỗi

Ngược lại, nếu iter/s giảm NGAY LẬP TỨC khi VUs giảm:
  - Có thể gracefulRampDown = 0s → in-flight iterations bị kill
  - Hoặc loop quá ngắn → finish trước khi VU bị deactivate
```

## Code pattern cho case 07

### Cấu trúc script mixed production curve

```js
import { sleep } from "k6";
import http from "k6/http";
import { check } from "k6";
import { randomIntBetween } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

// ============================================================
// Weighted operation definitions
// ============================================================
const OPERATIONS = [
  {
    name: "production_curve_browse",
    weight: 50,
    service: "products-service",
    fn: () => {
      const res = http.get(`${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid`, {
        tags: {
          operation: "production_curve_browse",
          service: "products-service",
          endpoint: "products",
        },
      });
      check(res, {
        "browse status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "production_curve_cart_add",
    weight: 20,
    service: "cart-service",
    fn: () => {
      const payload = JSON.stringify({
        product_id: randomIntBetween(1, 100),
        quantity: randomIntBetween(1, 3),
      });
      const res = http.post(`${BASE_URL}/api/sim/cart/add`, payload, {
        headers: { "Content-Type": "application/json" },
        tags: {
          operation: "production_curve_cart_add",
          service: "cart-service",
          endpoint: "cart",
        },
      });
      check(res, {
        "cart_add status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "production_curve_auth_me",
    weight: 15,
    service: "auth-service",
    fn: () => {
      const res = http.get(`${BASE_URL}/api/sim/auth/me`, {
        tags: {
          operation: "production_curve_auth_me",
          service: "auth-service",
          endpoint: "auth",
        },
      });
      check(res, {
        "auth_me status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "production_curve_checkout",
    weight: 10,
    service: "order-service",
    fn: () => {
      const payload = JSON.stringify({ cart_id: `cart-${randomIntBetween(1, 30)}` });
      const res = http.post(`${BASE_URL}/api/sim/checkout`, payload, {
        headers: { "Content-Type": "application/json" },
        tags: {
          operation: "production_curve_checkout",
          service: "order-service",
          endpoint: "checkout",
        },
      });
      check(res, {
        "checkout status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "production_curve_report",
    weight: 5,
    service: "report-service",
    fn: () => {
      const res = http.get(`${BASE_URL}/api/sim/report?range=7d&format=summary`, {
        tags: {
          operation: "production_curve_report",
          service: "report-service",
          endpoint: "report",
        },
      });
      check(res, {
        "report status 200": (r) => r.status === 200,
      });
    },
  },
];

// ============================================================
// Weighted random selection
// ============================================================
function weightedRandom(choices) {
  const totalWeight = choices.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * totalWeight;
  for (const choice of choices) {
    r -= choice.weight;
    if (r <= 0) return choice;
  }
  return choices[choices.length - 1];
}

// ============================================================
// Scenario config
// ============================================================
export const options = {
  scenarios: {
    production_traffic_curve: {
      executor: "ramping-vus",
      startVUs: __ENV.RV_07_START_VUS ? parseInt(__ENV.RV_07_START_VUS) : 2,
      stages: [
        { duration: "60s", target: __ENV.RV_07_MID_VUS ? parseInt(__ENV.RV_07_MID_VUS) : 12 },
        { duration: "90s", target: __ENV.RV_07_PEAK_VUS ? parseInt(__ENV.RV_07_PEAK_VUS) : 30 },
        { duration: "150s", target: __ENV.RV_07_PEAK_VUS ? parseInt(__ENV.RV_07_PEAK_VUS) : 30 },
        { duration: "90s", target: __ENV.RV_07_LATE_VUS ? parseInt(__ENV.RV_07_LATE_VUS) : 8 },
        { duration: "45s", target: __ENV.RV_07_START_VUS ? parseInt(__ENV.RV_07_START_VUS) : 2 },
      ],
      gracefulRampDown: "20s",
      tags: {
        case_id: "rv-07-production-traffic-curve",
        business_case: "production_traffic_curve",
        workload: "staged_concurrency",
        executor_family: "ramping_vus",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.98"],
    http_req_failed: ["rate<0.02"],
  },
};

// ============================================================
// Main loop: each iteration = 1 random operation
// ============================================================
export default function () {
  const op = weightedRandom(OPERATIONS);

  // Gọi operation
  op.fn();

  // Think time giả lập user thật
  const sleepSeconds = parseFloat(__ENV.RV_07_SLEEP_SECONDS || "0.5");
  sleep(sleepSeconds);
}
```

### Giải thích các điểm quan trọng trong code

```text
1. Mỗi operation có tag `operation` và `service` RIÊNG:
   - Đây là cách duy nhất để breakdown metrics sau test
   - Thiếu tag → aggregate p95 che hết bottleneck
   - Tag `endpoint` thêm để nhóm API family

2. Weighted random dùng totalWeight:
   - Không cần total = 100
   - Có thể thêm operation mới mà không cần sửa weight khác

3. Mỗi iteration = 1 operation + 1 sleep:
   - Khác với case 01 (1 iteration = nhiều API trong flow)
   - Phù hợp để mỗi operation có latency độc lập
   - Mỗi loop là một "user action" riêng

4. sleep sau operation, không phải trước:
   - Mô phỏng user "nghĩ" sau khi xem kết quả
   - Nếu sleep trước → user "nghĩ" trước khi làm gì đó (kém thực tế hơn)

5. Env vars cho phép override không cần sửa code:
   - RV_07_START_VUS, RV_07_MID_VUS, RV_07_PEAK_VUS, RV_07_LATE_VUS
   - RV_07_DURATION_SCALE: scale stage duration
   - RV_07_SLEEP_SECONDS: thay đổi think time

6. Stages dùng absolute target:
   - Stage 1: target 12 (đi từ 2 lên 12)
   - Stage 2: target 30 (đi từ 12 lên 30)
   - Stage 3: target 30 (giữ 30 - plateau)
   - Stage 4: target 8 (đi từ 30 xuống 8)
   - Stage 5: target 2 (đi từ 8 xuống 2)
   - KHÔNG phải "add thêm 12 VUs" ở stage 2

7. gracefulRampDown = 20s:
   - Khi ramp-down (stage 4, 5), VUs được 20s để finish iteration
   - Đủ dài để checkout (có thể 5s) finish
   - Nếu quá ngắn → checkout bị kill giữa chừng → failed iterations
```

## Mở rộng

### Variation A: Thay đổi weight distribution để mô phỏng traffic pattern khác

```powershell
# Pattern "sale event": nhiều checkout hơn
# Sửa OPERATIONS array: checkout weight 10 → 25, browse 50 → 35
# (Cần sửa code, không phải env var)
```

```js
// Pattern "window shopping": gần như toàn bộ là browse
const OPERATIONS = [
  { name: "production_curve_browse",   weight: 70, ... },
  { name: "production_curve_cart_add", weight: 15, ... },
  { name: "production_curve_auth_me",  weight: 10, ... },
  { name: "production_curve_checkout", weight: 3,  ... },
  { name: "production_curve_report",   weight: 2,  ... },
];
```

```js
// Pattern "end-of-month reporting": nhiều report
const OPERATIONS = [
  { name: "production_curve_browse",   weight: 35, ... },
  { name: "production_curve_cart_add", weight: 15, ... },
  { name: "production_curve_auth_me",  weight: 10, ... },
  { name: "production_curve_checkout", weight: 10, ... },
  { name: "production_curve_report",   weight: 30, ... },
];
```

```js
// Pattern "auth heavy": login wave + session refresh
const OPERATIONS = [
  { name: "production_curve_browse",   weight: 35, ... },
  { name: "production_curve_cart_add", weight: 15, ... },
  { name: "production_curve_auth_me",  weight: 35, ... },
  { name: "production_curve_checkout", weight: 10, ... },
  { name: "production_curve_report",   weight: 5,  ... },
];
```

Mỗi pattern cho ra production curve khác nhau -> so sánh để hiểu traffic mix ảnh hưởng thế nào đến từng stage.

### Variation B: Tăng peak VUs để tìm capacity knee

```powershell
$env:RV_07_PEAK_VUS = 60
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

```text
So sánh 2 run:
  Run 1: peak 30 VUs → iter/s stage 3 = 35
  Run 2: peak 60 VUs → iter/s stage 3 = 48

  VUs tăng 2× nhưng iter/s chỉ tăng 1.37× → sub-linear scaling
  Saturation point nằm giữa 30 và 60 VUs

  Breakdown stage 3 run 2:
    checkout p95 = 8000ms (tăng từ 1800ms ở run 1)
    → Checkout là bottleneck, không phải browse

  => QUYẾT ĐỊNH: Capacity knee ở ~40-50 VUs.
     Để scale lên 60 VUs, cần tối ưu checkout/service trước.
```

### Variation C: Thay đổi stage durations

```powershell
# Chạy gần business timeline thật (không scale)
$env:RV_07_DURATION_SCALE = 1.0
k6 run -o cloud .\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js
```

```text
So sánh 2 run:
  Run 1: scale=0.25 → stage 3 = 38s → ~1500 samples
  Run 2: scale=1.0 → stage 3 = 150s → ~6000 samples

  Run 2 có sample lớn hơn → weight hội tụ tốt hơn
  Run 2 có thể phát hiện slow degradation trong stage 3 (leak)
  Run 1 nhanh hơn → phù hợp cho quick check

  Dùng run 1 cho dev loop, run 2 cho CI/release gate.
```

### Variation D: Thêm per-service latency thresholds

```js
export const options = {
  thresholds: {
    // Products service — browse phải nhanh
    "http_req_duration{operation:production_curve_browse}":   ["p(95)<300"],

    // Cart service
    "http_req_duration{operation:production_curve_cart_add}": ["p(95)<500"],

    // Auth service
    "http_req_duration{operation:production_curve_auth_me}":  ["p(95)<300"],

    // Order service — relaxed vì có external call
    "http_req_duration{operation:production_curve_checkout}": ["p(95)<3000"],

    // Report service — relaxed vì aggregation query
    "http_req_duration{operation:production_curve_report}":   ["p(95)<2000"],
  },
};
```

Lưu ý: threshold khác nhau cho từng service vì latency profile khác nhau. Không dùng chung một con số. Checkout được relaxed hơn browse vì có external dependency.

### Variation E: Multi-scenario — production curve + constant baseline cùng lúc

```js
scenarios: {
  // Production curve 2->12->30->8->2
  production_curve: {
    executor: "ramping-vus",
    startVUs: 2,
    stages: [
      { duration: "60s", target: 12 },
      { duration: "90s", target: 30 },
      { duration: "150s", target: 30 },
      { duration: "90s", target: 8 },
      { duration: "45s", target: 2 },
    ],
    tags: { case_id: "rv-07-curve", workload: "staged_concurrency" },
  },
  // Baseline 30 VUs phẳng để so sánh
  baseline: {
    executor: "constant-vus",
    vus: 30,
    duration: "5m",
    startTime: "435s",  // Start sau khi production curve xong
    tags: { case_id: "cv-07-baseline", workload: "steady_concurrency" },
  },
},
```

Chạy 1 lần, có cả production curve và baseline phẳng -> so sánh peak stage (30 VUs staged) với baseline phẳng (30 VUs constant) để thấy khác biệt giữa staged và steady.

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm.
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Kết luận "products-service chậm" khi iter/s giảm ở peak nhưng checkout p95 mới là nguyên nhân.
- Bỏ qua tag `operation` và `service` — không breakdown được thì không debug được.
- Đặt threshold latency giống nhau cho tất cả operation (checkout tự nhiên chậm hơn browse).
- Dùng case 07 để claim "hệ thống chịu được X users" — đây là production curve test, không phải capacity test.
- Fail test vì operation mix không khớp chính xác weight ở stage 1 (sample nhỏ, weight chưa hội tụ).
- So sánh iter/s giữa 2 stage khác VUs rồi kết luận "stage 3 chậm" mà không normalize theo VUs.
- Bỏ qua cross-stage comparison — mỗi stage là một observation window, phải so sánh giữa chúng.
- Không kiểm tra recovery ở stage 4 — nếu latency không giảm về mức stage 1-2, có thể có resource leak.

## Checklist đọc case 07

```text
1. Summary verification
   - checks > 98%?
   - http_req_failed < 2%?
   - ramping_active_iterations_failed < 50?
   - VUs đi theo shape 2->12->30->8->2?
   - vus_max ≈ 30?

2. Operation latency breakdown (QUAN TRỌNG NHẤT)
   - Đã filter http_req_duration theo operation chưa?
   - Operation nào p95 cao nhất?
   - Operation p95 cao có weight thấp không? (noisy neighbor check)
   - Drag contribution: weight × p95 cho từng operation?
   - Operation nào drag cao nhất?

3. Cross-stage latency comparison (RIÊNG CASE 07)
   - Đã so sánh p95 CÙNG operation giữa stage 2 và stage 3 chưa?
   - Operation nào tăng mạnh nhất ở stage 3?
   - Operation nào ổn định qua các stage?
   - Recovery ở stage 4: p95 có về mức stage 1-2 không?

4. Throughput analysis PER STAGE
   - iter/s ở mỗi stage?
   - Expected iter/s tính từ weighted latency + sleep?
   - Actual có gần expected không?
   - iter/s/VU có giảm ở stage 3 không? (saturation signal)

5. Operation mix
   - Counts có approximate weights không?
   - Nếu lệch > 10% ở stage 3 → script bug hoặc operation fail bias?
   - Operation mix có thay đổi giữa các stage không?

6. VU shape verification
   - VUs có theo đúng 2->12->30->8->2 không?
   - Stage transitions có mượt không?
   - gracefulRampDown có hoạt động không? (tail iterations ở stage 4-5)

7. Business decision
   - Production curve đã pass chưa?
   - Service nào cần route vấn đề?
   - Bottleneck service nào ở peak?
   - Saturation point ở đâu?
   - Sẵn sàng cho capacity test (constant-arrival-rate) chưa?
```

Kết luận của run case 07 đúng nếu thấy:

```text
VUs đi theo shape 2->12->30->8->2
vus_max gần peak target (30)
checks > 98%
http_req_failed < 2%
ramping_active_iterations_failed < 50
executor = ramping-vus
scenario = production_traffic_curve
Có breakdown http_req_duration theo operation
Có so sánh latency giữa các stage (đặc biệt stage 2 vs stage 3)
Operation mix approximate weights
Đã xác định service nào là bottleneck ở peak (nếu có)
Đã ghi nhận production curve numbers cho comparison sau này
```

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-07-production-traffic-curve.js`
- Constant-vus mixed baseline (compare): `../constant-vus/07_production-mixed-baseline.md`
- Case 01 daily traffic curve: `./01_daily-traffic-curve.md`
