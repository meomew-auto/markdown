# Case 05: Personalized homefeed

## Tình huống thực tế

Team products/personalization muốn giữ một nhóm readers active để xem personalized homefeed và recommendations.

Personalization phụ thuộc variant, geo, device, cache/model. Cần quan sát steady active readers, không phải warm một fixed URL list.

Case này trả lời: 25 personalized readers trong 5 phút tạo ra latency/error pattern thế nào theo homefeed vs recommendations?

Tóm tắt đời thường:

```text
Executor model: fixed active user pool
VUs: 25
Duration: 5m
Think time: 0.4s
Team/service focus: products/personalization
```

Case này không hỏi:

```text
Có xử lý đủ N job không?
Có đạt đúng X RPS không?
Mỗi user có chạy đúng N vòng không?
```

Nó hỏi:

```text
Nếu giữ 25 active users trong 5m,
latency/error/natural throughput của flow này ra sao?
```

### Vì sao "Personalized homefeed" buộc chọn constant-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của personalized homefeed test trước:

```text
Personalized homefeed test = "giữ 25 readers đang thật sự đọc feed,
                              mỗi reader loop homefeed + recommendations,
                              quan sát latency tự nhiên khi backend chậm"

Đời thường:
  25 độc giả (= 25 VU) ngồi đọc báo online
  Mỗi độc giả: lướt homefeed → bấm vào 1 bài → đọc recommendations của bài đó
  Xong thì lướt homefeed tiếp (loop)
  Mỗi độc giả có AB variant, geo, device class riêng → trải nghiệm khác nhau
  Test chạy 5 phút → quan sát: độc giả nào thấy chậm? operation nào kéo latency?
```

Để personalized homefeed test **có giá trị**, nó phải trả lời được câu hỏi cốt lõi: **khi backend personalization chậm đi, 25 readers thấy latency thay đổi thế nào?** Chỉ constant-vus mới trả lời được câu hỏi này một cách tự nhiên nhất.

### Yêu cầu (a): STEADY ACTIVE READER POOL (không phải fixed job list)

**Ý nghĩa**: Giữ đúng 25 readers active trong 5 phút. Không quan trọng mỗi reader đọc bao nhiêu bài — quan trọng là khi backend chậm, throughput tự giảm.

**Ví dụ cụ thể**:

```text
Scenario: team personalization deploy model mới, muốn biết 25 readers thấy latency ra sao

Trường hợp A (model cũ, nhanh):
  loop_duration = 0.4s → 25 VUs × 5m / 0.4s ≈ 1875 iterations
  RPS ≈ 25/0.4 × 2 API/loop ≈ 125 RPS
  → Throughput cao, user thấy nhanh

Trường hợp B (model mới, chậm hơn):
  loop_duration = 1.2s → 25 VUs × 5m / 1.2s ≈ 625 iterations
  RPS ≈ 25/1.2 × 2 API/loop ≈ 42 RPS
  → Throughput thấp hơn, user thấy chậm hơn
  → ĐÂY LÀ TÍN HIỆU CẦN THẤY, không phải bug của test
```

**Vì sao iterations không nên là target cố định?**

```text
Nếu đặt target iterations = 1000:
  - Model nhanh → đạt 1000 dễ, dư thời gian
  - Model chậm → không đạt 1000, test fail
  - Nhưng test fail KHÔNG PHẢI vì "hệ thống lỗi"
  - Mà vì model chậm → đây là tín hiệu đúng cần capture

Nếu đặt target = duration 5m:
  - Model nhanh → 1875 iter, p95 homefeed = 80ms
  - Model chậm → 625 iter, p95 homefeed = 350ms
  - Cả 2 đều PASS test (vì duration-based)
  - Nhưng latency + throughput khác nhau → SO SÁNH ĐƯỢC giữa 2 model
```

**Vì sao duration-based mới đúng?** Với shared-iterations (iterations=1000), T_run = 1000 × iter_time / 25. Khi iter_time=0.4s → T_run=16s (quá ngắn!), khi iter_time=1.2s → T_run=48s (vẫn không đủ 5m). Observation window thay đổi theo latency, không mô phỏng được "25 độc giả ngồi đọc đúng 5 phút". Với constant-vus (duration=5m), T_run luôn = 5m, N_done = 25 × 300 / iter_time là output tự nhiên. Window cố định → steady-state được bảo đảm, throughput + latency phản ánh đúng backpressure.

| Executor | Observation window | Throughput khi backend chậm | Phù hợp active readers? |
| --- | --- | --- | --- |
| **constant-vus** | duration cố định | Tự giảm (closed model) | CÓ: window cố định, throughput là output |
| shared-iterations | T_run = iter × iter_time / vus | Cố gắng giữ count | KHÔNG: window thay đổi, không steady |
| constant-arrival-rate | duration cố định | Cố gắng giữ rate | KHÔNG: bơm rate, bỏ qua backpressure |

→ Observation window phải CỐ ĐỊNH để thấy steady-state
→ Throughput phải là OUTPUT để thấy backpressure
→ Chỉ constant-vus thỏa mãn cả 2

### Yêu cầu (b): SEGMENTATION VISIBILITY (mỗi reader có variant/geo/device riêng)

**Ý nghĩa**: 25 readers không giống nhau. Mỗi reader thuộc về một AB variant, một geo country, một device class. Nếu chỉ nhìn aggregate latency, variant B chậm có thể bị variant A nhanh "che".

**Bug segmentation blindness là gì?**

```text
Trường hợp ĐÚNG — tag theo segment:
  VU=1 (variant=A, geo=US, device=desktop): homefeed=80ms, rec=200ms
  VU=2 (variant=B, geo=VN, device=mobile):  homefeed=350ms, rec=800ms
  ...
  → Lọc dashboard theo variant=B → thấy ngay latency cao
  → Kết luận: variant B có vấn đề

Trường hợp SAI — chỉ nhìn aggregate:
  Aggregate p95 homefeed = 250ms (tưởng OK)
  Nhưng variant=A p95 = 100ms, variant=B p95 = 450ms
  → 40% user (variant B) thấy chậm gấp 4.5 lần
  → Nhưng aggregate không nói điều này
```

**Vì sao constant-vus phù hợp cho segmentation test?**

```text
Trong constant-vus:
  - __VU ổn định suốt 5 phút → identity reader ổn định
  - Có thể gán cố định: VU=1 luôn là variant=A, geo=US, device=desktop
  - Mỗi VU loop nhiều lần → quan sát latency của cùng một segment qua thời gian
  - Nếu variant=B chậm từ phút thứ 2 → thấy rõ trên timeline của VU variant=B

Trong shared-iterations:
  - __VU là worker, không phải identity
  - VU=1 có thể chạy variant=A ở iter #0 rồi variant=B ở iter #5
  - Không quan sát được "cùng một segment qua thời gian"
```

## Yêu cầu cứng của case này

