# Case 07: Production mixed baseline

## Tình huống thực tế

Platform/performance cần một baseline closed-model trước khi so với ramping hoặc arrival-rate tests.

Case này trộn products/cart/order/report để tạo steady production-ish active users trong 5 phút.

Mục tiêu là biết 30 active mixed users tạo ra latency/RPS tự nhiên thế nào, và service nào kéo baseline.

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 30
Duration: 5m
Think time: 0.5s
Team/service focus: platform/performance
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 30 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

### Vị trí của case này trong bộ 7 case constant-vus

Case 07 là case **cuối cùng và tổng hợp nhất** trong series constant-vus. Nó không dạy một service riêng lẻ như các case trước, mà dạy cách đọc một mixed production baseline — nơi 5 service cùng chạy trong cùng một test, mỗi service có latency profile và weight khác nhau.

Bảng so sánh vị trí:

| Case | Focus | Số service | Độ phức tạp phân tích |
| --- | --- | --- | --- |
| 01 storefront | products/cart/order flow đơn giản | 2-3 | Thấp |
| 02 session | auth keepalive | 1 | Thấp |
| 03 cart editing | write-heavy cart | 1 | Trung bình |
| 04 checkout trickle | order/external | 1 | Trung bình |
| 05 personalized feed | products personalization | 1 | Trung bình |
| 06 backoffice reports | report async | 1 | Trung bình |
| **07 mixed baseline** | **mixed 5-service weighted** | **5** | **Cao nhất** |

Case 07 là nơi learner học kỹ năng quan trọng nhất của constant-vus: **đọc một test có nhiều service với weight khác nhau, không bị aggregate metrics đánh lừa**.

## Yêu cầu cứng của case này

- Giữ 30 active mixed users trong 5m.
- Weighted mix phải đọc bằng operation tags.
- Không dùng case này để claim max RPS target.
- Failed loops phải dưới `constant_active_iterations_failed count<30`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

## Vì sao "Production mixed baseline" nên dùng `constant-vus`?

Mixed baseline là nơi constant-vus sáng nhất: giữ active users cố định, quan sát natural throughput và service bottlenecks trước khi chuyển sang ramp/arrival-rate.

Mental model:

```text
30 active VUs start.
Each VU loops the user flow until 5m ends.
A loop finishes -> same VU starts the next loop.
Total completed loops depend on loop duration.
```

Nếu backend nhanh:

```text
loop_duration giảm -> mỗi VU chạy nhiều loops hơn -> iter/s/RPS tăng
```

Nếu backend chậm:

```text
loop_duration tăng -> mỗi VU chạy ít loops hơn -> iter/s/RPS giảm
```

Đây là lý do gọi là closed model.

### Tại sao mixed baseline lại cần constant-vus hơn bất kỳ case nào khác?

Case 07 khác biệt ở chỗ nó có **5 service với latency profile khác nhau**. Nếu dùng arrival-rate:

```text
constant-arrival-rate với target RPS cố định:
  - Luôn bơm đúng X request/s, bất kể backend chậm hay nhanh
  - Nếu checkout service chậm, k6 vẫn bơm đủ rate → queue ở checkout
  - KHÔNG thấy được "khi checkout chậm, products throughput tự nhiên giảm"
  - Đây là open model logic, không giống production thật
```

Nếu dùng ramping-vus:

```text
ramping-vus với VUs tăng dần:
  - Mỗi stage có số VU khác nhau → không có baseline phẳng
  - Khó so sánh latency ở mỗi mức concurrency
  - Phù hợp cho stress test, không phải baseline reference
```

Constant-vus cho mixed baseline vì:

```text
1. Concurrency phẳng = 30 → baseline ổn định, dễ so sánh với run sau
2. Closed model → nếu checkout chậm, toàn bộ throughput giảm → tín hiệu thật
3. Weighted mix → mỗi VU chạy random branch → phân phối gần đúng weight
4. Duration cố định → observation window nhất quán giữa các run
5. KHÔNG có target RPS → không bị áp lực "phải đạt X RPS"
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho case steady active users? |
| --- | --- | --- |
| `constant-vus` | Giữ N active users trong duration T | **Đúng**: input chính là concurrency + observation window; throughput là output tự nhiên. |
| `shared-iterations` | Cũng có nhiều VU cùng làm việc | Sai nếu không có backlog hữu hạn cần drain đủ; nó tối ưu fixed total jobs, không phải active users over time. |
| `per-vu-iterations` | VU có thể là user identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng; nó biến test thành quota replay, không phải steady active pool. |
| `constant-arrival-rate` | Có thể giữ RPS cố định | Sai nếu muốn quan sát closed-model backpressure; arrival-rate sẽ cố bơm traffic theo rate. |
| `ramping-vus` | Mô phỏng user tăng/giảm | Sai nếu requirement là active concurrency phẳng để lấy baseline. |
| `ramping-arrival-rate` | Mô phỏng campaign/surge | Sai cho steady baseline; nó thay đổi target arrivals theo thời gian. |

Kết luận cho case này:

```text
Need fixed active users over time -> constant-vus.
Need fixed total jobs -> shared-iterations, not this case.
Need fixed per-user quota -> per-vu-iterations, not this case.
Need fixed RPS -> constant-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
CV_07_VUS = 30
CV_07_DURATION = 5m
CV_07_SLEEP_SECONDS = 0.5

product list 45%
product detail 25%
cart add 15%
checkout 5%
report 10%
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_07_VUS` | 30 | Số active mixed users |
| `CV_07_DURATION` | 5m | Observation window |
| `CV_07_SLEEP_SECONDS` | 0.5 | Think time giữa mixed actions |

Weighted mix expected:

| Branch | Weight |
| --- | --- |
| product list | 45% |
| product detail | 25% |
| cart add | 15% |
| checkout | 5% |
| report | 10% |

### Tại sao weight được chọn như vậy?

Weight mô phỏng một production e-commerce điển hình:

```text
Products endpoints (list 45% + detail 25% = 70%):
  - Đây là phần lớn traffic của một storefront
  - User duyệt sản phẩm nhiều hơn là mua
  - Products-service nhận ~70% request volume

Cart (15%):
  - Không phải user nào cũng thêm vào cart
  - Nhưng đủ để tạo write traffic ổn định

Checkout (5%):
  - Tỉ lệ chuyển đổi thấp là thực tế
  - Nhưng checkout thường là operation chậm nhất (external payment, inventory)
  - 5% weight nhưng có thể chiếm 30-50% contribution vào p95

Report (10%):
  - Một số user xem report/summary
  - Report query thường nặng (aggregation, JOIN)
  - 10% weight nhưng latency contribution có thể cao
```

Điểm mấu chốt: **weight quyết định COUNT, không quyết định LATENCY contribution**. Một branch 5% weight có latency 2000ms sẽ kéo p95 mạnh hơn branch 45% weight có latency 100ms.

Threshold cap riêng:

```text
constant_active_iterations_failed: count<30
```

## Technical semantics: active user pool, loop identity, closed model

Trong constant-vus:

```text
__VU / exec.vu.idInTest = active user identity tương đối ổn định
__ITER                  = loop counter của riêng VU đó
exec.scenario.iterationInTest = global loop counter, không phải backlog job id
```

Một VU có thể chạy nhiều loops trong duration. Nhưng không có quota kiểu:

```text
mỗi VU phải chạy đúng N loops
```

Nếu cần quota per user, dùng `per-vu-iterations`.

Nếu cần fixed global job list, dùng `shared-iterations`.

### Identity model cho mixed baseline: mỗi VU là một mixed user

Trong case 07, identity model phức tạp hơn các case single-service:

```text
VU 1 = mixed user 1
  Loop 1: user 1 -> product list (45% chance)
  Loop 2: user 1 -> cart add (15% chance)
  Loop 3: user 1 -> product detail (25% chance)
  Loop 4: user 1 -> checkout (5% chance)
  Loop 5: user 1 -> report (10% chance)
  ...

VU 2 = mixed user 2
  Loop 1: user 2 -> product list (45% chance)
  ...

Mỗi VU = một user identity ổn định
Nhưng mỗi loop của user đó = một operation NGẪU NHIÊN theo weight
```

Điều này khác với case 01 storefront (mỗi loop = 1 flow cố định: list -> detail -> cart). Ở đây, mỗi loop CHỈ làm 1 operation, và operation được chọn theo weighted random.

Lý do thiết kế này:

```text
1. Mô phỏng user thật: user không làm tất cả mọi thứ mỗi lần
   - Lần này duyệt sản phẩm, lần sau thêm cart, lần khác checkout

2. Tạo weighted mix tự nhiên qua nhiều loop:
   - Sau 100 loops, ~45 là product list, ~25 là product detail, ...
   - Phân phối hội tụ về weight khi số loop đủ lớn

3. Mỗi operation đo latency ĐỘC LẬP:
   - Checkout latency không bị "pha loãng" bởi products latency trong cùng loop
   - Dễ breakdown theo operation tag
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
  { name: "baseline_product_list",   weight: 45, fn: productList },
  { name: "baseline_product_detail", weight: 25, fn: productDetail },
  { name: "baseline_cart_add",       weight: 15, fn: cartAdd },
  { name: "baseline_checkout",       weight: 5,  fn: checkout },
  { name: "baseline_report",         weight: 10, fn: report },
];

