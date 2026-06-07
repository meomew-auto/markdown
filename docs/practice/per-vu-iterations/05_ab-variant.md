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

## Mở rộng

### A: Multi-variant 4-way split

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
