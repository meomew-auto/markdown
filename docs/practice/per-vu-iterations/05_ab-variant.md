# Case 05: A/B variant balanced exposure

## Tình huống thực tế

Marketing chạy A/B test recommendation algorithm:
- Variant A: collaborative filtering (mới)
- Variant control: popular items (cũ)

Yêu cầu:

```text
- 100 users tổng
- 50% nhận variant A, 50% nhận control
- Mỗi user xem 5 trang -> verify exposure
- Mỗi user nhận ĐÚNG 1 variant cố định (không random từng trang)
- Sau test: variant_a_count == variant_control_count == 250
```

## Vì sao "A/B test" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **A/B test** là gì:

```text
A/B test = chia user thành 2 nhóm, mỗi nhóm thấy 1 phiên bản khác nhau,
           rồi so nhóm nào "tốt hơn" (mua nhiều hơn, ở lại lâu hơn).

Đời thường:
  Quán thử 2 công thức phở: nhóm A nếm vị mới, nhóm B (control) vị cũ
  -> đếm nhóm nào gọi thêm tô nhiều hơn

Điều kiện để kết quả ĐÁNG TIN:
  - Mỗi khách CHỈ nếm 1 vị (không đổi giữa chừng -> loạn cảm nhận)
  - 2 nhóm số lượng BẰNG NHAU (50/50 -> so sánh fair)
```

Để A/B test **có giá trị thống kê**, phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): VARIANT STICKY PER USER (1 user 1 variant cố định)

**Ý nghĩa**: Mỗi user phải thấy CÙNG variant qua tất cả lần truy cập. Nếu
user lúc thấy A lúc thấy control → trải nghiệm loạn → dữ liệu vô nghĩa.

```text
Flow đúng (variant sticky theo user):
  User VU=2 (chẵn): variant=A    -> cả 5 lần xem đều variant A
  User VU=3 (lẻ):   variant=control -> cả 5 lần đều control

Vì sao per-vu đảm bảo?
  - userVariant = __VU % 2 (deterministic theo VU)
  - Tính 1 lần ở iter 0, lưu biến per-VU
  - 5 iter sau cùng VU -> cùng variant
  - __VU cố định cho 1 user -> variant không bao giờ đổi
```

**Vì sao executor khác fail?**

```text
✗ random variant mỗi iter (Math.random()):
  - User xem 5 trang với variant nhảy lung tung
  - Không đo được "variant A có giữ chân user không"

✗ constant-vus / arrival-rate:
  - __VU không stable cho 1 user -> variant nhảy theo VU pool
  - User cảm nhận 2 phiên bản trộn lẫn -> ô nhiễm dữ liệu
```

### Yêu cầu (b): EXPOSURE BALANCED (2 nhóm bằng nhau, đếm chính xác)

**Ý nghĩa**: Số user nhóm A phải BẰNG nhóm control (50/50). Lệch → so sánh
không fair (nhóm đông tự nhiên có nhiều conversion hơn).

**3 nguyên nhân kỹ thuật khiến exposure bị lệch (skew)**:

#### Nguyên nhân 1: LAZY ASSIGNMENT SKEW (gán variant theo thời gian đến)

**Lazy assignment**: server gán variant khi user ĐẾN (theo thứ tự), không
gán trước. Nếu user đến không đều theo thời gian → lệch.

```text
Server gán luân phiên A, control, A, control... theo thứ tự đến:
  Nếu dùng ramping-vus (VU tăng dần 0->100):
    - 30s đầu: chỉ VU 1-50 active -> gán A,control,A,control... -> OK
    - NHƯNG nếu server gán theo "batch đến cùng lúc":
      50 VU đến gần như đồng thời -> gán lệch do race
  -> nhóm A có thể 60, control 40 -> skew 60/40

→ per-vu: TẤT CẢ VU start gần như đồng thời ở t=0, variant gán theo
  __VU%2 (không theo thời gian đến) -> luôn 50/50
```

#### Nguyên nhân 2: HASH BUCKET IMBALANCE (chia nhóm bằng hash bị lệch)

**Cách phổ biến**: gán variant = `hash(user_id) % 2`. Nếu hàm hash không
phân bố đều → nhóm lệch.