export default function () {
  const op = weightedRandom(OPERATIONS);
  op.fn();  // Gọi operation được chọn
  sleep(0.5);
}
```

Sau 5 phút với 30 VU, nếu avg loop ~0.7s:

```text
total loops ≈ (30 × 300s) / 0.7s ≈ 12,857 loops
product list:     ~5,786 (45%)
product detail:   ~3,214 (25%)
cart add:         ~1,929 (15%)
checkout:         ~643   (5%)
report:           ~1,286 (10%)
```

## Technical root causes this case catches

Case này có 5 root causes — nhiều nhất trong toàn bộ series constant-vus. Mỗi root cause là một lớp insight về mixed closed-model testing.

### Nguyên nhân kỹ thuật 1: Product endpoints dominate request volume

45% + 25% mix nghĩa là products-service thường chiếm nhiều count nhất.

**Phân tích sâu**:

```text
Trên dashboard:
  http_reqs breakdown theo operation:
    baseline_product_list:   ~5,786 requests
    baseline_product_detail: ~3,214 requests
    baseline_cart_add:       ~1,929 requests
    baseline_report:         ~1,286 requests
    baseline_checkout:       ~643 requests

  Products-service tổng: 5,786 + 3,214 = 9,000 requests (~70%)
  Các service khác tổng: 1,929 + 1,286 + 643 = 3,858 requests (~30%)
```

Điều này có nghĩa:

```text
Nếu http_req_duration aggregate p95 = 500ms:
  - Rất có thể p95 này bị products-service kéo (vì nó chiếm 70% sample)
  - Checkout có thể p95 = 3000ms nhưng chỉ 5% sample → aggregate p95 vẫn 500ms
  - AGGREGATE P95 CHE BOTTLENECK CỦA CHECKOUT

  → LUÔN LUÔN breakdown theo operation. Aggregate không đủ cho mixed test.
```

Hành động khi đọc:

```text
1. Xem http_req_duration aggregate → cảm nhận ban đầu
2. Filter theo operation=baseline_product_list → products latency
3. Filter theo operation=baseline_checkout → checkout latency
4. So sánh: nếu checkout p95 >> aggregate p95 → bottleneck bị che
```

### Nguyên nhân kỹ thuật 2: Checkout/report may dominate latency

Dù checkout chỉ 5% và report 10%, chúng có thể kéo p95/max do external/report cost.

**Phân tích sâu — vì sao branch nhỏ lại kéo latency toàn test**:

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
```

Demo đóng góp latency theo weight và latency:

```text
Giả sử latency mỗi operation:
  baseline_product_list:   avg=100ms, p95=200ms  (weight 45%)
  baseline_product_detail: avg=120ms, p95=250ms  (weight 25%)
  baseline_cart_add:       avg=150ms, p95=300ms  (weight 15%)
  baseline_checkout:       avg=1800ms, p95=3000ms (weight 5%)
  baseline_report:         avg=800ms, p95=1500ms (weight 10%)

Aggregate avg (weighted):
  = 0.45×100 + 0.25×120 + 0.15×150 + 0.05×1800 + 0.10×800
  = 45 + 30 + 22.5 + 90 + 80
  = 267.5ms

Aggregate p95: ~KHÔNG tính được bằng weighted average đơn giản~
  Vì p95 là percentile của tất cả sample, không phải average của p95.
  Nhưng chắc chắn checkout 3000ms sẽ xuất hiện trong p95 aggregate
  vì 5% sample checkout + 10% sample report đủ để đẩy p95 lên.

Aggregate p95 — ước lượng thô:
  95% sample nhanh nhất ≤ X
  5% sample chậm nhất > X
  checkout (5%) + report (10%) = 15% sample "chậm"
  → aggregate p95 nằm đâu đó trong khoảng report p95 (1500ms)
  → checkout max (3000ms) nằm ở p99+
```

Kết luận:

```text
Dù checkout chỉ 5% weight, latency 3000ms của nó:
  - Kéo aggregate p95 lên (có thể từ ~250ms lên ~800ms+)
  - Kéo aggregate max lên 3000ms+
  - Nhưng quan trọng hơn: kéo LOOP DURATION của VU nào hit checkout
```

Hành động:

```text
1. Đừng nhìn aggregate p95 rồi kết luận "hệ thống chậm"
2. Breakdown: products p95=200ms (OK), checkout p95=3000ms (cần điều tra)
3. Route vấn đề về đúng service owner: order-service, không phải products-service
4. Nếu checkout p95 cao, hỏi: external payment, DB lock, hay inventory check?
```

### Nguyên nhân kỹ thuật 3: Aggregate p95 hides service-specific bottlenecks

Mixed aggregate chỉ là dấu hiệu ban đầu; phải breakdown theo operation/service.

**Phân tích sâu — demo aggregate che bottleneck**:

```text
Scenario A: Tất cả service khỏe
  products: p95=200ms
  cart:     p95=250ms
  checkout: p95=500ms
  report:   p95=400ms
  → Aggregate p95 ≈ 350ms (hợp lý)

Scenario B: Checkout bị chậm (external payment timeout)
  products: p95=200ms (vẫn khỏe)
  cart:     p95=250ms (vẫn khỏe)
  checkout: p95=5000ms (external timeout!)
  report:   p95=400ms (vẫn khỏe)
  → Aggregate p95 ≈ 450ms (chỉ tăng 100ms so với Scenario A!)

  TẠI SAO? Vì checkout chỉ 5% sample → 95% sample vẫn nhanh
  → Aggregate p95 = 450ms → nhìn có vẻ "hơi chậm, không nghiêm trọng"
  → NHƯNG checkout p95 = 5000ms → ORDER-SERVICE ĐANG GẶP VẤN ĐỀ NGHIÊM TRỌNG
  → Nếu chỉ nhìn aggregate, MISS hoàn toàn vấn đề!
```

Bài học:

```text
Aggregate p95 trong mixed test = CON SỐ VÔ NGHĨA nếu không breakdown.
Nó là trung bình có trọng số của các phân phối khác nhau → luôn bị kéo
về phía operation có nhiều sample nhất (products 70%).

Quy tắc cho mixed test:
  1. LUÔN breakdown http_req_duration theo operation
  2. MỖI operation có p95 riêng
  3. Operation p95 cao nhất = bottleneck thật
  4. Aggregate p95 chỉ dùng để trending (so sánh run này với run trước)
```

### Nguyên nhân kỹ thuật 4: Baseline before comparison

Có closed-model baseline thì khi chạy ramping/arrival-rate sau này mới biết thay đổi do shape hay do backend.

**Phân tích sâu — baseline philosophy cho case 07**:

Case 07 là **điểm tham chiếu** cho mọi test performance tiếp theo. Không có nó, bạn không thể trả lời các câu hỏi:

```text
Câu hỏi 1: "Ramping-vus 30→60→90, iter/s tăng thế nào?"
  Nếu không có baseline 30 VUs phẳng:
    - Không biết ở 30 VUs, natural throughput là bao nhiêu
    - Không biết throughput ở 60 VUs gấp mấy lần 30 VUs
    - Không biết scalability có sub-linear không

  CÓ baseline:
    - Baseline 30 VUs → iter/s = 42 (ví dụ)
    - Ramping 60 VUs → iter/s = 70 (không gấp đôi! sub-linear scaling)
    - Ramping 90 VUs → iter/s = 88 (gần bão hòa)
    → Kết luận: hệ thống bắt đầu bão hòa ở ~60-70 VUs

Câu hỏi 2: "Constant-arrival-rate target 50 RPS, hệ thống chịu được không?"
  Nếu không có baseline:
    - Không biết ở 30 VUs tự nhiên, hệ thống tạo ra bao nhiêu RPS
    - Nếu baseline RPS = 40, target 50 RPS là cao hơn năng lực tự nhiên
    - Có thể cần thêm VUs (tăng maxVUs) hoặc chấp nhận drop

  CÓ baseline:
    - Baseline RPS = 42 (tự nhiên ở 30 VUs)
    - Target 50 RPS → cần ~36 VUs (50/42 × 30) để đạt
    - Nếu arrival-rate test drop → biết là do thiếu VUs, không phải backend fail

Câu hỏi 3: "Latency regression là do code hay do test shape khác?"
  Nếu không có baseline:
    - Chạy ramping-vus → p95 checkout = 5000ms
    - Không biết 5000ms là bình thường ở 30 VUs hay là regression

  CÓ baseline:
    - Baseline 30 VUs → p95 checkout = 1800ms
    - Ramping 30→60→90, ở stage 30 VUs → p95 checkout = 1900ms (tương đương)
    - Ở stage 60 VUs → p95 checkout = 3500ms (tăng do contention)
    → Biết chính xác regression bắt đầu ở mức concurrency nào
```

**Quy trình chuẩn cho performance testing với baseline**:

```text
Bước 1: Chạy case 07 (constant-vus, 30 VUs, 5m)
  → Lấy baseline: natural throughput, latency per operation, error rate

Bước 2: Chạy ramping-vus (30→60→90 VUs)
  → So sánh với baseline: throughput scaling, latency increase per stage

Bước 3: Chạy constant-arrival-rate (target RPS = baseline RPS × 1.2)
  → Kiểm tra: hệ thống có giữ được target RPS không?
  → Drop rate, latency increase ở target RPS

Bước 4: Chạy constant-arrival-rate (target RPS = baseline RPS × 1.5)
  → Stress test: tìm breaking point

Không có bước 1, tất cả bước sau đều thiếu ngữ cảnh.
```

