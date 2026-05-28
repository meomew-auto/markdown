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

## Why per-vu-iterations?

```text
Variant assignment cần DETERMINISTIC:
  - userVariant = __VU % 2 (0=A, 1=control)
  - 1 user = 1 variant cố định qua tất cả iter
  - Iter 0 lưu variant, iter 1-4 dùng cùng variant đó

ramping-vus skew exposure:
  - Variant lazy assign theo time -> số user A/control không đều
  - vd: ramping 0->100 trong 1 phút, 30s đầu chỉ có VU 1-50 (toàn A)

constant-vus với short duration:
  - VU pool random pick -> 1 user có thể bị spam, 1 user không xuất hiện
  - Exposure không balance
```

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

```js
let userVariant = null;
let userSegment = null;

if (__ITER === 0) {
  userVariant = __VU % 2 === 0 ? "a" : "control";
  userSegment = __VU < 50 ? "premium" : "free";
}
```

→ VU=1 → control, VU=2 → A, VU=3 → control, ... balanced 50/50.

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