```text
Bug: hash kém phân bố
  hash("user-1") % 2 = 0 -> A
  hash("user-2") % 2 = 0 -> A   (xui, cũng 0)
  hash("user-3") % 2 = 0 -> A   (lại 0)
  -> nếu user_id có pattern (toàn số chẵn) -> hash lệch -> 70/30

Fix: dùng hash tốt (murmur, sha) + user_id ngẫu nhiên

→ Test phải verify phân bố thực tế = 50/50 với user pool đã biết
→ per-vu: __VU chạy 1,2,3...100 đều đặn -> %2 cho đúng 50 chẵn + 50 lẻ
  -> exposure CHÍNH XÁC 50/50, dễ verify
```

#### Nguyên nhân 3: COOKIE/SESSION LOSS (mất variant giữa chừng)

**Vấn đề**: variant lưu trong cookie/session. Nếu user mất cookie (hết hạn,
clear cache) → server gán lại variant → có thể đổi nhóm.

```text
Bug:
  Lần 1: user nhận variant A, lưu cookie ab=A
  Lần 3: cookie hết hạn -> server gán lại -> lần này control
  -> user bị tính vào CẢ 2 nhóm -> double count -> skew

Fix: variant assignment deterministic theo user_id (không phụ thuộc cookie)

→ Test phải verify variant ổn định qua nhiều lần truy cập
→ per-vu: variant tính theo __VU (không cookie) -> luôn ổn định, dễ verify
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Variant sticky per user | (b) Exposure balanced 50/50 | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ variant theo __VU cố định | ✓ __VU%2 chia đều chính xác | ✅ DÙNG |
| shared-iterations | ✗ VU pick random | ✗ phân phối iter không đều | ❌ |
| constant-vus (duration) | ✗ __VU không stable | ✗ user xuất hiện không đều | ❌ |
| constant-arrival-rate | ✗ identity rời VU | ✗ rate-driven, khó balance | ❌ |
| ramping-vus | ✗ VU spawn theo time | ✗ lazy assign skew theo thời gian | ❌ |
| ramping-arrival-rate | ✗ rate-driven | ✗ exposure lệch theo rate | ❌ |

→ Chỉ **per-vu-iterations** đảm bảo "mỗi user 1 variant cố định + 2 nhóm
chính xác 50/50", điều kiện BẮT BUỘC để A/B test có giá trị thống kê.

## Config

```js
export const options = {
  scenarios: {
    ab_test: {
      executor: "per-vu-iterations",
      vus: 100,                  // 50 A + 50 control
      iterations: 5,             // 5 view per user
      maxDuration: "3m",
    },
  },
  thresholds: {
    variant_a_count: ["count==250"],       // 50 × 5
    variant_control_count: ["count==250"], // 50 × 5
  },
};
```

## Variant assignment

**Code thật từ file pvi-05-ab-variant.js**:

```js
// ───── Module-level scope (GIỮ qua 5 view) ─────
let userVariant = null;
let userSegment = null;

// ───── Trong default() ─────
export default function () {
  // Iter 0: assign variant -> LƯU VÀO MODULE-LEVEL
  if (__ITER === 0) {
    userVariant = __VU % 2 === 0 ? "a" : "control";  // ← GIỮ
    userSegment = __VU < 50 ? "premium" : "free";      // ← GIỮ
  }

  // Mọi iter: gửi request với variant ĐÃ GHI TỪ ITER 0
  const res = http.get(`${BASE_URL}/api/sim/products/homefeed`, {
    headers: {
      "X-User-Segment": userSegment,
      "X-Ab-Variant": userVariant,
    },
  });

  if (userVariant === "a") variantA.add(1);
  else variantControl.add(1);
}
```

**Trace execution cho VU=2 và VU=3**:

```text
VU=2 (chẵn):
  Iter 0: userVariant = "a"
  Iter 1: userVariant VẪN = "a"   ← ĐỌC TỪ MODULE-LEVEL
  Iter 2-4: vẫn "a"
  → variantA count nhận 5 view