### Nguyên nhân kỹ thuật 5: One slow service reduces whole-loop throughput

Trong mixed loop, một branch chậm làm VUs bị giữ lâu hơn và natural throughput giảm.

Đây là insight **quan trọng nhất** của case 07 — "noisy neighbor" effect trong closed model. Cần phân tích riêng một section lớn.

---

## SERVICE INTERACTION ANALYSIS — "Noisy Neighbor" trong closed model

Đây là phần độc nhất của case 07, không có ở bất kỳ case constant-vus nào khác. Khi 5 service cùng chia sẻ một pool 30 VUs trong closed model, một service chậm sẽ kéo throughput của TẤT CẢ các service khác.

### Setup demo

Giả sử backend có latency profile như sau:

```text
baseline_product_list:   avg=100ms  (weight 45%)
baseline_product_detail: avg=120ms  (weight 25%)
baseline_cart_add:       avg=150ms  (weight 15%)
baseline_checkout:       avg=2000ms (weight 5%)
baseline_report:         avg=800ms  (weight 10%)

sleep giữa các loop: 500ms
```

### Tính expected loop duration

```text
Không có sleep:
  avg_loop = 0.45×100 + 0.25×120 + 0.15×150 + 0.05×2000 + 0.10×800
           = 45 + 30 + 22.5 + 100 + 80
           = 277.5ms

Có sleep 500ms:
  avg_loop = 277.5 + 500 = 777.5ms

Expected iter/s:
  iter/s ≈ vus / avg_loop
         ≈ 30 / 0.7775
         ≈ 38.6 iter/s

Expected RPS (mỗi iter = 1 request trong case này):
  RPS ≈ 38.6 (vì mỗi loop là 1 operation)
```

### Phân tích: Checkout contribution vào loop duration

```text
Checkout chỉ 5% weight, nhưng contribution vào loop duration:
  Checkout contribution = 0.05 × 2000ms = 100ms
  Tổng avg_loop (chưa sleep) = 277.5ms
  → Checkout đóng góp 100/277.5 = 36% loop duration!

Trong khi products (list + detail = 70% weight):
  Products contribution = 45 + 30 = 75ms
  → Products đóng góp 75/277.5 = 27% loop duration

Kết luận gây sốc:
  Checkout 5% weight → 36% loop duration contribution
  Products 70% weight → 27% loop duration contribution

  CHECKOUT KÉO LOOP DURATION MẠNH HƠN PRODUCTS DÙ CHỈ BẰNG 1/14 VỀ COUNT!
```

### Scenario: Checkout external bị chậm (degraded)

```text
Bình thường:
  checkout avg = 2000ms
  avg_loop = 777.5ms
  iter/s ≈ 38.6

Checkout external gặp vấn đề (payment gateway timeout):
  checkout avg = 5000ms (tăng 3000ms)

  avg_loop mới:
    = 0.45×100 + 0.25×120 + 0.15×150 + 0.05×5000 + 0.10×800 + 500
    = 45 + 30 + 22.5 + 250 + 80 + 500
    = 927.5ms

  iter/s mới:
    = 30 / 0.9275 ≈ 32.3 iter/s

  Throughput drop:
    = (38.6 - 32.3) / 38.6 ≈ 16.3% giảm
```

### Sốc hơn: Products throughput cũng giảm dù products service KHÔNG thay đổi!

```text
Products-service latency vẫn 100ms/120ms (hoàn toàn bình thường).
Nhưng tổng iter/s giảm từ 38.6 xuống 32.3.

Số product list requests trước đây (trong 5 phút):
  = 38.6 iter/s × 300s × 45% = 5,211 requests

Số product list requests sau khi checkout chậm:
  = 32.3 iter/s × 300s × 45% = 4,361 requests

Products throughput drop = (5211 - 4361) / 5211 ≈ 16.3%

PRODUCTS-SERVICE KHÔNG THAY ĐỔI, nhưng products throughput giảm 16.3%!
```

**Đây là "noisy neighbor" effect trong closed model**:

```text
1. Checkout service chậm (vấn đề của order-service)
2. Mỗi lần một VU hit checkout → VU đó bị giữ 5000ms thay vì 2000ms
3. Trong 5000ms đó, VU KHÔNG THỂ chạy loop khác (kể cả product list)
4. 30 VUs, checkout 5% → trung bình 1.5 VU luôn đang ở checkout
5. Khi checkout chậm, 1.5 VU đó bị giữ lâu hơn → giảm effective pool size
6. 28.5 VUs còn lại vẫn phải phục vụ TOÀN BỘ traffic
7. → Tổng iter/s giảm → TẤT CẢ operation đều giảm throughput

Products team nhìn dashboard: "Sao products throughput tụt? Code bọn tao đâu có đổi?"
→ Câu trả lời: checkout kéo cả test xuống. Đây là systemic effect, không phải products bug.
```

### Minh họa bằng trace 5 VUs trong 15 giây

```text
5 VUs, mỗi loop = 1 operation (weighted random) + 0.5s sleep
Bỏ qua sleep để thấy rõ effect.

T=0.0s:  5 VUs cùng start
  VU=1: checkout   (2000ms) ← bị giữ lâu
  VU=2: product_list (100ms)
  VU=3: product_detail (120ms)
  VU=4: product_list (100ms)
  VU=5: report (800ms)

T=0.1s: VU=2 xong → loop 2: cart_add (150ms)
         VU=4 xong → loop 2: product_list (100ms)

T=0.2s: VU=2 xong → loop 3: product_detail (120ms)
         VU=4 xong → loop 3: product_list (100ms)

T=0.3s: VU=2 xong → loop 4: product_list (100ms)
         VU=4 xong → loop 4: report (800ms) ← bị giữ

T=0.4s: VU=2 xong → loop 5: product_list (100ms)
T=0.5s: VU=2 xong → loop 6: product_list (100ms)
...

T=0.8s: VU=5 xong (report)
T=1.1s: VU=4 xong (report)

T=2.0s: VU=1 xong (checkout) ← MÃI TỚI 2 GIÂY MỚI XONG!

Tổng kết 2 giây đầu:
  VU=1: 1 loop  (bị checkout giữ)
  VU=2: ~15 loops (toàn product_list/product_detail/cart — nhanh)
  VU=3: ~12 loops
  VU=4: ~4 loops (bị report giữ 1 lần)
  VU=5: ~2 loops (bị report giữ)

Tổng loops trong 2s: 1+15+12+4+2 = 34 loops
→ iter/s = 17

Nếu checkout vẫn 2000ms nhưng tất cả VU đều product_list (100ms):
  5 VUs × (2000ms / 100ms) = 100 loops trong 2s
  → iter/s = 50

Checkout làm iter/s giảm 66% (từ 50 xuống 17) trong trace này!
```

### Hệ quả thực tế cho người đọc dashboard

```text
Khi thấy iter/s thấp hơn mong đợi:

1. ĐỪNG kết luận "k6 không bơm đủ" — constant-vus không có target RPS

2. ĐỪNG kết luận "products-service chậm" nếu products p95 vẫn thấp
   → Products có thể vẫn nhanh, nhưng checkout/report kéo iter/s

3. HÃY breakdown theo operation:
   - Nếu checkout p95 tăng → đó là nguyên nhân
   - Nếu report p95 tăng → đó là nguyên nhân
   - Nếu TẤT CẢ p95 tăng → vấn đề systemic (network, DB, infra)

4. HÃY so sánh với baseline trước đó:
   - Nếu baseline cũ có iter/s = 42, run này = 32
   - Check operation p95: operation nào tăng?
   - Operation đó là root cause

5. HÃY tính expected iter/s từ operation latency:
   - avg_loop = weighted_avg(latency) + sleep
   - expected iter/s = vus / avg_loop
   - Nếu actual << expected → có thể có vấn đề khác (network, DNS, connection)
```

### Demo tính toán ngược từ actual iter/s để tìm operation chậm

```text
Actual iter/s = 35 (từ dashboard)
VUs = 30
→ actual avg_loop = 30 / 35 = 0.857s

Biết sleep = 0.5s
→ actual avg API time = 0.857 - 0.5 = 0.357s = 357ms

So với expected API time (khi tất cả service khỏe):
  expected API time = 0.45×100 + 0.25×120 + 0.15×150 + 0.05×500 + 0.10×400
                    = 45 + 30 + 22.5 + 25 + 40 = 162.5ms

357ms >> 162.5ms → có operation nào đó chậm hơn expected

Check từng operation p95:
  products: p95=200ms → OK, gần expected
  cart:     p95=300ms → OK
  checkout: p95=4000ms → ĐÂY! Checkout chậm gấp 8 lần expected (500ms)
  report:   p95=600ms → hơi cao nhưng không phải nguyên nhân chính

→ Kết luận: checkout service đang có vấn đề, kéo avg_loop từ 162ms lên 357ms
→ Hành động: route vấn đề về order-service team
```

---

## BASELINE PHILOSOPHY — Vì sao case này tồn tại

Case 07 không phải là một test pass/fail thông thường. Nó là một **reference point** — một cái neo để so sánh mọi test performance sau này.