- Giữ 25 active readers trong 5m.
- Homefeed và recommendations phải đọc riêng theo operation.
- AB/geo/device dimensions phải được giữ nhất quán trong headers/tags nếu dashboard hỗ trợ.
- Failed loops phải dưới `constant_active_iterations_failed count<20`.

Các invariant chung:

```text
vus + duration = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì RPS giảm
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

## Vì sao "Personalized homefeed" nên dùng `constant-vus`?

Đây là steady active reader model. `constant-vus` đúng vì ta muốn natural throughput của 25 readers, không muốn fixed cache-key backlog hay target RPS.

Mental model:

```text
25 active VUs start.
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

### Đi sâu: closed model với personalization

Personalization đặc biệt nhạy với closed model: mỗi loop gọi 2 API (homefeed + rec), một API chậm → cả loop chậm → 25 VU cùng kẹt → iter/s giảm mạnh. Đây là tín hiệu chuẩn, không phải bug. Ngược lại, open model (constant-arrival-rate) cố bơm request theo rate bất kể response time — khi backend chậm, drop tăng nhưng RPS vẫn cố giữ, không phản ánh "user thật thấy chậm và đợi".

### Demo số: closed model slowdown

```text
Config: vus=25, duration=5m, sleep=0.4s
```

| Kịch bản | homefeed | rec | loop_duration | iter/s | total_iter | RPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A — warm cache | 80ms | 120ms | 0.6s | 41.7 | ~12,500 | ~83 |
| B — cold cache | 300ms | 500ms | 1.2s | 20.8 | ~6,250 | ~42 |
| C — rất chậm | 500ms | 900ms | 1.8s | 13.9 | ~4,170 | ~28 |

Từ A→C: iter/s giảm 67%, RPS giảm 67%, nhưng VUs vẫn = 25 → closed-model backpressure thuần túy.

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho case steady active users? |
| --- | --- | --- |
| `constant-vus` | Giữ N active users trong duration T | **Đúng**: input chính là concurrency + observation window; throughput là output tự nhiên. |
| `shared-iterations` | Cũng có nhiều VU cùng làm việc | Sai nếu không có backlog hữu hạn cần drain đủ; nó tối ưu fixed total jobs, không phải active users over time. |
| `per-vu-iterations` | VU có thể là user identity ổn định | Sai nếu không cần mỗi user chạy đúng N vòng; nó biến test thành quota replay, không phải steady active pool. |
| `constant-arrival-rate` | Có thể giữ RPS cố định | Sai nếu muốn quan sát closed-model backpressure; arrival-rate sẽ cố bơm traffic theo rate. |
| `ramping-vus` | Mô phỏng user tăng/giảm | Sai nếu requirement là active concurrency phẳng để lấy baseline. |
| `ramping-arrival-rate` | Mô phỏng campaign/surge | Sai cho steady baseline; nó thay đổi target arrivals theo thời gian. |

### Phân tích sâu: vì sao shared-iterations và arrival-rate sai?

`shared-iterations` có observation window thay đổi theo latency (T_run = iterations × iter_time / vus). Muốn window = 5m phải tính ngược iterations = 5m × vus / iter_time, nhưng iter_time không biết trước. `constant-arrival-rate` cố bơm rate bất kể response time → drop iteration khi backend chậm, trong khi user thật không bị "drop" — họ chỉ đợi lâu hơn. Chỉ constant-vus có observation window cố định + throughput tự nhiên → phản ánh đúng trải nghiệm active readers (xem phân tích chi tiết ở phần Yêu cầu (a) phía trên).

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
CV_05_VUS = 25
CV_05_DURATION = 5m
CV_05_SLEEP_SECONDS = 0.4
```

| Config/env | Giá trị | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `CV_05_VUS` | 25 | Số active personalized readers |
| `CV_05_DURATION` | 5m | Observation window |
| `CV_05_SLEEP_SECONDS` | 0.4 | Think time giữa feed reads |

Threshold cap riêng:

```text
constant_active_iterations_failed: count<20
```

### Mapping quan trọng

```text
business active readers    = 25 users
k6 vus                     = 25
observation window         = 5m
think time per loop        = 0.4s
expected API/loop          = 2 (homefeed + recommendations)
API calls total            = iterations × 2 (output, not input)
```

`duration` không phải deadline để đạt target iterations. Nó là observation window. Nếu trong 5m backend nhanh thì nhiều iterations, chậm thì ít iterations. Cả 2 đều valid.

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

### Identity model cho personalized homefeed

Trong case này, `__VU` CÓ THỂ dùng làm reader identity vì:

```text
1. VU ổn định trong suốt 5m → identity reader ổn định
2. Mỗi reader có AB variant, geo, device class cố định
3. Có thể gán segment dựa trên __VU:
   - __VU 1-10: variant=A, geo=US, device=desktop
   - __VU 11-18: variant=B, geo=VN, device=mobile
   - __VU 19-25: variant=A, geo=EU, device=tablet
4. Segment assignment ổn định → quan sát được latency per segment theo thời gian
```

Khác với shared-iterations:

```text
shared-iterations: __VU = worker, không phải identity
  → VU=1 chạy job #0 (SKU A) rồi job #5 (SKU F)
  → KHÔNG dùng __VU làm identity

constant-vus: __VU = active user, identity ổn định
  → VU=1 luôn là reader-1, variant=A, geo=US
  → DÙNG ĐƯỢC __VU làm identity