VU=3 (lẻ):
  Iter 0: userVariant = "control"
  Iter 1: userVariant VẪN = "control"  ← ĐỌC TỪ MODULE-LEVEL
  Iter 2-4: vẫn "control"
  → variantControl count nhận 5 view

→ 50 VU chẵn (A) × 5 view = 250
  50 VU lẻ (control) × 5 view = 250
  Balanced 50/50 ✓
```

→ VU=1 → control, VU=2 → A, VU=3 → control, ... balanced 50/50.

> **Tại sao variant không đổi khi VU chạy 5 view?** Cùng cơ chế case 01:
> `let userVariant` ở module-level GIỮ qua iter. Gán 1 lần ở iter 0,
> 4 iter sau đọc lại giá trị cũ. Xem [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

## Endpoint flow

```text
Mọi iter:
  GET /api/products/homefeed?personalized=1
  Headers:
    X-User-Segment: premium | free
    X-Ab-Variant:   a | control
  -> Server: trả homepage tương ứng variant

Nếu variant=a:
  GET /api/products/:id/recommendations?algorithm=collaborative
  Headers: X-Ab-Variant=a
  -> Server: trả collaborative filtering recs
```

## Pass criteria

```text
1. variant_a_count == 250         (50 × 5 view)
2. variant_control_count == 250   (50 × 5 view)
3. Hai con số EQUAL (deterministic balance)
4. http_req_failed == 0%
```

## Cách chạy

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-05-ab-variant.js
```

**Verify trên UI**:

```text
1. Paste token, click run mới nhất → tab Custom metrics
2. variant_a_count: 250 ✓
3. variant_control_count: 250 ✓
4. Hai con số EQUAL → exposure balanced
5. Tab "Tags" → group theo variant để xem latency riêng:
   - http_req_duration{variant=a}
   - http_req_duration{variant=control}
```


## Đọc dashboard real-time charts cho case 05

Run thật đã verify bằng wrapper:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-05-ab-variant.js
```

Run đã verify:

```text
run #24
percentile_source = k6_summary

VUS = 100
ITERS_PER_VU = 5
total_iterations = 100 × 5 = 500
```

Summary quan trọng:

```text
iterations.................: 500
http_reqs..................: 750
variant_a_count............: 250
variant_control_count......: 250
checks_succeeded...........: 100.00%  500 out of 500
checks_failed..............: 0.00%    0 out of 500
http_req_failed............: 0.00%