### Mục đích tồn tại của baseline

```text
Baseline = "đo đạc tự nhiên, không can thiệp"
         = "hệ thống hoạt động thế nào khi 30 users dùng bình thường?"

Nó trả lời:
  - Ở 30 active users, natural throughput là bao nhiêu?
  - Operation nào vốn đã chậm (không phải do load)?
  - Error rate tự nhiên là bao nhiêu?
  - Loop duration trung bình là bao nhiêu?

Nó KHÔNG trả lời:
  - Hệ thống chịu được bao nhiêu users? (cần ramping-vus)
  - Hệ thống giữ được RPS target không? (cần constant-arrival-rate)
  - Hệ thống có regression không? (cần so sánh 2 baseline)
```

### Baseline như một phần của performance testing pipeline

```text
Performance testing pipeline cho một service:

Step 1: BASELINE (case 07 — constant-vus)
  - Mục tiêu: Đo natural behavior
  - Câu hỏi: "Hệ thống chạy thế nào ở 30 active users?"
  - Output: natural RPS, latency per operation, error rate
  - Pass/fail: KHÔNG CÓ (đây là reference, không phải gate)

Step 2: SCALABILITY (ramping-vus)
  - Mục tiêu: Đo throughput scaling theo concurrency
  - Câu hỏi: "Tăng users lên 60/90 thì throughput tăng thế nào?"
  - Output: scalability curve, saturation point
  - Pass/fail: so với baseline — sub-linear scaling là tín hiệu cần điều tra

Step 3: CAPACITY (constant-arrival-rate)
  - Mục tiêu: Đo khả năng giữ target RPS
  - Câu hỏi: "Hệ thống giữ được target RPS = baseline × 1.5 không?"
  - Output: drop rate, latency at target RPS
  - Pass/fail: drop rate < 1%, latency không tăng quá 2× baseline

Step 4: SOAK/STABILITY (constant-vus, long duration)
  - Mục tiêu: Phát hiện memory leak, resource exhaustion
  - Câu hỏi: "Sau 30 phút, latency có tăng không?"
  - Output: latency trend over time, resource usage
  - Pass/fail: latency không tăng quá 20% so với đầu test
```

Không có Step 1, bạn không thể đánh giá Step 2-4 một cách có ý nghĩa.

### Baseline không có pass/fail — và đó là điều đúng

```text
Nhiều learner hỏi: "Sao baseline không có pass/fail rõ ràng?"

Trả lời: Vì baseline là CÂY THƯỚC, không phải CÁI CỔNG.

Cây thước: đo xem dài bao nhiêu → không có "đúng/sai"
Cái cổng: thấp hơn X thì không được vào → có pass/fail

Baseline = cây thước:
  - Đo natural RPS = 42
  - Đo p95 checkout = 1800ms
  - Đo error rate = 0.1%

  Những con số này không "đúng" hay "sai".
  Chúng là SỰ THẬT của hệ thống ở 30 active users.

  Pass/fail chỉ xuất hiện khi SO SÁNH:
    - Run sau p95 checkout = 5000ms → FAIL (tăng 2.8× so với baseline)
    - Run sau RPS = 42 (giống baseline) → PASS (ổn định)
```

Khi nào baseline có thể "fail":

```text
1. Checks fail (status code, response body) → script/service bug
2. http_req_failed > 1% → network/infra issue
3. constant_active_iterations_failed > 30 → business flow broken
4. VUs không flat → config/dashboard issue

Nhưng latency hay RPS không bao giờ là pass/fail của baseline.
Chúng là DATA, không phải JUDGMENT.
```

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| baseline_product_list | products-service | GET | /api/sim/products | 200 | Product list branch. |
| baseline_product_detail | products-service | GET | /api/sim/products/:id | 200 | Product detail branch. |
| baseline_cart_add | cart-service | POST | /api/sim/cart/add | 200 | Cart add branch. |
| baseline_checkout | order-service | POST | /api/sim/checkout | 200 | Checkout branch. |
| baseline_report | report-service | GET | /api/sim/report | 200 | Report branch. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

### Đặc điểm latency của từng operation

```text
baseline_product_list (45%):
  - GET request, thường có cache
  - Query: SELECT products với limit, sort, filter
  - Expected latency: thấp nhất trong 5 operation
  - Risk: cache miss, full table scan nếu thiếu index

baseline_product_detail (25%):
  - GET request, có thể JOIN với reviews, inventory
  - Query: SELECT single product + related data
  - Expected latency: thấp hơn checkout/report, có thể cao hơn list
  - Risk: JOIN performance, missing index trên FK

baseline_cart_add (15%):
  - POST request, write operation
  - INSERT/UPDATE vào cart table
  - Expected latency: trung bình
  - Risk: lock contention nếu nhiều user cùng cart, DB write bottleneck

baseline_checkout (5%):
  - POST request, multi-step transaction
  - Có thể gọi external (payment, inventory, shipping)
  - Expected latency: CAO NHẤT trong 5 operation
  - Risk: external timeout, DB transaction lock, inventory row contention

baseline_report (10%):
  - GET request, aggregation query
  - SUM, GROUP BY, JOIN trên nhiều bảng
  - Expected latency: cao thứ nhì
  - Risk: full scan, missing aggregate index, large dataset
```

## Metrics và tags cần đọc

| Metric | Type | Đọc như thế nào |
| --- | --- | --- |
| `constant_active_iterations` | Counter | Số user loops hoàn tất trong fixed-duration run. Đây là output, không phải target. |
| `constant_active_iterations_failed` | Counter | Số user loops có ít nhất một API required bị fail. Đây là business-flow failure counter. |
| `constant_api_calls_total` | Counter | Tổng API calls do active users tạo ra. Dùng để đối chiếu calls/loop hoặc weighted mix. |
| `constant_flow_duration_ms` | Trend | End-to-end duration của một user loop, bao gồm nhiều API trong flow. |
| `constant_sleep_seconds` | Counter | Tổng think time/sleep do script cố ý thêm để mô phỏng user thật. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất. Với `constant-vus`, đây là observed output. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `cv-03-active-cart-editing`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `constant_vus`. |
| `workload_shape` | `steady_concurrency`. |

Tags case này:

```text
case_id       = cv-07-production-mixed-baseline
business_case = production_mixed_baseline
workload      = steady_concurrency
```

### Tại sao tag `operation` và `service` là bắt buộc với case 07?

```text
Không có operation tag:
  - http_req_duration aggregate = 450ms
  - Không biết operation nào chậm
  - Không biết service nào cần điều tra
  → VÔ DỤNG cho debugging

CÓ operation tag:
  - http_req_duration{operation:baseline_product_list} p95 = 200ms
  - http_req_duration{operation:baseline_checkout} p95 = 3000ms
  - http_req_duration{operation:baseline_report} p95 = 1500ms
  → Biết chính xác checkout và report cần điều tra
  → Route vấn đề đến order-service và report-service

CÓ service tag:
  - http_req_duration{service:products-service} p95 = 220ms
  - http_req_duration{service:order-service} p95 = 3000ms
  - http_req_duration{service:report-service} p95 = 1500ms
  → Biết service nào cần owner xem
```

## Pass criteria

Pass criteria tối thiểu theo backend script:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count<30
```

Các counters cần sanity check:

```text
constant_active_iterations ~= iterations completed by user loops
constant_api_calls_total   ~= API calls generated by completed/attempted loops
constant_flow_duration_ms  = end-to-end loop duration
constant_sleep_seconds     = configured think time actually applied
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
1. constant_active_iterations ≈ iterations
   - Mỗi iteration = 1 loop của 1 VU
   - Nếu chênh lệch > 5% → có thể có iteration không được count đúng

2. constant_api_calls_total ≈ http_reqs
   - Mỗi loop = 1 operation = 1 HTTP request
   - Nếu chênh lệch → có operation không gọi HTTP, hoặc HTTP bị drop

3. Weighted mix sanity:
   - Sau 5m, operation counts nên approximate weights
   - product_list / total ≈ 0.45 (± 5% với sample lớn)
   - Nếu lệch xa (> 10%) → script bug hoặc weighted random implementation sai

4. constant_sleep_seconds:
   - Expected: total_iterations × 0.5s
   - Nếu chênh lệch → sleep không được gọi đúng, hoặc bị skip ở branch nào đó
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js
```

### Override config qua env vars

```powershell
# Tăng VUs để xem baseline ở concurrency cao hơn
$env:CV_07_VUS = 50
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js

# Tăng duration để có sample lớn hơn (weight hội tụ tốt hơn)
$env:CV_07_DURATION = "10m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js

# Giảm sleep để thấy throughput maximum
$env:CV_07_SLEEP_SECONDS = 0.1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 30 hoặc env override
duration = 5m hoặc env override
```

### Bước 2 — Verify active-user model

Summary/dashboard nên thể hiện VUs giữ gần configured VUs trong regular phase.

Nếu VUs không flat, kiểm config/ingestion trước khi kết luận backend.

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
constant_active_iterations_failed
```