```

### Code pattern: per-VU segment assignment

```js
import exec from "k6/execution";
import { sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";

// Segment pools
const VARIANTS = ["control", "experiment_b", "experiment_c"];
const GEO_COUNTRIES = ["US", "VN", "EU", "SG", "JP"];
const DEVICE_CLASSES = ["desktop", "mobile", "tablet"];

// Gán segment cố định cho từng VU dựa trên __VU
function getSegment(vuId) {
  return {
    variant: VARIANTS[(vuId - 1) % VARIANTS.length],
    geo: GEO_COUNTRIES[(vuId - 1) % GEO_COUNTRIES.length],
    device: DEVICE_CLASSES[(vuId - 1) % DEVICE_CLASSES.length],
  };
}

export default function () {
  const vuId = exec.vu.idInTest;  // 1..25
  const segment = getSegment(vuId);

  const headers = {
    "X-Ab-Variant": segment.variant,
    "X-Geo-Country": segment.geo,
    "X-Device-Class": segment.device,
  };

  const tags = {
    ab_variant: segment.variant,
    geo_country: segment.geo,
    device_class: segment.device,
    operation: "personalized_homefeed",
    case_id: "cv-05-personalized-homefeed",
  };

  // Homefeed
  const homefeedRes = http.get(`${BASE_URL}/api/sim/products/homefeed`, {
    headers,
    tags,
  });

  // Recommendations (dùng 1 product id từ homefeed response hoặc static fallback)
  const recTags = { ...tags, operation: "personalized_recommendations" };
  const recRes = http.get(`${BASE_URL}/api/sim/products/PROD-001/recommendations`, {
    headers,
    tags: recTags,
  });

  sleep(0.4);
}
```

**Phân phối segment**: VU 1-9→control, 10-17→experiment_b, 18-25→experiment_c (xen kẽ geo/device theo modulo). Mỗi VU giữ nguyên segment suốt 5m → trên dashboard lọc theo `ab_variant=experiment_b` sẽ thấy latency toàn bộ VU thuộc variant đó.

## Technical root causes this case catches

Case này được thiết kế để bắt 4 root causes phổ biến trong hệ thống personalization. Mỗi root cause có demo trace + cách phát hiện riêng.

---

### Nguyên nhân kỹ thuật 1: Personalized responses can be slower than generic catalog

**Vấn đề**: Homefeed và recommendations cá nhân hóa có model/cache/DB cost khác biệt cơ bản so với catalog list/detail generic. Learner dễ ngạc nhiên khi thấy cùng một endpoint path nhưng latency cao hơn hẳn case catalog audit.

**Vì sao personalization chậm hơn?**

```text
Generic catalog list/detail:
  - Query SELECT * FROM products WHERE ... (shared query, cacheable)
  - Redis/Memcached hit rate cao vì data shared
  - Không cần model inference
  - Response giống nhau cho mọi user

Personalized homefeed/recommendations:
  - Query phức tạp: JOIN user_preferences, user_history, collaborative_filter
  - Cache hit rate thấp vì per-user data
  - Model inference: ML model chạy real-time để rank/re-rank
  - Cold start: user mới hoặc cache miss → query fallback chậm hơn
  - Response khác nhau cho từng user
```

**Demo trace: catalog generic vs personalized**

```text
Catalog audit (shared-iterations, generic list/detail):
  list endpoint:   avg=50ms,  p95=120ms
  detail endpoint: avg=80ms,  p95=200ms
  job duration:    avg=130ms, p95=320ms

Personalized homefeed (constant-vus, personalized):
  homefeed endpoint:         avg=150ms, p95=350ms
  recommendations endpoint:  avg=300ms, p95=800ms
  loop duration:             avg=450ms, p95=1150ms

Khác biệt: homefeed 150ms vs list 50ms (3x)
           recommendations 300ms vs detail 80ms (3.75x)
           loop 450ms vs job 130ms (3.5x)

→ Personalization cost ≈ 3-4x generic catalog
→ Đây là EXPECTED, không phải bug — nhưng cần measure để biết baseline
```

**Closed model amplification**:

```text
Với catalog generic (iter_time=0.5s bao gồm sleep):
  iter/s ≈ 25 / 0.5 = 50 iter/s
  RPS ≈ 100 req/s

Với personalization (iter_time=0.85s bao gồm sleep):
  iter/s ≈ 25 / 0.85 = 29.4 iter/s
  RPS ≈ 58.8 req/s

Personalization không chỉ chậm hơn 3x về latency,
mà còn làm throughput giảm ~41% do closed model.
→ Mỗi VU "đọc" ít bài hơn trong cùng 5 phút
→ User thấy ít content hơn → business impact
```

**Cách phát hiện**:

```text
1. So sánh constant_flow_duration_ms giữa case này và case catalog (nếu có)
2. Tách http_req_duration theo operation (homefeed vs recommendations)
3. Nếu cả 2 operation đều > 2x catalog generic → personalization cost expected
4. Nếu 1 operation chậm đột biến → root cause khác (xem nguyên nhân 3, 4)
```

---

### Nguyên nhân kỹ thuật 2: AB/device/geo segmentation

**Vấn đề**: Headers `X-Ab-Variant`, `X-Geo-Country`, `X-Device-Class` có thể tạo behavior khác nhau giữa các segment. Nếu không tag và lọc theo segment, aggregate metrics sẽ che dấu segment-specific regression.

**Vì sao segmentation quan trọng với personalization?**

```text
1. AB Test:
   - Variant A (control): model cũ, nhẹ, nhanh
   - Variant B (experiment): model mới, nặng hơn, chậm hơn
   - Nếu variant B chậm 3x nhưng chỉ chiếm 20% traffic:
     Aggregate p95 tăng nhẹ, không ai để ý
     Nhưng 20% user variant B thấy chậm rõ rệt

2. Geo:
   - US users: hit US edge cache → nhanh
   - VN users: miss cache, go to origin US → chậm hơn
   - Hoặc: VN users dùng model riêng (ngôn ngữ, xu hướng địa phương)

3. Device Class:
   - Desktop: full recommendations (10 items, ảnh lớn)
   - Mobile: lightweight recommendations (5 items, ảnh nhỏ)
   - Nghịch lý: mobile "nhẹ hơn" nhưng query có thể phức tạp hơn
     (phải filter theo device-specific catalog)
```

**Demo trace: segmentation latency skew**

```text
Config: 25 VU, 5m, segmentation gán theo __VU

Segment A (control, US, desktop) — 9 VU:
  homefeed: avg=80ms,  p95=150ms
  rec:      avg=150ms, p95=300ms
  loop:     avg=630ms (gồm sleep 0.4s)

Segment B (experiment, VN, mobile) — 8 VU:
  homefeed: avg=350ms, p95=600ms
  rec:      avg=700ms, p95=1500ms
  loop:     avg=1450ms (gồm sleep 0.4s)

Segment C (control, EU, tablet) — 8 VU:
  homefeed: avg=120ms, p95=250ms
  rec:      avg=250ms, p95=500ms
  loop:     avg=770ms (gồm sleep 0.4s)

Aggregate (không lọc segment):
  homefeed: avg=183ms, p95=450ms
  rec:      avg=367ms, p95=800ms
  loop:     avg=950ms

Nhìn aggregate: "homefeed p95=450ms, rec p95=800ms → OK, chấp nhận được"
Nhưng lọc segment B: "homefeed p95=600ms, rec p95=1500ms → KHÔNG ỔN"
→ Segment B users thấy rec chậm gấp 5 lần segment A
→ Aggregate che dấu hoàn toàn vấn đề này
```

**Vì sao aggregate không đủ cho segmentation test?**

```text
Nguyên lý thống kê:
  - p95 của aggregate ≠ trung bình của các p95 segment
  - p95 aggregate = percentile thứ 95 của TOÀN BỘ sample gộp lại
  - Nếu segment A (80% sample) nhanh, segment B (20% sample) chậm:
    p95 aggregate có thể vẫn nằm trong khoảng "nhanh" của segment A
    vì 95% sample đến từ segment A + 1 phần segment B

Ví dụ cụ thể:
  1000 samples: 800 từ segment A (p95=300ms), 200 từ segment B (p95=1500ms)
  Sắp xếp 1000 samples theo latency tăng dần:
    sample #1-#800:  từ segment A (50-300ms)
    sample #801-#950: từ segment A tail + segment B (300-500ms)
    sample #951-#1000: từ segment B (500-1500ms)
  p95 = sample #950 ≈ 500ms ← VẪN ỔN trong aggregate!
  Nhưng p95 của riêng segment B = sample #190/200 trong 200 sample B = 1500ms

→ Kết luận: Aggregate p95 = 500ms (đẹp)
  Nhưng 20% user thấy p95 = 1500ms (chậm)
```

**Cách phát hiện**:

```text
1. Tag mọi request với ab_variant, geo_country, device_class
2. Trên dashboard, lọc lần lượt theo từng tag value
3. So sánh p95 giữa các segment:
   - Nếu p95 variant B > 2x variant A → variant B có vấn đề
   - Nếu p95 geo VN > 2x geo US → geo routing/cache issue
   - Nếu p95 device mobile > device desktop → mobile path issue
4. Đừng chỉ nhìn aggregate p95 rồi kết luận
```

---

### Nguyên nhân kỹ thuật 3: Recommendations dominate loop duration

**Vấn đề**: Recommendation endpoint có thể kéo full user-loop duration dù homefeed nhanh. Trong flow homefeed → recommendations, nếu homefeed mất 80ms nhưng recommendations mất 800ms, loop duration = 880ms. Recommendations chiếm 91% loop duration.

**Vì sao recommendations thường chậm hơn homefeed?**

```text
Homefeed:
  - Thường pre-computed: top N bài viết/sản phẩm trending
  - Cacheable per segment (variant × geo × device)
  - Không cần real-time model inference (hoặc model nhẹ)
  - Query: lấy N items từ bảng feed đã ranked sẵn

Recommendations:
  - Thường real-time: phải tính similarity/user preferences
  - Khó cache vì per-user + per-item
  - Model inference nặng: collaborative filtering, embedding similarity
  - Query: JOIN nhiều bảng (user_history, item_features, similar_items)
  - Có thể gọi external service (recommendation engine riêng)
```

**Demo trace: recommendations kéo loop**

```text
25 VU, sleep=0.4s

Kịch bản A — homefeed nhanh, recommendations nhanh:
  homefeed: avg=80ms,  p95=150ms
  rec:      avg=150ms, p95=300ms
  loop:     avg=80+150+400(sleep) = 630ms
  iter/s:   25/0.63 = 39.7

Kịch bản B — homefeed nhanh, recommendations CHẬM:
  homefeed: avg=80ms,  p95=150ms  ← không đổi
  rec:      avg=800ms, p95=1500ms ← tăng 5.3x!
  loop:     avg=80+800+400(sleep) = 1280ms
  iter/s:   25/1.28 = 19.5  ← giảm 51%

Kịch bản C — homefeed CHẬM, recommendations nhanh:
  homefeed: avg=400ms, p95=800ms  ← tăng 5x
  rec:      avg=150ms, p95=300ms  ← không đổi
  loop:     avg=400+150+400(sleep) = 950ms
  iter/s:   25/0.95 = 26.3  ← giảm 34%

So sánh tác động:
  Rec chậm 5x → iter/s giảm 51%
  Homefeed chậm 5x → iter/s giảm 34%
  → Rec có tác động lớn hơn vì baseline rec đã cao hơn homefeed
  → Rec thường là bottleneck chính trong flow personalization
```

**Cách phát hiện**:

```text
1. Tách http_req_duration theo operation trên dashboard
2. Tính % contribution của mỗi operation vào loop duration:
   contribution_rec = avg_rec / (avg_homefeed + avg_rec)
   Nếu contribution_rec > 60% → rec là bottleneck
3. So sánh p95 giữa homefeed và rec:
   Nếu p95_rec > 3x p95_homefeed → rec cần investigation trước
4. Correlation: iter/s giảm có trùng với thời điểm rec latency tăng không?
```

---

### Nguyên nhân kỹ thuật 4: Aggregate requests hide operation bottleneck

**Vấn đề**: Tổng requests hoặc aggregate p95 không nói homefeed hay recommendations gây vấn đề. Đây là vấn đề universal cho mọi multi-operation flow.

**Các dạng "che" của aggregate**:

```text
Dạng 1 — latency che:
  Aggregate http_req_duration p95 = 600ms → tưởng OK
  Nhưng homefeed p95 = 120ms, rec p95 = 1100ms
  → Rec chậm gấp 9x homefeed nhưng aggregate không nói

Dạng 2 — error rate che:
  Aggregate http_req_failed = 2% → tưởng "hơi cao"
  Nhưng homefeed failed = 0%, rec failed = 4%
  → Rec error rate gấp đôi aggregate → cần điều tra rec riêng

Dạng 3 — throughput che:
  Aggregate iter/s = 25 → tưởng ổn định
  Nhưng iter/s giảm từ 35 xuống 18 ở phút thứ 3
  → Backend slow down nửa sau của test
  → Cần xem timeline, không chỉ con số cuối cùng

Dạng 4 — count che:
  Tổng http_reqs = 10,000 → tưởng "đủ API calls"
  Nhưng homefeed = 6,000, rec = 4,000
  → Thiếu 1,000 rec calls → có thể rec bị skip/timeout ở 1,000 loops
  → Mỗi loop phải có 1 homefeed + 1 rec → rec count phải bằng homefeed count
```

**Demo trace: aggregate đẹp nhưng operation xấu**

```text
Run 5m, 25 VU, sleep=0.4s

Summary aggregate:
  http_reqs:          8,400
  http_req_failed:    1.8%
  http_req_duration:  avg=340ms, p95=650ms
  iterations:         4,200

Nhìn aggregate → "p95=650ms, fail<2% → PASS"

Nhưng tách operation:

  homefeed:
    count:       4,200
    failed:      0.2%
    duration:    avg=90ms,  p95=180ms

  recommendations:
    count:       4,200
    failed:      3.4%     ← CAO!
    duration:    avg=590ms, p95=1200ms ← CHẬM!

→ Rec error rate 3.4% là unacceptable cho personalized feed
→ Rec p95=1200ms là chậm đáng kể
→ Nhưng aggregate che cả 2 vấn đề này

Nguyên nhân aggregate "đẹp":
  - avg=(90+590)/2=340ms ← bị homefeed nhanh kéo xuống
  - failed=(0.2+3.4)/2=1.8% ← bị homefeed thấp kéo xuống
  - p95=650ms ← weighted percentile, homefeed sample nhiều hơn trong khoảng thấp
```

**Cách phát hiện**:

```text
1. LUÔN tách metric theo tag operation, không chỉ đọc aggregate
2. Đọc dashboard với filter operation=personalized_homefeed và operation=personalized_recommendations riêng
3. So sánh count 2 operation: phải bằng nhau (mỗi loop 1 homefeed + 1 rec)
4. So sánh failed rate 2 operation: nếu lệch > 2x → operation-specific issue
5. So sánh p95 2 operation: nếu lệch > 3x → bottleneck rõ ràng
```

---

### Tổng kết 4 root causes: ma trận chẩn đoán

| Triệu chứng aggregate | Có thể là root cause nào? | Cách khoanh vùng |
| --- | --- | --- |
| p95 aggregate cao hơn baseline | #1 Personalization cost hoặc #3 Rec dominate | So với catalog generic baseline |
| p95 aggregate OK nhưng user kêu chậm | #2 Segmentation (segment minority chậm) | Lọc theo ab_variant, geo, device |
| iter/s thấp hơn kỳ vọng | #3 Rec dominate hoặc #1 Personalization cost | Xem contribution % của rec vào loop |
| p95 aggregate OK, fail rate OK nhưng... | #4 Aggregate che (một operation xấu) | Tách operation, so sánh từng metric |

## Service/API flow

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| personalized_homefeed | products-service | GET | /api/sim/products/homefeed | 200 | Read personalized homefeed. |
| personalized_recommendations | products-service | GET | /api/sim/products/:id/recommendations | 200 | Read recommendations. |

Các operation này phải được đọc bằng tag `operation`, vì aggregate metrics có thể che branch nhỏ nhưng chậm.

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
case_id       = cv-05-personalized-homefeed
business_case = personalized_homefeed
workload      = steady_concurrency
```

### Tags segmentation riêng cho case này

| Tag | Giá trị ví dụ | Dùng để |
| --- | --- | --- |
| `ab_variant` | `control`, `experiment_b`, `experiment_c` | Lọc latency theo AB variant |
| `geo_country` | `US`, `VN`, `EU`, `SG`, `JP` | Lọc latency theo geo |
| `device_class` | `desktop`, `mobile`, `tablet` | Lọc latency theo device |

## Pass criteria

Pass criteria tối thiểu theo backend script:

```text
checks rate > 0.99
http_req_failed rate < 0.01
constant_active_iterations_failed count<20
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

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-05-personalized-homefeed.js
```

Run local summary:

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-05-personalized-homefeed.js
```

Run lên private dashboard:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-05-personalized-homefeed.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = constant-vus
vus = 25 hoặc env override
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

- `iterations` là số feed loops, không phải số users.
- `constant_flow_duration_ms` đo full feed+recommendation loop.
- Phải đọc operation breakdown để tránh aggregate che bottleneck.
- Phải đọc segmentation tags (ab_variant, geo_country, device_class) nếu muốn phát hiện segment-specific regression.

## Đọc dashboard real-time charts cho case 05

> Phần này mô tả cách đọc expected dashboard. Chỉ thêm run ID/số p95/bucket thật sau khi chạy thật.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm? | Total iterations target, vì không có target đó |
| Execution timeline | VUs/RPS/iter/s thay đổi theo time thế nào? | Business branch nào chậm nếu không lọc operation |
| VUs vs iter/s | VUs có flat không, iter/s có giảm không? | Fixed RPS target, vì constant-vus không config RPS |

Một cách đọc nhanh:

```text
Response time      -> chất lượng request, phát hiện bottleneck, SO SÁNH operation
Execution timeline -> active user behavior theo thời gian, phát hiện closed-model slowdown
VUs vs iter/s      -> xác nhận active-user pool phẳng, phát hiện backpressure
```

### Chart 1 — Response time

Đọc theo `operation`:

```text
personalized_homefeed: GET /api/sim/products/homefeed
personalized_recommendations: GET /api/sim/products/:id/recommendations
```

Cách đọc:

```text
http_req_duration       = latency từng request
constant_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Cách phân tích sâu chart Response time cho case personalization

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 5 câu hỏi:

```text
1. Operation nào chậm hơn — homefeed hay recommendations?
2. Chênh lệch p95 giữa 2 operation là bao nhiêu?
3. Có segment nào (variant/geo/device) có latency khác biệt không?
4. p95 có tăng theo thời gian không (cache cold → warm hay ngược lại)?
5. Tail latency (p99, max) có spike bất thường không?
```

Với case 05, shape đẹp thường có:

```text
đầu run:  p95 homefeed + rec có thể cao hơn (cache cold, model warm-up)
giữa run: p95 ổn định, rec thường cao hơn homefeed (expected)
cuối run: p95 không tăng bất thường
```

Vì sao đầu run dễ cao hơn?

```text
- Personalization model cold start: model chưa loaded vào memory
- User-specific cache miss: request đầu tiên cho mỗi VU/segment chưa có cache
- Connection pool init: connections đến DB/cache chưa được warm
- Nếu dùng external ML service: lần đầu gọi chậm hơn (DNS, TLS, connection)
```

Case-specific hints:

- Response time: tách `personalized_homefeed` và `personalized_recommendations`.
- Execution timeline: RPS drop có thể do model/recommendation latency tăng.
- VUs vs iter/s: flat VUs + iter/s giảm là personalization backpressure.

#### Shape xấu cần chú ý

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| p95 rec >> p95 homefeed ( > 5x) | Rec algorithm/model quá nặng | Investigate recommendation service/path |
| p95 homefeed >> p95 rec | Homefeed composition/cache issue | Inspect homefeed pipeline |
| p95 cả 2 cùng tăng theo thời gian | Memory leak, DB connection pool cạn | Soi flow_duration theo timeline |
| p95 variant B >> variant A ( > 3x) | AB experiment model chậm | Route về team experiment |
| p95 geo VN >> geo US ( > 2x) | Geo routing hoặc cache regional issue | Kiểm CDN/edge cache config |
| p95 mobile >> desktop | Mobile path kém tối ưu | Kiểm mobile-specific query/model |
| max spike lẻ tẻ nhưng p95 ổn | Vài outlier đơn lẻ | Xem log nhưng chưa vội fail |
| p95 và max cùng spike nhiều bucket | Vấn đề hệ thống thật | Chặn / điều tra backend |

### Chart 2 — Execution timeline

Với constant-vus:

```text
VUs should be flat near 25 during regular phase.
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

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, 25 readers tạo ra bao nhiêu iterations? RPS có ổn định không?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — 25 readers có đang active đủ không?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations hoàn thành mỗi bucket — bao nhiêu loop xong trong giây đó?
```

Với `constant-vus`, shape "đẹp" thường là:

```text
đầu run:
  Live VUs tăng dần lên 25 (VU initialization)
  RPS/iter/s tăng dần khi VUs bắt đầu loop

giữa run:
  Live VUs = 25 (phẳng)
  RPS/iter/s dao động nhẹ theo loop completion timing
  iter/s ~= 25 / loop_duration

cuối run:
  Live VUs vẫn = 25 cho đến khi duration hết
  Có thể thấy end-tail effect (gracefulStop)
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không lên được 25 | VU init có vấn đề, config/env sai, hoặc maxVUs không đủ |
| VUs flat nhưng iter/s = 0 hoặc rất thấp | VU bị kẹt trong request, backend treo |
| VUs tụt giữa run | VU bị lỗi/exception, hoặc dashboard ingestion gap |
| iter/s giảm dần trong khi VUs flat | Closed-model slowdown: backend ngày càng chậm |
| iter/s spike không đều | Có thể do recommendation response time biến thiên mạnh |
| end-tail iter/s = 0 nhưng VUs vẫn > 0 | gracefulStop: VUs không nhận iteration mới |

#### Batch 1 giây / time bucket

Giống như các case khác, mỗi point trên chart là 1 time bucket gom tất cả metric samples trong cùng 1 giây:

```text
01:09:19
→ mọi sample có timestamp trong khoảng 01:09:19.000 -> 01:09:19.999
→ được gom vào chung 1 point trên chart
```

Trong 1 bucket đó có thể có:

```text
- 25 VU cùng chạy (mỗi VU đang ở 1 loop khác nhau)
- Nhiều HTTP request hoàn thành (cả homefeed + recommendations)
- Một số iteration/loop hoàn thành
- Nhiều check pass/fail
```

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

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Active user pool có thật sự phẳng không?
Throughput iteration có bám theo shape VU không?
Có dấu hiệu backpressure không?
```

Với `constant-vus`, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate ≈ vus / loop_duration
         ≈ 25 / loop_duration

Nếu loop_duration avg = 0.6s (sleep 0.4s + API 0.2s):
  peak_rate ≈ 25 / 0.6 ≈ 41.7 iter/s

Nếu loop_duration avg = 1.2s (sleep 0.4s + API 0.8s):
  peak_rate ≈ 25 / 1.2 ≈ 20.8 iter/s

Nếu loop_duration avg = 1.8s (sleep 0.4s + API 1.4s):
  peak_rate ≈ 25 / 1.8 ≈ 13.9 iter/s
```

Shape mong đợi:

```text
- đầu run: iter/s tăng dần khi VU init xong và bắt đầu loop
- giữa run: iter/s dao động ổn định, VUs = 25
- cuối run: iter/s về 0 khi duration hết, VUs về 0 khi gracefulStop xong
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| `Actual iter/s` đầu = 0, sau đó tăng dần | VU đang init, loop đầu chưa xong | bình thường |
| `Actual iter/s` dao động theo bucket | Nhiều loop finish không cùng thời điểm | bình thường |
| `Actual iter/s` = 0 lâu trong khi VUs = 25 | VU bị kẹt trong request, backend cực chậm | cần điều tra |
| `Actual iter/s` giảm dần, VUs vẫn = 25 | closed-model backpressure: backend chậm dần | điều tra latency/flow duration |
| `Actual iter/s` tụt về 0 và VUs cũng về 0 | test xong duration + gracefulStop | bình thường |
| VUs không lên tới 25 | config/env sai, VU init lỗi, maxVUs thấp | kiểm header |
| VUs dao động (không flat) | dashboard ingestion issue hoặc VU crash/restart | kiểm config, logs |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận failures/thresholds trước.
2. VUs vs iter/s xác nhận active-user pool có phẳng không.
3. Execution timeline cho thấy RPS/iter/s là output theo time.
4. Response time by operation tìm service/branch chậm.
5. Response time by segment (variant/geo/device) tìm segment-specific regression.
6. Business decision dựa trên failures + latency + closed-model throughput change.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **personalization health check**: output ra số như vậy thì team quyết định gì với personalization service?

### Kịch bản A — output sạch: PERSONALIZATION PASS

```text
iterations................: ~10,000+ (output, cao)
http_req_failed...........: 0.2%
constant_active_iterations: ~10,000+
constant_active_iterations_failed: 2
homefeed p95..............: 150ms
rec p95...................: 300ms
constant_flow_duration_ms p95: 850ms (gồm sleep 0.4s)
VUs.......................: flat 25
Lọc segment: tất cả variant/geo/device p95 gần bằng nhau
```

Kết luận thực tế:

```text
- Latency ổn định, không operation nào vượt trội
- Segmentation không có skew
- Throughput output cao (backend khỏe)
=> QUYẾT ĐỊNH: Personalization OK. Accept baseline.
```

### Kịch bản B — recommendations chậm: INVESTIGATE RECOMMENDATION

```text
iterations................: ~6,000 (output, thấp hơn kỳ vọng)
homefeed p95..............: 120ms (nhanh)
rec p95...................: 1100ms (CHẬM)
constant_flow_duration_ms p95: 1600ms
VUs.......................: flat 25
iter/s....................: giảm dần từ 35 → 18
```

Kết luận thực tế:

```text
- Homefeed vẫn nhanh → không phải vấn đề chung
- Rec chậm gấp 9x homefeed → recommendation là bottleneck
- iter/s giảm do closed model: VU đợi rec response lâu hơn
=> QUYẾT ĐỊNH: Inspect recommendation service/path.
   - Kiểm tra model inference time
   - Kiểm tra DB query cho collaborative filtering
   - Kiểm tra external service dependency
```

### Kịch bản C — homefeed chậm: INSPECT HOMEFEED

```text
iterations................: ~7,000
homefeed p95..............: 800ms (CHẬM)
rec p95...................: 250ms (bình thường)
constant_flow_duration_ms p95: 1450ms
```

Kết luận thực tế:

```text
- Homefeed chậm bất thường → không phải personalization nói chung
- Rec vẫn OK → recommendation pipeline không vấn đề
=> QUYẾT ĐỊNH: Inspect homefeed composition/cache.
   - Homefeed pre-computation có bị delay không?
   - Cache cho homefeed segment có bị miss không?
   - Có thay đổi gì trong homefeed ranking gần đây không?
```

### Kịch bản D — một variant/geo/device worse: SEGMENT-SPECIFIC REGRESSION

```text
Aggregate:
  homefeed p95: 250ms
  rec p95:      450ms
  → Nhìn aggregate: "OK, pass"

Lọc theo ab_variant=experiment_b:
  homefeed p95: 600ms  ← 4x aggregate!
  rec p95:      1200ms ← 2.7x aggregate!

Lọc theo ab_variant=control:
  homefeed p95: 120ms
  rec p95:      250ms
  → Control variant OK

Lọc theo geo_country=VN:
  homefeed p95: 400ms
  rec p95:      900ms
  → Geo VN chậm hơn可能是因为 variant B được gán nhiều cho VN
```

Kết luận thực tế:

```text
- Aggregate đẹp nhưng 1 segment minority chậm
- Variant B (experiment) chậm hơn control 4-5x
- Cần cross-reference: variant B users ở geo nào?
=> QUYẾT ĐỊNH: Route đến personalization/cache owner.
   - Variant B model có vấn đề → rollback hoặc optimize
   - Nếu variant B là experiment → cân nhắc tắt experiment
   - Nếu geo-specific → kiểm tra regional cache/routing
```

### Bảng ánh xạ nhanh output → hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| both operations pass + latency stable | Personalization steady pool OK | Accept baseline |
| recommendation slower | Algorithm/model/data bottleneck | Inspect recommendation service/path |
| homefeed slower | Homefeed composition/cache issue | Inspect homefeed |
| one variant/device/geo worse | Segment-specific regression | Route to personalization/cache owner |
| iter/s giảm dần, VUs flat | Closed-model backpressure | Investigate latency/flow duration trend |
| aggregate p95 OK but segment p95 high | Segmentation blindness | Lọc dashboard theo segment tags |
| homefeed count ≠ rec count | Có loop bị skip 1 operation | Kiểm script flow, error handling |

## Real run — default constant-vus baseline after case-05 fix

Run verify qua local cloud/dashboard sau khi case 05 được fix và k6 helper gửi `X-User-ID: ctx.userId`:

```text
Run ID: #99
Script: cv-05-personalized-homefeed.js
Exit code: 0
summary_pushed: true
finish_status: 200
Config: 25 VUs, duration 5m, default sleep/env
```

### Summary chính

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `23,730 / 0` |
| `http_req_failed_rate` | `0` |
| `iterations` | `11,865` |
| `iterations_rate` | `39.47/s` |
| `http_reqs` | `23,730` |
| `http_reqs_rate` | `78.94/s` |
| `vus_min/vus_max` | `25 / 25` |
| `constant_flow_duration_ms avg/med/p95/p99/max` | `232.59 / 201 / 400 / 500 / 911 ms` |
| `http_req_duration avg/med/p95/p99/max` | `116.18 / 100.06 / 201.19 / 299.00 / 806.37 ms` |

Request breakdown:

```text
personalized_homefeed GET 200 count=11,865
personalized_recommendations GET 200 count=11,865
```

### Đọc 3 chart dashboard cho run #99

**Chart 1 — Response time.** `http_req_duration` p95 ~201.19ms; `constant_flow_duration_ms` p95 ~400ms. Không có HTTP/check failures, percentile lấy từ `k6_summary`.

**Chart 2 — Execution timeline.** `iterations` sum 11,865, `http_reqs` sum 23,730 = 2×iterations. Homefeed và recommendations đều 11,865, không thiếu branch.

Dashboard/API bucket summary:

```text
iterations buckets: count=300, sum=11865, min=30.00, max=49.00
http_reqs points:    count=15009, sum=23730, min=1.00, max=3.00
constant_active_iterations points: count=7502, sum=11865
constant_active_iterations_failed points: count=0
```

**Chart 3 — VUs vs iter/s.** VUs flat đúng 25 trong 300 buckets. Iter/s bucket 30–49 phản ánh loop completion/latency/think-time, không phải VU drop.

```text
vus buckets: count=300, min=25.00, max=25.00, avg=25.00
```

### Backend verdict

```text
PASS — personalization/homefeed functional clean sau case-05 fix.
```

Không cần báo BE cho case 05.

## Nghịch lý và misconceptions của constant-vus

Đừng dùng case này để chứng minh cache warm coverage. Đây là active personalized reader behavior.

### Nghịch lý 1: Aggregate p95 đẹp mà user kêu chậm?

```text
Đây là nghịch lý segmentation blindness phổ biến nhất.

Tình huống:
  Dashboard aggregate: p95 homefeed = 250ms, p95 rec = 500ms
  → "Nhìn OK, có gì đâu mà kêu?"
  Nhưng user variant B kêu chậm, user geo VN kêu chậm

Giải thích:
  - 80% users thuộc variant A (control, nhanh)
  - 20% users thuộc variant B (experiment, chậm)
  - Aggregate p95 = percentile 95 của toàn bộ sample
  - 80% sample nhanh + 15% sample trung bình = 95% sample < 500ms
  - 5% sample chậm nhất (toàn bộ từ variant B) đẩy p95 lên 500ms
  - Nhưng p95 của riêng variant B = 1200ms!
  - 20% user thấy p95 = 1200ms → họ kêu chậm là ĐÚNG

Cách giải:
  - LUÔN lọc dashboard theo segment tags
  - So sánh p95 từng segment, không chỉ aggregate
  - Nếu 1 segment có p95 > 3x segment khác → đó là vấn đề thật
```

### Nghịch lý 2: 25 VU đọc homefeed sao iter/s thấp?

```text
Đây là câu hỏi phổ biến khi learner thấy iter/s thấp hơn kỳ vọng.

Tình huống:
  Config: vus=25, sleep=0.4s
  Kỳ vọng: iter/s ≈ 25 / 0.4 = 62.5
  (vì "sleep 0.4s, mỗi VU 1 loop mất 0.4s, 25 VU → 62.5 iter/s")
  Thực tế: iter/s = 20.8
  → "Sao thấp vậy? Có bug gì không?"

Giải thích:
  loop_duration = homefeed_time + rec_time + sleep_time
                = 0.3s + 0.5s + 0.4s = 1.2s
  iter/s = 25 / 1.2 = 20.8

  Kỳ vọng 62.5 chỉ đúng nếu API time = 0.
  API time thực tế = 0.8s → loop_duration = 1.2s
  → iter/s giảm 67% so với kỳ vọng naive

Cách giải:
  - Đọc constant_flow_duration_ms để biết loop duration thật
  - Tính iter/s = vus / loop_duration
  - Recommendations thường là thủ phạm chính kéo loop duration
  - Đây không phải bug — đây là tín hiệu personalization cost
```

### Nghịch lý 3: Cache warm ≠ active readers

```text
Đây là điểm khác biệt CỐT LÕI giữa case này và shared-iterations cache-warm case.

Shared-iterations cache-warm:
  - Mục tiêu: gọi MỖI URL trong fixed list ĐÚNG 1 LẦN để warm cache
  - Input: danh sách URL cố định, iterations = số URL
  - Kết thúc: khi đã gọi hết URL list
  - Model: fixed backlog worker pool

Constant-vus personalized homefeed:
  - Mục tiêu: giữ 25 readers active, loop liên tục
  - Input: vus=25, duration=5m
  - Kết thúc: sau 5 phút
  - Model: steady active user pool
  - KHÔNG có fixed URL list — mỗi VU gọi homefeed + rec của chính mình
  - Cùng 1 VU gọi homefeed NHIỀU LẦN trong 5m (loop)
  - Cache được warm tự nhiên qua các loop, nhưng đó không phải mục tiêu

So sánh trực quan:
  Cache-warm (shared-iterations):
    "8 công nhân kiểm 80 thùng hàng, mỗi thùng 1 lần, xong nghỉ"

  Active readers (constant-vus):
    "25 độc giả ngồi đọc báo 5 phút, đọc đi đọc lại, không ai đếm số bài"
```

### Nghịch lý 4: iteration_duration = 1.2s nhưng iter/s = 20.8?

```text
iteration_duration: avg=1.2s     <- 1 loop mất 1.2 giây
iterations:         20.8/s       <- nhưng 1 giây ra 20.8 loop

Sao 1 loop mất 1.2s mà mỗi giây lại ra được 20.8 loop?
"Lẽ ra 1.2s mới ra 1 loop chứ?"
```

**Trả lời: vì 25 VU chạy SONG SONG, không phải 1 VU.**

```text
iteration_duration = thời gian 1 VU làm xong 1 loop = 1.2s
iterations rate    = tổng loop hoàn thành / tổng thời gian (cả pool) = 20.8/s

Công thức nối 2 con số (Little's Law):
  rate = vus / loop_duration
  20.8 ≈ 25 / 1.2 ✓

Ví dụ trực quan:
  25 độc giả, mỗi người đọc 1 bài mất 1.2 phút:
    - 1 bài VẪN mất 1.2 phút (không nhanh hơn)
    - nhưng 25 người đọc song song -> mỗi phút ra ~20.8 bài được đọc xong
```

Nhớ 3 câu:

```text
vus + duration = input
iterations/RPS = output
backend chậm -> RPS giảm là tín hiệu đúng của closed model
```

## Checklist đọc biểu đồ case 05

Khi học sinh nhìn dashboard case 05, đọc theo thứ tự này:

```text
1. Overview KPI
   - checks > 99%?
   - http_req_failed < 1%?
   - constant_active_iterations_failed < 20?

2. Response time chart — SO SÁNH OPERATION
   - Tách theo operation (homefeed vs recommendations) chưa?
   - Operation nào chậm hơn? Chênh lệch bao nhiêu?
   - p95 rec có > 3x p95 homefeed không?
   - batch p95 đầu có spike (cold start) không?
   - cuối test p95 có tăng không (leak/slowdown)?

3. Response time chart — LỌC SEGMENT
   - Lọc theo ab_variant: variant nào chậm nhất?
   - Lọc theo geo_country: geo nào chậm nhất?
   - Lọc theo device_class: device nào chậm nhất?
   - Có segment nào p95 > 3x segment khác không?

4. Execution timeline
   - Live VUs có = 25 trong regular phase không?
   - RPS/iter/s có ổn định hay giảm dần?
   - Nếu giảm dần: có correlate với rec latency tăng không?
   - Cuối run: gracefulStop có bất thường không?

5. VUs vs iter/s
   - VUs có flat = 25 không?
   - Actual iter/s dao động thế nào?
   - Có dấu hiệu backpressure (VUs flat, iter/s giảm) không?
   - Actual iter/s có khớp công thức vus/loop_duration không?

6. Business decision
   - Tất cả counters pass?
   - Segmentation có skew không?
   - Operation nào là bottleneck?
   - Nếu tất cả pass -> personalization baseline OK
   - Nếu 1 segment/operation chậm -> route investigation
```

Kết luận của run case 05 đang đúng nếu thấy:

```text
checks > 99%
http_req_failed < 1%
constant_active_iterations_failed < 20
VUs: flat = 25 trong toàn regular phase
iter/s: dao động ổn định, không giảm dần bất thường
homefeed p95: trong ngưỡng chấp nhận được
rec p95: trong ngưỡng chấp nhận được (có thể cao hơn homefeed, expected)
Các segment: không có segment nào p95 > 3x segment khác
executor = constant-vus
```

## Mở rộng

- Tăng `VUS` để xem service chịu active concurrency cao hơn ra sao.
- Tăng `DURATION` để biến case thành stability/soak ngắn.
- Tăng/giảm sleep để thấy think time tác động đến RPS.
- Thêm threshold theo `constant_flow_duration_ms` hoặc operation p95 nếu muốn biến baseline thành performance gate.

### Variation 1: AB test — so sánh 2 variant models

```powershell
# Gán variant = control cho tất cả VU
$env:CV_05_AB_VARIANT = "control"
k6 run -o cloud .\cv-05-personalized-homefeed.js

# Gán variant = experiment_b cho tất cả VU
$env:CV_05_AB_VARIANT = "experiment_b"
k6 run -o cloud .\cv-05-personalized-homefeed.js
```

So sánh 2 run: nếu experiment_b có p95 > 2x control → model mới chậm hơn đáng kể.

### Variation 2: Geo segmentation — test regional cache/routing

```powershell
# Gán geo = US cho tất cả VU
$env:CV_05_GEO_COUNTRY = "US"
k6 run -o cloud .\cv-05-personalized-homefeed.js

# Gán geo = VN cho tất cả VU
$env:CV_05_GEO_COUNTRY = "VN"
k6 run -o cloud .\cv-05-personalized-homefeed.js
```

So sánh latency US vs VN. Nếu VN chậm hơn đáng kể → regional routing hoặc edge cache issue.

### Variation 3: Device class impact

```powershell
# Test riêng desktop vs mobile
$env:CV_05_DEVICE_CLASS = "desktop"
k6 run .\cv-05-personalized-homefeed.js

$env:CV_05_DEVICE_CLASS = "mobile"
k6 run .\cv-05-personalized-homefeed.js
```

Phát hiện: mobile path đôi khi nặng hơn desktop vì phải transform/optimize response.

### Variation 4: Latency threshold per segment

```js
export const options = {
  thresholds: {
    // Homefeed: chặt hơn vì đây là surface chính user thấy đầu tiên
    "http_req_duration{operation:personalized_homefeed}": ["p(95)<400"],

    // Recommendations: nới hơn vì personalization model có thể chậm hơn
    "http_req_duration{operation:personalized_recommendations}": ["p(95)<800"],

    // Segment-specific: variant B không được chậm quá 2x control
    "http_req_duration{ab_variant:experiment_b}": ["p(95)<600"],

    // Geo-specific: VN users không được chậm quá 1.5x US
    "http_req_duration{geo_country:VN}": ["p(95)<500"],
  },
};
```

Chuyển từ passive observation sang active performance gate.

### Variation 5: Multi-scenario — active readers + cache warm đồng thời

```js
scenarios: {
  active_readers: {
    executor: "constant-vus",
    vus: 25,
    duration: "5m",
    tags: { case_id: "cv-05-personalized-homefeed" },
  },
  cache_warm: {
    executor: "shared-iterations",
    vus: 4,
    iterations: 120,
    startTime: "5s",
    tags: { case_id: "si-05-cache-warm" },
  },
},
```

Quan sát: cache warm có làm giảm latency của active readers không? (Nếu có → cache efficiency quan trọng với personalization)

## Anti-pattern

- Dùng total `iterations` như pass/fail target cứng.
- Kỳ vọng fixed RPS từ `constant-vus`.
- So sánh 2 run có sleep/duration/VUs khác nhau rồi kết luận backend regress.
- Chỉ nhìn aggregate p95 trong flow nhiều operation.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với per-user quota của `per-vu-iterations`.
- Chỉ nhìn aggregate p95, không lọc theo segment (variant/geo/device).
- Cho rằng sleep=0.4s là loop duration (bỏ qua API time).
- Dùng `constant-arrival-rate` để "giữ RPS ổn định" rồi kết luận "hệ thống OK" trong khi user thật thấy chậm (closed model vs open model).
- Gán segment ngẫu nhiên mỗi loop (không giữ ổn định theo VU) → mất khả năng quan sát segment-specific behavior theo thời gian.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Constant-vus quick index: `../../20260516_01_constant-vus-quick-index.md`
- Tham số/công thức: `../../20260516_02_constant-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-vus\cv-05-personalized-homefeed.js`