http_req_duration avg......: 49.68ms
http_req_duration p95......: 333.13ms
http_req_duration p99......: 496.91ms
http_req_duration max......: 598.30ms
```

Request breakdown:

| Endpoint | Count | Ý nghĩa |
| --- | ---: | --- |
| `homefeed` | 500 | mọi view đều gọi feed chính |
| `recommendations` | 250 | chỉ variant A gọi thêm recommendation |
| Tổng | 750 | đúng bằng `summary http_reqs` |

Đọc nhanh:

```text
- Workload đủ: 500/500 iterations
- Exposure cân bằng: 250 A + 250 control
- HTTP sạch: 0 fail
- checks sạch: 500/500 pass
=> Run PASS: A/B exposure fair, đủ dữ liệu để so sánh tiếp.
```

Điểm học quan trọng:

```text
Exposure fair KHÔNG tự nói variant nào thắng.
```

Nó chỉ đảm bảo:

```text
hai nhóm có cùng số view -> so sánh latency/conversion không bị lệch cỡ mẫu
```

Muốn chọn variant, phải đọc thêm tag/breakdown theo `variant` hoặc metric
nghiệp vụ như conversion.

### 1. Overview có 3 chart cần đọc

| Chart | Câu hỏi trong A/B exposure test | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | aggregate latency của feed/recommendations có spike không? | không tự quyết định A thắng control |
| Execution timeline | 100 VU tạo 750 request trong thời gian nào? | không tự chứng minh exposure 250/250 |
| VUs vs iter/s | đã chạy đủ 500 views chưa? | không tự phân biệt variant A/control |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request tổng thể
Execution timeline -> request/view dồn vào bucket nào
VUs vs iter/s      -> đủ 500 view không
Custom metrics     -> exposure có cân bằng 250/250 không
Tags               -> latency/conversion từng variant
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #24:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| buckets | 3 | run rất ngắn, tải dồn vào ít bucket |
| total samples | 750 | đúng bằng `summary http_reqs` |
| weighted avg | 49.68ms | latency trung bình của cả homefeed + recommendations |
| summary p95 | 333.13ms | 95% request dưới ~333ms |
| summary p99 | 496.91ms | tail gần 500ms |
| summary max | 598.30ms | request chậm nhất |
| bucket p95 peak | 496.64ms | bucket có tail cao nhất |
| bucket max peak | 598.30ms | max chart khớp summary max |

Đọc thực tế:

```text
- aggregate avg khá thấp
- p95/p99 cao hơn avg nhiều -> có nhóm endpoint/request nặng hơn
- recommendations có thể nặng hơn homefeed, nhưng chart aggregate chưa đủ để kết luận
```

#### Cách phân tích sâu chart Response time

Với A/B test, response chart aggregate chỉ là bước đầu. Hỏi 4 câu:

```text
1. aggregate latency có spike làm run không đáng tin không?
2. spike đến từ endpoint nào: homefeed hay recommendations?
3. spike thuộc variant A hay control?
4. exposure 250/250 có cân bằng trước khi so latency không?
```

Run #24:

```text
variant_a_count = 250
variant_control_count = 250
http_req_failed = 0
```

nên dữ liệu đủ sạch để so sánh. Nhưng muốn nói A nhanh/chậm hơn control,
không dùng chart aggregate này một mình. Cần xem:

```text
http_req_duration{variant:a}
http_req_duration{variant:control}
hoặc breakdown/tag theo endpoint + variant
```

Shape cần cảnh giác:

| Shape | Nghĩa có thể có |
| --- | --- |
| aggregate p95 cao nhưng exposure cân bằng | có endpoint/variant nặng, cần drill-down tag |
| p95 cao chỉ ở variant A | variant A có cost performance |
| p95 cao nhưng count lệch | chưa được so sánh, phải sửa exposure trước |
| http fail ở một variant | variant đó có stability regression |

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #24:

| Bucket | VUs | HTTP reqs | Iterations | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 100 | 171 | 26 | 100 user bắt đầu, nhiều request chưa hoàn thành iter |
| 2 | 100 | 471 | 312 | phần lớn views/recommendations dồn vào bucket giữa |
| 3 | 35 | 108 | 162 | tail: nhiều VU đã xong, còn nhóm cuối hoàn thành quota |

Kiểm tổng:

```text
sum(httpReqs) = 171 + 471 + 108 = 750 = summary http_reqs ✓
sum(iterations) = 26 + 312 + 162 = 500 = summary iterations ✓
```

Đọc thực tế:

```text
- test rất ngắn và bursty vì 100 VUs chỉ chạy 5 views/user
- bucket giữa là nơi tải cao nhất: 471 HTTP reqs, 312 iterations
- VUs giảm còn 35 ở tail vì nhiều VU đã hoàn thành đủ 5 iterations
```

Vì sao `http_reqs > iterations`?

```text
500 iterations = 500 homefeed views
variant A có thêm 250 recommendations requests
=> total http_reqs = 500 + 250 = 750
```

### Batch 1 giây / time bucket đọc như nào?

Trong case 05:

```text
http_reqs trong bucket  = homefeed + recommendations
iterations trong bucket = số page view hoàn thành
```

Một bucket có thể có nhiều HTTP request hơn iteration vì variant A tạo thêm
request recommendation. Do đó không được kỳ vọng hai series bằng nhau.

Verify đúng:

```text
sum(httpReqs) = 750
sum(iterations) = 500
```

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #24:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 100 | 26 | 171 | start burst, nhiều request đang in-flight |
| 2 | 100 | 312 | 471 | peak view throughput |
| 3 | 35 | 162 | 108 | tail hoàn thành nốt views |

Kiểm tổng:

```text
sum(Actual iter/s) = 26 + 312 + 162 = 500 = summary iterations ✓
sum(httpReqs) = 171 + 471 + 108 = 750 = summary http_reqs ✓
```

Chart này chứng minh:

```text
đã tạo đủ 500 view trên 100 user.
```

Chart này KHÔNG chứng minh:

```text
A/control cân bằng hay variant nào tốt hơn.
```

Cân bằng phải đọc ở:

```text
variant_a_count = 250
variant_control_count = 250
```

### 2. Tab Executor / Execution

Case 05 có VU tail giảm rõ vì:

```text
100 VUs × chỉ 5 iterations/user
```

Nhiều VU hoàn thành rất nhanh, nên cuối run chỉ còn một phần VU active. Đây là
shape đúng của `per-vu-iterations`, không phải thiếu tải.

Executor tab dùng để kiểm:

```text
- start đủ 100 VUs
- final iterations = 500
- không dropped/interrupted
- VU tail giảm sau khi quota hoàn thành
```

### 3. `metrics_push_count` khác `pointCount` — không phải bug

Run ngắn, ít bucket. Không cần `pointCount` bằng metrics push count. Cách kiểm
đúng:

```text
171 + 471 + 108 = 750
26 + 312 + 162 = 500
```

### 4. Endpoint debug series theo metric

```text
GET http://localhost:13001/v1/tests/24/series?metric=http_reqs
GET http://localhost:13001/v1/tests/24/series?metric=iterations
GET http://localhost:13001/v1/tests/24/series?metric=http_req_duration
GET http://localhost:13001/v1/tests/24/series?metric=variant_a_count
GET http://localhost:13001/v1/tests/24/series?metric=variant_control_count
```

Khi phân tích sâu variant, ưu tiên tab Tags / breakdown theo `variant` hơn là
aggregate response-time chart.

### 5. Checklist đọc biểu đồ case 05

| Bước | Câu hỏi | Kết quả run #24 |
| --- | --- | --- |
| 1 | `iterations == 500`? | 500 ✓ |
| 2 | `http_reqs == 750`? | 750 ✓ |
| 3 | `variant_a_count == 250`? | 250 ✓ |
| 4 | `variant_control_count == 250`? | 250 ✓ |
| 5 | hai count equal? | 250 = 250 ✓ |
| 6 | request breakdown đúng? | homefeed 500 + recommendations 250 ✓ |
| 7 | checks fail? | 0 ✓ |
| 8 | chart `httpReqs` sum = 750? | 171+471+108=750 ✓ |
| 9 | chart `iterations` sum = 500? | 26+312+162=500 ✓ |
| 10 | có chọn winner từ aggregate latency không? | không, cần per-variant data |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #24 |
| --- | --- | --- |
| Workload | summary + VUs vs iter/s | đủ 500 views |
| Exposure | custom metrics | 250 A + 250 control cân bằng |
| HTTP health | summary + Response time | 0 fail, aggregate p95 có tail nhưng sạch |
| Request mix | breakdown | 500 homefeed + 250 recommendations |
| Execution shape | timeline / Executor | 100 VU burst ngắn, VU giảm tail bình thường |
| Final verdict | tổng hợp | PASS: exposure fair, đủ điều kiện so sánh variant |

## Kết luận thực tế: đọc output này thì team product quyết định gì?

Mục tiêu nghiệp vụ: chạy A/B test với **exposure cân bằng tuyệt đối**
(50/50) để so sánh variant A với control fair. Nếu phơi nhiễm lệch, mọi
kết luận "variant A tốt hơn" đều vô giá trị.

Nhắc lại kỳ vọng: variant A = 250 view, control = 250 view, EQUAL.

### Kịch bản A — cân bằng + có chênh latency: CHỌN ĐƯỢC VARIANT

```text
variant_a_count.......: 250
variant_control_count.: 250        (EQUAL ✓)
http_req_failed.......: 0.00%