Nếu các metric này fail, xử lý correctness/failure trước khi bàn RPS.

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
constant_active_iterations
constant_api_calls_total
```

Nhớ:

```text
iterations thấp hơn run khác không tự động fail.
Có thể do backend latency tăng hoặc sleep/config khác.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
constant_flow_duration_ms
iteration_duration
http_req_duration by operation
```

Case-specific notes:

- `iterations` là số mixed user loops trong 5m, không có target exact.
- Operation mix should approximate 45/25/15/5/10 over long enough run.
- RPS thấp hơn prior baseline thường là symptom của loop latency tăng, không nhất thiết k6 issue.

### Bước 6 (RIÊNG CHO CASE 07) — Service breakdown analysis

Đây là bước quan trọng nhất cho mixed baseline:

```text
1. Lấy http_req_duration breakdown theo operation:
   - baseline_product_list: avg, p95, p99, max
   - baseline_product_detail: avg, p95, p99, max
   - baseline_cart_add: avg, p95, p99, max
   - baseline_checkout: avg, p95, p99, max
   - baseline_report: avg, p95, p99, max

2. So sánh p95 giữa các operation:
   - Operation nào có p95 cao nhất?
   - Operation đó có weight thấp không? (checkout 5%, report 10%)
   - Nếu weight thấp + p95 cao → noisy neighbor candidate

3. Tính contribution vào avg loop duration:
   - contribution_i = weight_i × avg_latency_i
   - Operation có contribution cao nhất = kéo loop duration mạnh nhất

4. So sánh actual iter/s với expected:
   - expected_loop = weighted_avg(latency) + sleep
   - expected_iter_s = vus / expected_loop
   - Nếu actual << expected → có vấn đề ngoài latency (connection, DNS, ...)

5. Check operation count distribution:
   - Sau 5m, counts có approximate weights không?
   - Nếu lệch → script bug hoặc một operation fail nhiều hơn
```

## Đọc dashboard real-time charts cho case 07

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

### Chart 1 — Response time

Đọc theo `operation`:

```text
baseline_product_list: GET /api/sim/products
baseline_product_detail: GET /api/sim/products/:id
baseline_cart_add: POST /api/sim/cart/add
baseline_checkout: POST /api/sim/checkout
baseline_report: GET /api/sim/report
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

Case-specific hints:

- Response time: aggregate p95 chỉ là mở đầu; phải breakdown products/cart/order/report.
- Execution timeline: product counts có thể dominate, nhưng checkout/report latency có thể dominate p95.
- VUs vs iter/s: flat 30 VUs + lower iter/s là baseline regression signal.

#### Phân tích sâu Chart 1 cho case 07

Với case 07, Response time chart cần được đọc theo 3 lớp:

**Lớp 1 — Aggregate (cảnh báo ban đầu)**:

```text
http_req_duration aggregate:
  - avg: baseline tổng thể
  - p95: có operation nào kéo tail không?
  - max: spike lớn nhất

  Nếu aggregate p95 cao (> 1s) → CÓ vấn đề ở đâu đó
  Nhưng KHÔNG BIẾT ở đâu → cần lớp 2
```

**Lớp 2 — Breakdown theo operation (xác định bottleneck)**:

```text
Filter theo operation:

  baseline_product_list:
    - p95 thường thấp nhất (~100-300ms)
    - Nếu cao → products-service hoặc DB query vấn đề

  baseline_product_detail:
    - p95 thường thấp (~100-400ms)
    - Nếu cao hơn list nhiều → JOIN/reviews query chậm

  baseline_cart_add:
    - p95 trung bình (~150-500ms)
    - Nếu cao → DB write contention

  baseline_checkout:
    - p95 CAO NHẤT (~1000-5000ms)
    - Đây là EXPECTED với checkout (external calls)
    - Nhưng nếu > 5000ms → external timeout hoặc DB lock

  baseline_report:
    - p95 cao thứ nhì (~500-2000ms)
    - Nếu > 3000ms → aggregation query thiếu index
```

**Lớp 3 — So sánh p95 contribution (hiểu systemic impact)**:

```text
Sau khi có p95 từng operation, tính "weighted drag":

  drag_i = weight_i × p95_i

  baseline_product_list:   0.45 × 200ms  = 90ms
  baseline_product_detail: 0.25 × 250ms  = 62.5ms
  baseline_cart_add:       0.15 × 300ms  = 45ms
  baseline_checkout:       0.05 × 3000ms = 150ms  ← DRAG LỚN NHẤT
  baseline_report:         0.10 × 1500ms = 150ms  ← DRAG LỚN NHẤT

  → Checkout và report đều drag 150ms, dù weight chỉ 5% và 10%
  → Đây là 2 operation cần optimize ĐẦU TIÊN
  → Products dù 70% weight nhưng drag thấp → chưa cần optimize
```

**Shape xấu cần chú ý trên Chart 1**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Aggregate p95 cao, nhưng tất cả operation p95 thấp | Có operation "ma" không được tag | Kiểm tra script — thiếu tag operation ở đâu đó |
| Products p95 ổn, checkout p95 spike | External payment/service chậm | Route về order-service |
| Report p95 tăng dần theo thời gian | Memory/DB state phình | Kiểm report query plan, DB connection pool |
| Tất cả operation p95 tăng cùng lúc | Vấn đề systemic (network, DB, infra) | Kiểm infrastructure, không phải service code |
| Checkout p95 = max (timeout) | External hoàn toàn không phản hồi | Block, điều tra external dependency |
| Cart add p95 tăng nhưng products ổn | DB write bottleneck riêng | Kiểm cart table lock, DB write capacity |

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 30 during regular phase.
iterations/http_reqs per bucket are observed outputs.
RPS depends on loop duration + API mix + sleep.
```

Nếu thấy:

```text
VUs flat nhưng RPS/iter/s giảm
```

thì đọc là:

```text
closed-model slowdown/backpressure
```

không đọc là:

```text
k6 không bơm đủ target RPS
```

vì không có target RPS trong constant-vus.

#### Phân tích sâu Chart 2 cho case 07

Chart Execution timeline cho case 07 có thêm chiều `operation`:

```text
Nhìn chart, filter theo operation để thấy:
  - Mỗi giây có bao nhiêu product_list request?
  - Mỗi giây có bao nhiêu checkout request?
  - Tỉ lệ có khớp weight không?

Nếu checkout request đột ngột biến mất ở 1 đoạn:
  → Checkout service có thể bị down/lỗi
  → Nhưng VU vẫn chạy, chỉ là checkout branch fail
  → constant_active_iterations_failed sẽ tăng

Nếu report request giảm dần:
  → Report query ngày càng chậm, VU bị giữ lâu hơn
  → Dẫn đến ít loop hơn → ít report request hơn
  → Đây là vòng xoáy closed-model: chậm → ít loop → càng ít request
```

**Patterns cần chú ý trên Chart 2 cho mixed baseline**:

| Pattern | Nghĩa | Hành động |
| --- | --- | --- |
| Một operation biến mất khỏi chart | Service đó bị down hoặc all request fail | Kiểm operation failed count |
| Tỉ lệ operation không khớp weight | Weighted random bug hoặc một operation fail nhiều | Kiểm script, kiểm error rate |
| RPS ổn định nhưng operation mix thay đổi | Một service chậm → weight thực tế thay đổi | Phân tích operation latency |
| RPS giảm, tất cả operation cùng giảm | Closed-model backpressure từ 1+ operation chậm | Tìm operation p95 tăng |
| RPS spike ở đầu rồi ổn định | Cold start, cache warm-up | Bình thường nếu ổn định sau 30s |
| RPS tụt đột ngột giữa test | External dependency fail, hoặc DB lock | Điều tra thời điểm tụt |

### Chart 3 — VUs vs iter/s

Chart này là trọng tâm của executor này.

Expected:

```text
VUs: flat near configured value
iter/s: dao động theo backend latency + think time + branch mix
```

Bad shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs flat, iter/s slowly falling | Backend/flow duration tăng, closed-model backpressure |
| VUs not flat | Scenario/config/dashboard issue cần kiểm trước |
| iter/s spike/drop theo branch | Weighted branch hoặc dependency latency thay đổi |
| end-tail odd shape | duration/gracefulStop/end bucket effect |

#### Phân tích sâu Chart 3 cho case 07

VUs vs iter/s là chart **quan trọng nhất** để hiểu closed-model behavior của mixed baseline.

```text
Tại sao chart này quan trọng với case 07?

Vì nó cho thấy MỐI QUAN HỆ giữa:
  - Active users (VUs = 30, phẳng)
  - Throughput (iter/s, dao động)

Nếu VUs phẳng mà iter/s giảm:
  → Closed-model backpressure: VUs vẫn active, nhưng mỗi loop chậm hơn
  → Phải tìm operation nào làm loop chậm (dùng Chart 1)

Nếu VUs phẳng và iter/s cũng phẳng:
  → Hệ thống ổn định, không có degradation theo thời gian
  → Baseline tốt

Nếu VUs không phẳng:
  → ĐỪNG phân tích gì khác. Sửa config/dashboard trước.
  → VUs không phẳng = test không valid cho constant-vus
```

**Cách đọc chart cho mixed baseline qua 3 giai đoạn**:

```text
Giai đoạn 1 — Đầu test (0-30s):
  - VUs tăng từ 0 lên 30 (ramp-up)
  - iter/s = 0 ban đầu (chưa loop nào xong)
  - iter/s tăng dần khi các loop đầu hoàn tất
  - ĐÂY LÀ BÌNH THƯỜNG

Giai đoạn 2 — Regular phase (30s-270s):
  - VUs = 30 (phẳng)
  - iter/s dao động quanh giá trị ổn định (~35-45 tùy backend)
  - Nếu iter/s giảm dần → closed-model degradation
  - Nếu iter/s ổn định → baseline khỏe

Giai đoạn 3 — Cuối test (270s-300s):
  - VUs có thể giảm (gracefulStop)
  - iter/s giảm theo
  - ĐÂY LÀ BÌNH THƯỜNG (end-of-test effect)
  - Không dùng 30s cuối để kết luận
```

**Shape cần chú ý cho mixed baseline**:

| Shape | Nghĩa cho case 07 | Hành động |
| --- | --- | --- |
| VUs=30, iter/s ổn định suốt 5m | Tất cả service ổn, baseline sạch | Ghi nhận baseline |
| VUs=30, iter/s giảm dần | 1+ operation ngày càng chậm (leak, DB phình) | So Chart 1 tìm operation tăng dần |
| VUs=30, iter/s dao động mạnh | Checkout/report weight nhỏ gây spike khi hit | Bình thường với mixed weight, kiểm operation p95 |
| VUs=30, iter/s thấp hơn hẳn expected | Có operation rất chậm hoặc sleep/config khác | Tính expected iter/s từ latency |
| VUs tụt giữa test | VU crash, OOM, hoặc error | Kiểm k6 logs |
| VUs=30, iter/s = 0 | Tất cả VU bị kẹt trong request | Backend hoàn toàn không phản hồi |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên failures + latency + closed-model throughput change.
```

## Real run — default constant-vus baseline after X-User-ID header

Run verify qua local cloud/dashboard sau khi k6 helper gửi `X-User-ID: ctx.userId`:

```text
Run ID: #87
Script: cv-07-production-mixed-baseline.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 30 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `12,742 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `12,742` |
| `iterations_rate` | `42.28/s` |
| `http_reqs` | `12,742` |
| `http_reqs_rate` | `42.28/s` |
| `vus_min/vus_max` | `5 / 30` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `207.08 / 3 / 1,879.65 / 3,585.18 / 5,667 ms` |
| `http_req_duration avg/med/p95/p99/max` | `206.97 / 2.85 / 1,879.93 / 3,585.50 / 5,665.79 ms` |

Request breakdown:

```text
baseline_product_list GET 200 count=5,767
baseline_product_detail GET 200 count=3,207
baseline_cart_add POST 200 count=1,880
baseline_report GET 200 count=1,283
baseline_checkout POST 200 count=605
```

### Đọc 3 chart dashboard cho run #87

**Chart 1 — Response time.** `http_req_duration` p95 ~1,879.93ms, p99 tail cao do mixed workload có checkout/report/product branches; nhưng tất cả status đều expected 200, không còn 429.

**Chart 2 — Execution timeline.** `iterations` và `http_reqs` đều sum 12,742. Operation mix hợp lý: product_list 5,767; detail 3,207; cart 1,880; report 1,283; checkout 605; failed iterations = 0.

Dashboard/API bucket summary:

```text
iterations buckets: count=302, sum=12742, min=5.00, max=60.00
http_reqs buckets:  count=301, sum=12742, min=10.00, max=59.00
không có failed iteration buckets
```

**Chart 3 — VUs vs iter/s.** Regular phase giữ 30 VUs; min 5 là end-tail bucket. VUs flat trong regular phase nên baseline valid.

```text
vus buckets: count=301, min=5.00, max=30.00, avg=29.92
```

### Backend verdict

```text
PASS — X-User-ID header đã loại bỏ 429 trong production mixed baseline.
```

Không cần báo BE cho CV-07 sau fix. Nếu muốn tối ưu performance, p95 tail nên được đọc theo operation (checkout/report có thể kéo aggregate), nhưng đây không phải functional failure.

## Checklist đọc dashboard cho case 07

```text
1. Overview KPI
   - checks > 99%?
   - http_req_failed < 1%?
   - constant_active_iterations_failed < 30?
   - VUs = 30?

2. Response time chart
   - Đã filter theo operation chưa?
   - Operation nào p95 cao nhất?
   - Operation p95 cao có weight thấp không? (noisy neighbor)
   - Operation nào drag nhiều nhất?
   - Có operation nào tăng dần theo thời gian không?

3. Execution timeline
   - Live VUs có = 30 trong regular phase không?
   - RPS có ổn định không?
   - Operation mix có approximate weight không?
   - Có operation nào biến mất không?

4. VUs vs iter/s
   - VUs có flat = 30 không?
   - iter/s có ổn định không?
   - iter/s có giảm dần không?
   - End-tail có bất thường không?

5. Business decision
   - Baseline đã được thiết lập chưa?
   - Operation nào cần điều tra?
   - Service nào cần route vấn đề?
   - Sẵn sàng cho ramping/arrival-rate comparison chưa?
```

## Kết luận thực tế: output -> quyết định

Case 07 có 6 kịch bản output → quyết định, nhiều hơn các case khác vì có 5 service.

### Kịch bản 1 — All clean: BASELINE ESTABLISHED

```text
checks............: 100.00%
http_req_failed...: 0.00%
constant_active_iterations_failed: 0
VUs...............: 30 (flat)

http_req_duration by operation:
  baseline_product_list:   p95=180ms
  baseline_product_detail: p95=220ms
  baseline_cart_add:       p95=280ms
  baseline_checkout:       p95=1800ms
  baseline_report:         p95=900ms

iter/s ổn định ~40 trong suốt 5m
```

Kết luận thực tế:

```text
- Tất cả checks pass, không có failure
- Products latency thấp (~200ms) → products-service OK
- Checkout p95=1800ms → bình thường với external calls
- Report p95=900ms → chấp nhận được
- iter/s ổn định → không có degradation

=> QUYẾT ĐỊNH: Baseline established. Ghi nhận toàn bộ số.
   Đây là reference point cho mọi test performance tiếp theo.
   Lưu lại: p95 từng operation, iter/s, RPS, error rate.
```

### Kịch bản 2 — Checkout dominates p95: ROUTE TO ORDER-SERVICE

```text
checks............: 99.8%
http_req_failed...: 0.2%
constant_active_iterations_failed: 5 (toàn checkout)

http_req_duration by operation:
  baseline_product_list:   p95=190ms  ← OK
  baseline_product_detail: p95=230ms  ← OK
  baseline_cart_add:       p95=290ms  ← OK
  baseline_checkout:       p95=5000ms ← RẤT CAO!
  baseline_report:         p95=950ms  ← OK

iter/s ≈ 35 (thấp hơn expected 40)
```

Kết luận thực tế:

```text
- Products, cart, report đều OK
- Checkout p95=5000ms → external payment gateway có vấn đề
- 5 loop failed đều là checkout → consistent issue
- iter/s giảm từ 40 → 35 (12.5%) vì checkout kéo loop duration

=> QUYẾT ĐỊNH: Route vấn đề về order-service team.
   Products-service KHÔNG CÓ VẤN ĐỀ (dù iter/s giảm).
   Đây là noisy neighbor effect: checkout kéo toàn bộ test.
   KHÔNG optimize products — optimize checkout.
```

### Kịch bản 3 — Report dominates p95: ROUTE TO REPORT-SERVICE

```text
checks............: 99.9%
http_req_failed...: 0.1%

http_req_duration by operation:
  baseline_product_list:   p95=185ms  ← OK
  baseline_product_detail: p95=225ms  ← OK
  baseline_cart_add:       p95=275ms  ← OK
  baseline_checkout:       p95=1900ms ← OK (bình thường)
  baseline_report:         p95=4000ms ← RẤT CAO!

iter/s ≈ 36
```

Kết luận thực tế:

```text
- Checkout p95=1900ms là bình thường
- Report p95=4000ms → aggregation query có vấn đề
  (thiếu index, full scan, hoặc dataset quá lớn)

=> QUYẾT ĐỊNH: Route về report-service team.
   Kiểm tra: query plan, index, data volume, cache strategy.
   Report 10% weight nhưng drag = 0.10 × 4000 = 400ms → kéo mạnh loop duration.
```

### Kịch bản 4 — iter/s thấp hơn prior baseline: REGRESSION INVESTIGATION

```text
Baseline cũ (tuần trước):
  iter/s = 42
  checkout p95 = 1800ms
  report p95 = 900ms

Baseline mới (hôm nay):
  iter/s = 31  ← GIẢM 26%!
  checkout p95 = 4500ms  ← TĂNG 2.5×
  report p95 = 1000ms  ← hơi tăng
```

Kết luận thực tế:

```text
- iter/s giảm 26% → cần điều tra
- checkout p95 tăng 2.5× → ĐÂY LÀ NGUYÊN NHÂN
- Không phải "k6 issue", không phải "test config sai"

=> QUYẾT ĐỊNH: Điều tra order-service/checkout pipeline.
   So sánh commit diff giữa 2 tuần.
   Kiểm external payment latency.
   Đây là performance regression thật, phát hiện nhờ baseline.
```

### Kịch bản 5 — Một operation fail hoàn toàn: BLOCK + ROUTE

```text
checks............: 94.5%
http_req_failed...: 5.5%
constant_active_iterations_failed: 120

http_req_duration by operation:
  baseline_product_list:   p95=200ms
  baseline_product_detail: p95=240ms
  baseline_cart_add:       p95=300ms
  baseline_checkout:       (KHÔNG CÓ DATA — tất cả fail)
  baseline_report:         p95=950ms

checkout requests: toàn bộ 499/500/timeout
```