http_req_duration{variant=a}.......: p95=1.2s
http_req_duration{variant=control}.: p95=1.8s
```

Kết luận thực tế:

```text
- 250 = 250 -> exposure cân bằng -> so sánh FAIR
- variant A p95 1.2s vs control 1.8s -> A nhanh hơn 33% trên cùng tải
- 0 fail -> A không đánh đổi độ ổn định lấy tốc độ
=> QUYẾT ĐỊNH: roll out variant A. Kết luận đáng tin vì hai nhánh nhận
   ĐÚNG cùng số view (không phải "A nhanh hơn vì tình cờ nhận ít view").
```

### Kịch bản B — count lệch: KẾT QUẢ KHÔNG ĐÁNG TIN

```text
variant_a_count.......: 290
variant_control_count.: 210        (LỆCH 290 vs 210!)
```

Kết luận thực tế:

```text
- Phơi nhiễm lệch 58/42 thay vì 50/50
- mọi so sánh latency/conversion giữa 2 nhánh giờ bị nhiễu bởi cỡ mẫu khác nhau
- KHÔNG kết luận được variant nào tốt hơn (giống yêu cầu "fair" của case 01)
=> QUYẾT ĐỊNH: bỏ kết quả run này. Điều tra vì sao lệch:
   - logic assign sai (vd __VU%2 nhưng VU bắt đầu từ số lẻ)?
   - có VU bị drop/interrupt làm thiếu view một nhánh?
   Sửa rồi chạy lại tới khi count EQUAL mới phân tích tiếp.
```

### Kịch bản C — cân bằng nhưng latency ngang nhau: KHÔNG ĐỦ BẰNG CHỨNG

```text
variant_a_count.......: 250
variant_control_count.: 250        (EQUAL ✓)

http_req_duration{variant=a}.......: p95=1.79s
http_req_duration{variant=control}.: p95=1.81s
```

Kết luận thực tế:

```text
- Exposure fair, nhưng chênh latency chỉ ~1% -> nằm trong nhiễu
- không đủ cơ sở nói A tốt hơn control
=> QUYẾT ĐỊNH: chưa roll out chỉ dựa trên latency. Cần thêm metric
   nghiệp vụ (conversion, click-through) hoặc tăng cỡ mẫu (iterations/vus)
   để thấy khác biệt thật. "Cân bằng" chỉ đảm bảo so sánh đúng, không tự
   tạo ra khác biệt.
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| 250=250, A nhanh hơn rõ | so sánh fair, A thắng | roll out A |
| count lệch (≠ 250) | exposure không fair | bỏ run, sửa assign |
| 250=250, latency ngang | fair nhưng không khác biệt | thêm metric/cỡ mẫu |
| http_req_failed > 0 ở 1 nhánh | variant đó kém ổn định | điều tra trước khi chọn |
| tổng ≠ 500 | test chưa chạy đủ | sửa count, chạy lại |

Điểm cốt lõi: **giá trị của case này KHÔNG ở chỗ "A hay control nhanh
hơn", mà ở chỗ đảm bảo so sánh FAIR**. Vì per-vu cố định 50 VU mỗi nhánh
× 5 view, exposure luôn đúng 250/250 — bất kỳ khác biệt nào sau đó là tín
hiệu thật về variant, không phải do cỡ mẫu lệch.

## Mở rộng

```js
const variants = ["a", "b", "c", "control"];
userVariant = variants[__VU % 4];
// 25% mỗi variant với vus chia hết cho 4
```

### B: Sticky session với cookie

```js
// Iter 0: server set cookie ab_variant=a
// Iter 1-4: client gửi cookie, server lookup variant
const jar = http.cookieJar();
// per-VU jar đảm bảo cookie sticky theo VU
```

### C: Verify conversion rate per variant

```js
const conversionA = new Counter("conversion_a");
const conversionControl = new Counter("conversion_control");

// Mock: variant A có conversion rate cao hơn
const converted = userVariant === "a" ? Math.random() < 0.15 : Math.random() < 0.10;
if (converted) {
  if (userVariant === "a") conversionA.add(1);
  else conversionControl.add(1);
}
```

## Anti-pattern

```text
❌ Random variant mỗi iter:
   const variant = Math.random() < 0.5 ? "a" : "control";
   -> 1 user xem 5 trang với variant khác nhau
   -> phá hỏng A/B test (user không có experience nhất quán)

❌ ramping-vus với lazy assign:
   server-side assign variant khi VU đầu tiên hit
   -> ramp 0->100 trong 60s, 30s đầu chỉ có 50 VU -> 50 variant A liên tiếp
   -> exposure skew theo time
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- A/B testing best practice: variant assignment phải sticky per user