Kết luận thực tế:

```text
- Checkout service hoàn toàn không hoạt động
- http_req_failed 5.5% = toàn bộ checkout requests (~5% weight)
- constant_active_iterations_failed = 120 (mỗi lần VU hit checkout)

=> QUYẾT ĐỊNH: BLOCK mọi deploy liên quan đến order-service.
   Route vấn đề: checkout external down? Config sai? API thay đổi?
   Đây không phải performance issue — đây là FUNCTIONAL BREAK.
```

### Kịch bản 6 — Operation mix far from expected: SCRIPT BUG

```text
Operation counts:
  baseline_product_list:   8000 (67%)  ← expected 45%
  baseline_product_detail: 2000 (17%)  ← expected 25%
  baseline_cart_add:       1000 (8%)   ← expected 15%
  baseline_checkout:       500  (4%)   ← expected 5%
  baseline_report:         500  (4%)   ← expected 10%

Tổng: 12000 loops trong 5m
```

Kết luận thực tế:

```text
- Product list 67% thay vì 45% → lệch nặng
- Report 4% thay vì 10% → thiếu
- Cart add 8% thay vì 15% → thiếu

=> QUYẾT ĐỊNH: KHÔNG kết luận gì về backend.
   Kiểm tra script: weighted random implementation sai?
   Hoặc: một operation fail → VU retry? skip? → ảnh hưởng mix.
   Sửa script, chạy lại.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| all services clean + VUs flat | Baseline established | Use for comparison |
| aggregate latency high | Need service breakdown | Inspect by operation |
| product count dominates but checkout p95 dominates | Small branch high latency | Investigate checkout separately |
| RPS lower than prior baseline | Possible latency regression, not necessarily k6 issue | Compare flow duration and service p95 |
| checkout p95 spike, products OK | Order-service issue | Route to order-service team |
| report p95 spike, others OK | Report-service issue | Route to report-service team |
| all p95 spike together | Systemic issue (network, DB, infra) | Investigate infrastructure |
| one operation 100% fail | Service down or API broken | Block, route to service owner |
| operation mix lệch xa weight | Script bug hoặc operation fail bias | Sửa script, chạy lại |
| VUs không flat | Config/dashboard issue | Kiểm config trước khi phân tích backend |

## "Nghịch lý" và misconceptions của constant-vus mixed baseline

Đừng dùng case này để nói hệ thống chịu được fixed target RPS. Đây là closed-model baseline với 30 active users.

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

### Nghịch lý 1: "Products 70% mà checkout kéo cả test?"

```text
Learner hỏi: "Checkout chỉ có 5%, sao lại làm iter/s giảm?"

Trả lời: Vì closed model. Mỗi VU thỉnh thoảng hit checkout (5%).
Khi hit, VU đó bị checkout giữ 2000-5000ms.
Trong thời gian đó, VU KHÔNG THỂ chạy bất kỳ operation nào khác.
→ Tổng pool 30 VUs bị giảm effective capacity mỗi khi có VU dính checkout.

Tính toán:
  - 30 VUs, checkout 5% → trung bình 1.5 VU luôn trong checkout
  - Nếu checkout 2000ms → 1.5 VUs bị giữ 2s mỗi lần
  - Nếu checkout 5000ms → 1.5 VUs bị giữ 5s mỗi lần
  - 1.5 VUs bị giữ thêm 3s → mất 4.5 "VU-giây" mỗi loop
  - Tương đương mất ~0.15 VUs liên tục → iter/s giảm ~0.5%

  Thực tế còn tệ hơn vì:
  - Checkout không phân bố đều — có thời điểm 3-4 VU cùng checkout
  - Lúc đó effective pool còn 26-27 VUs → iter/s giảm rõ rệt

Đây là "noisy neighbor" kinh điển:
  - Checkout (order-service) là "hàng xóm ồn ào"
  - Products (products-service) là "hàng xóm yên tĩnh"
  - Nhưng cả 2 ở chung "căn hộ" 30 VUs
  - Khi checkout ồn (chậm), products cũng không yên (throughput giảm)
```

### Nghịch lý 2: "Baseline không có pass/fail rõ ràng?"

```text
Learner hỏi: "Sao baseline không có threshold kiểu p95 < 500ms?"

Trả lời: Vì baseline là CÂY THƯỚC, không phải CÁI CỔNG.

Nếu đặt threshold p95 < 500ms:
  - Checkout p95 tự nhiên đã 1800ms → baseline LUÔN FAIL
  - Nhưng 1800ms là bình thường với checkout (có external call)
  → Threshold vô nghĩa — nó không phản ánh thực tế hệ thống

Thay vào đó:
  - Baseline đo checkout p95 = 1800ms
  - Đây là SỰ THẬT, không phải PASS/FAIL
  - Tuần sau nếu checkout p95 = 5000ms → ĐÓ LÀ FAIL (tăng 2.8×)
  - Tuần sau nếu checkout p95 = 1700ms → ĐÓ LÀ PASS (ổn định)

  Pass/fail đến từ SO SÁNH, không phải từ con số tuyệt đối.

Ngoại lệ: baseline có thể fail nếu:
  - checks fail (functional issue)
  - http_req_failed > 1% (network/infra issue)
  - VUs không flat (config issue)

Nhưng latency hay throughput không bao giờ là pass/fail của baseline.
```

### Nghịch lý 3: "30 VU mà iter/s không gấp 3 lần 10 VU?"

```text
Learner hỏi: "Case 01 storefront 20 VU → iter/s = 30.
             Case 07 baseline 30 VU → iter/s = 38.
             Sao không gấp 1.5 lần? (30/20 = 1.5× VUs, nhưng iter/s chỉ 38/30 = 1.27×)"

Trả lời: Vì iter/s không tuyến tính với VUs trong closed model.
Công thức iter/s = VUs / loop_duration chỉ đúng nếu loop_duration KHÔNG ĐỔI.

Nhưng khi tăng VUs:
  - Nhiều request đồng thời hơn → DB connection pool cạnh tranh
  - Nhiều transaction đồng thời → lock contention tăng
  - CPU/IO chia sẻ nhiều hơn → mỗi request chậm hơn
  → loop_duration TĂNG khi VUs tăng

30 VUs, loop_duration = 0.79s → iter/s = 30/0.79 = 38
10 VUs, loop_duration = 0.50s → iter/s = 10/0.50 = 20

Tăng 3× VUs nhưng loop_duration tăng 1.58× → iter/s chỉ tăng 1.9×
Đây là sub-linear scaling — ĐIỀU BÌNH THƯỜNG trong hệ thống thật.

KHÔNG kỳ vọng iter/s tuyến tính với VUs.
Đó là lý do cần chạy ramping-vus để đo SCALABILITY CURVE.
```

### Nghịch lý 4: "RPS thấp hơn kỳ vọng là fail?"

```text
Learner hỏi: "Em kỳ vọng RPS phải ~50, nhưng chỉ được 38. Test fail à?"

Trả lời: KHÔNG. Kỳ vọng RPS từ đâu ra?

Nếu từ "ước lượng": 30 VU, mỗi loop 0.6s → 50 iter/s
  - Nhưng loop thực tế là 0.79s (có checkout 2000ms, report 800ms, sleep 500ms)
  - 30/0.79 = 38 iter/s → ĐÂY LÀ SỰ THẬT

Nếu từ "target kinh doanh": hệ thống phải chịu được 50 RPS
  - Thì 30 VUs tự nhiên chỉ tạo 38 RPS
  - Để đạt 50 RPS, cần: 50 × 0.79 = 39.5 VUs → cần ~40 VUs
  - Hoặc giảm loop_duration: optimize checkout/report
  - Đây là INPUT cho capacity planning, không phải fail

RPS trong constant-vus là OUTPUT, không phải TARGET.
Nếu muốn target RPS cố định, dùng constant-arrival-rate.
```

## Code pattern cho case 07

### Cấu trúc script mixed baseline

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
    name: "baseline_product_list",
    weight: 45,
    service: "products-service",
    fn: () => {
      const res = http.get(`${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid`, {
        tags: {
          operation: "baseline_product_list",
          service: "products-service",
        },
      });
      check(res, {
        "product_list status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "baseline_product_detail",
    weight: 25,
    service: "products-service",
    fn: () => {
      const id = randomIntBetween(1, 100);
      const res = http.get(`${BASE_URL}/api/sim/products/${id}?view=full`, {
        tags: {
          operation: "baseline_product_detail",
          service: "products-service",
        },
      });
      check(res, {
        "product_detail status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "baseline_cart_add",
    weight: 15,
    service: "cart-service",
    fn: () => {
      const payload = JSON.stringify({
        product_id: randomIntBetween(1, 100),
        quantity: randomIntBetween(1, 3),
      });
      const res = http.post(`${BASE_URL}/api/sim/cart/add`, payload, {
        headers: { "Content-Type": "application/json" },
        tags: {
          operation: "baseline_cart_add",
          service: "cart-service",
        },
      });
      check(res, {
        "cart_add status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "baseline_checkout",
    weight: 5,
    service: "order-service",
    fn: () => {
      const payload = JSON.stringify({ cart_id: `cart-${randomIntBetween(1, 30)}` });
      const res = http.post(`${BASE_URL}/api/sim/checkout`, payload, {
        headers: { "Content-Type": "application/json" },
        tags: {
          operation: "baseline_checkout",
          service: "order-service",
        },
      });
      check(res, {
        "checkout status 200": (r) => r.status === 200,
      });
    },
  },
  {
    name: "baseline_report",
    weight: 10,
    service: "report-service",
    fn: () => {
      const res = http.get(`${BASE_URL}/api/sim/report?range=7d&format=summary`, {
        tags: {
          operation: "baseline_report",
          service: "report-service",
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
    production_mixed_baseline: {
      executor: "constant-vus",
      vus: __ENV.CV_07_VUS ? parseInt(__ENV.CV_07_VUS) : 30,
      duration: __ENV.CV_07_DURATION || "5m",
      tags: {
        case_id: "cv-07-production-mixed-baseline",
        business_case: "production_mixed_baseline",
        workload: "steady_concurrency",
        executor_family: "constant_vus",
      },
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
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
  const sleepSeconds = parseFloat(__ENV.CV_07_SLEEP_SECONDS || "0.5");
  sleep(sleepSeconds);
}
```

### Giải thích các điểm quan trọng trong code

```text
1. Mỗi operation có tag `operation` và `service` RIÊNG:
   - Đây là cách duy nhất để breakdown metrics sau test
   - Thiếu tag → aggregate p95 che hết bottleneck

2. Weighted random dùng totalWeight:
   - Không cần total = 100
   - Có thể thêm operation mới mà không cần sửa weight khác

3. Mỗi iteration = 1 operation + 1 sleep:
   - Khác với case 01 storefront (1 iteration = 3 API: list+detail+cart)
   - Phù hợp để mỗi operation có latency độc lập

4. sleep sau operation, không phải trước:
   - Mô phỏng user "nghĩ" sau khi xem kết quả
   - Nếu sleep trước → user "nghĩ" trước khi làm gì đó (kém thực tế hơn)

5. Env vars cho phép override không cần sửa code:
   - CV_07_VUS: thay đổi số user
   - CV_07_DURATION: thay đổi thời gian quan sát
   - CV_07_SLEEP_SECONDS: thay đổi think time
```

## Mở rộng

### Variation A: Thay đổi weight để mô phỏng traffic pattern khác

```powershell
# Traffic pattern "sale event": nhiều checkout hơn
# Sửa OPERATIONS array: checkout weight 5 → 20, products list 45 → 35
# (Cần sửa code, không phải env var)
```

```js
// Pattern "window shopping": gần như toàn bộ là products
const OPERATIONS = [
  { name: "baseline_product_list",   weight: 60, ... },
  { name: "baseline_product_detail", weight: 30, ... },
  { name: "baseline_cart_add",       weight: 7,  ... },
  { name: "baseline_checkout",       weight: 1,  ... },
  { name: "baseline_report",         weight: 2,  ... },
];
```

```js
// Pattern "report heavy": cuối tháng, nhiều user xem report
const OPERATIONS = [
  { name: "baseline_product_list",   weight: 30, ... },
  { name: "baseline_product_detail", weight: 20, ... },
  { name: "baseline_cart_add",       weight: 10, ... },
  { name: "baseline_checkout",       weight: 5,  ... },
  { name: "baseline_report",         weight: 35, ... },
];
```

Mỗi pattern cho ra baseline khác nhau → so sánh để hiểu traffic mix ảnh hưởng thế nào đến throughput.

### Variation B: So sánh baseline với ramping-vus

```text
Step 1: Chạy case 07 (constant-vus, 30 VUs)
  → Baseline: iter/s = 38, p95 checkout = 1800ms

Step 2: Chạy ramping-vus: 10 → 30 → 60 → 90 VUs
  → Stage 30 VUs: iter/s = 37, p95 checkout = 1900ms
    (gần baseline → consistent)
  → Stage 60 VUs: iter/s = 58, p95 checkout = 3500ms
    (scaling sub-linear: 2× VUs nhưng iter/s chỉ 1.5×)
  → Stage 90 VUs: iter/s = 65, p95 checkout = 6000ms
    (bắt đầu bão hòa, latency tăng mạnh)

Step 3: Kết luận
  - Saturation point: ~60-70 VUs
  - Ở 90 VUs: checkout degradation nghiêm trọng
  - Khuyến nghị: scale order-service trước khi tăng users
```

### Variation C: So sánh baseline với constant-arrival-rate

```text
Step 1: Baseline → natural RPS = 38

Step 2: constant-arrival-rate target RPS = 38 (bằng baseline)
  → KHÔNG drop, latency ~ baseline
  → Hệ thống thoải mái ở natural rate

Step 3: constant-arrival-rate target RPS = 50 (~1.3× baseline)
  → Drop 5%, latency tăng 30%
  → Hệ thống bắt đầu strain

Step 4: constant-arrival-rate target RPS = 60 (~1.6× baseline)
  → Drop 20%, latency tăng 100%
  → Vượt quá capacity

Kết luận: hệ thống có capacity margin ~30% so với natural load.
```

### Variation D: Thêm threshold per-service để biến baseline thành performance gate

```js
export const options = {
  thresholds: {
    // Products service
    "http_req_duration{operation:baseline_product_list}":   ["p(95)<300"],
    "http_req_duration{operation:baseline_product_detail}": ["p(95)<400"],

    // Cart service
    "http_req_duration{operation:baseline_cart_add}":       ["p(95)<500"],

    // Order service
    "http_req_duration{operation:baseline_checkout}":       ["p(95)<3000"],

    // Report service
    "http_req_duration{operation:baseline_report}":         ["p(95)<2000],
  },
};
```

Lưu ý: threshold khác nhau cho từng service vì latency profile khác nhau. Không dùng chung một con số.

### Variation E: Tăng duration để có sample lớn hơn (weight hội tụ tốt hơn)

```powershell
$env:CV_07_DURATION = "30m"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js
```

30 phút → ~70,000 loops → weight phân phối rất sát 45/25/15/5/10. Dùng cho stability/soak test.

### Variation F: Multi-scenario — baseline + ramping cùng lúc

```js
scenarios: {
  // Baseline 30 VUs phẳng
  baseline: {
    executor: "constant-vus",
    vus: 30,
    duration: "5m",
    tags: { case_id: "cv-07-baseline", workload: "steady_concurrency" },
  },
  // Ramping từ 10→60 VUs để xem scalability
  ramp: {
    executor: "ramping-vus",
    startVUs: 10,
    stages: [
      { duration: "3m", target: 30 },
      { duration: "3m", target: 60 },
    ],
    startTime: "5m",  // Start sau khi baseline xong
    tags: { case_id: "cv-07-ramp", workload: "ramping_concurrency" },
  },
},
```

Chạy 1 lần, có cả baseline và ramp → tiết kiệm thời gian.

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Kết luận "products-service chậm" khi iter/s giảm nhưng checkout p95 mới là nguyên nhân.
- Bỏ qua tag `operation` và `service` — không breakdown được thì không debug được.
- Đặt threshold latency giống nhau cho tất cả operation (checkout tự nhiên chậm hơn products).
- Dùng case 07 để claim "hệ thống chịu được X users" — đây là baseline 1 mức, không phải scalability test.
- Fail test vì operation mix không khớp chính xác weight sau 5 phút (sample chưa đủ lớn để hội tụ tuyệt đối).
- Dùng kết quả case 07 để so sánh với arrival-rate test mà không accounting cho sleep time.

## Checklist đọc case 07

```text
1. Summary verification
   - checks > 99%?
   - http_req_failed < 1%?
   - constant_active_iterations_failed < 30?
   - VUs flat near 30?

2. Operation latency breakdown (QUAN TRỌNG NHẤT)
   - Đã filter http_req_duration theo operation chưa?
   - Operation nào p95 cao nhất?
   - Operation p95 cao có weight thấp không? (noisy neighbor check)
   - Drag contribution: weight × p95 cho từng operation?
   - Operation nào drag cao nhất?

3. Throughput analysis
   - iter/s bao nhiêu?
   - Expected iter/s tính từ weighted latency + sleep?
   - Actual có gần expected không?
   - Nếu thấp hơn → operation nào kéo?

4. Operation mix
   - Counts có approximate weights không?
   - Nếu lệch > 10% → script bug hoặc operation fail bias?

5. Baseline comparison (nếu có baseline trước)
   - iter/s thay đổi thế nào?
   - Operation p95 nào thay đổi?
   - Có regression không?

6. Business decision
   - Basline đã được thiết lập chưa?
   - Service nào cần route vấn đề?
   - Sẵn sàng cho ramping/arrival-rate comparison chưa?
```

Kết luận của run case 07 đúng nếu thấy:

```text
VUs = 30 (flat trong regular phase)
checks > 99%
http_req_failed < 1%
constant_active_iterations_failed < 30
executor = constant-vus
duration = 5m (= 300s regular phase)
Có breakdown http_req_duration theo operation
Operation mix approximate weights
Đã ghi nhận baseline numbers cho comparison sau này
```

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-07-production-mixed-baseline.js`
- Ramping-vus comparison: `../ramping-vus/00_overview.md`
- Constant-arrival-rate comparison: `../constant-arrival-rate/00_overview.md`
