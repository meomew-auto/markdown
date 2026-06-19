# Case 07: Predictable batch validation cho CI

## Tình huống thực tế

Pre-merge gate trong CI/CD pipeline. Cần test:

```text
- Chạy CHÍNH XÁC 1000 iter
- 2000 http request total
- p95 latency thay đổi < 10% so với baseline
- Fail PR nếu vượt threshold
```

CI cần con số ổn định để compare baseline qua các lần PR.

## Vì sao "CI gate" buộc chọn per-vu-iterations?

Trước khi vào kỹ thuật, hiểu **CI gate** và **baseline** là gì:

```text
CI gate = "cổng kiểm tra tự động" trước khi merge code:
  - Mỗi PR chạy test -> so với baseline (lần chạy chuẩn trước đó)
  - Nếu chậm hơn baseline > 10% -> CHẶN merge (fail PR)
  - Mục đích: bắt regression performance TRƯỚC khi lên production

Baseline = "mốc chuẩn" để so sánh:
  - vd baseline p95 = 500ms (đo từ lần chạy ổn định)
  - PR mới p95 = 560ms -> tăng 12% -> fail

Đời thường:
  Cân sức khỏe mỗi tháng. Để so "béo lên hay không" thì lần nào
  cũng phải cân CÙNG ĐIỀU KIỆN (sáng, đói, cùng cân) -> mới fair.
```

Để CI gate **không báo nhầm** (flaky), phải đảm bảo **2 yêu cầu cốt lõi**.
Chỉ per-vu-iterations mới thỏa mãn cả 2.

### Yêu cầu (a): COUNT CHÍNH XÁC (cùng workload mỗi lần chạy)

**Ý nghĩa**: Mỗi lần CI chạy phải gửi ĐÚNG cùng số request. Nếu count biến
thiên → p95 đo trên tập khác nhau → so baseline vô nghĩa.

```text
Flow đúng (count cố định tuyệt đối):
  PR #1: 1000 iter, 2000 req, p95=500ms  (baseline)
  PR #2: 1000 iter, 2000 req, p95=560ms  -> tăng 12%, regression thật
  PR #3: 1000 iter, 2000 req, p95=490ms  -> OK

Vì sao per-vu đảm bảo?
  - total = vus × iterations = 50 × 20 = 1000 (TUYỆT ĐỐI)
  - Mỗi lần chạy luôn đúng 1000, bất kể server nhanh/chậm
  - p95 đo trên cùng 1000 mẫu -> so baseline fair
```

**Vì sao executor khác fail?**

```text
✗ constant-vus duration "5m":
  - count = 5min × throughput -> biến thiên theo latency
  - PR #1: 4800 req (server nhanh), PR #2: 4200 req (server chậm)
  - p95 đo trên tập KHÁC nhau -> không so được
  - CI báo "regression" nhầm dù code không đổi -> FLAKY

✗ constant-arrival-rate:
  - Có thể drop -> count = 9000 hoặc 8500 tùy lần
  - Tập mẫu khác -> baseline drift
```

### Yêu cầu (b): REPRODUCIBLE RPS (tải tái lập được, không flaky)

**Ý nghĩa**: Pattern tải (bao nhiêu request đồng thời, theo nhịp nào) phải
giống nhau mỗi lần. Nếu pattern đổi → p95 đổi → false alarm.

**3 nguyên nhân kỹ thuật khiến CI gate bị flaky**:

#### Nguyên nhân 1: COUNT BIẾN THIÊN → FALSE REGRESSION

**Vấn đề**: nếu số request mỗi lần khác nhau, p95 tính trên tập khác → dao
động tự nhiên bị hiểu nhầm thành regression.

```text
Ví dụ p95 nhạy với số mẫu:
  Lần A: 4200 request, p95 = 480ms (ít mẫu, ít outlier)
  Lần B: 4800 request, p95 = 540ms (nhiều mẫu, dính outlier đuôi)
  -> chênh 12% NHƯNG do số mẫu khác, KHÔNG phải code chậm
  -> CI fail nhầm -> dev mất thời gian debug "bug ma"

→ per-vu: count cố định 1000 -> p95 luôn trên cùng cỡ mẫu -> ổn định
```

#### Nguyên nhân 2: BASELINE DRIFT (mốc chuẩn trôi dần)

**Vấn đề**: nếu mỗi lần update baseline từ 1 lần chạy có count khác nhau,
mốc chuẩn "trôi" dần → mất ý nghĩa.

```text
Baseline drift:
  Tuần 1: baseline = p95 của 4800 req = 500ms
  Tuần 2: update baseline = p95 của 4200 req = 470ms
  Tuần 3: update baseline = p95 của 5000 req = 530ms
  -> baseline nhảy 470-530, không biết đâu là chuẩn thật
  -> threshold 10% áp lên mốc trôi -> vô nghĩa

→ per-vu: mọi lần chạy đúng 1000 req -> baseline ổn định -> threshold đáng tin
```

#### Nguyên nhân 3: WARMUP CONTAMINATION (mẫu warmup làm bẩn p95)

**Vấn đề**: request đầu (JIT compile, cold cache, connection setup) chậm bất
thường. Nếu tỷ lệ warmup/total đổi mỗi lần → p95 đổi.

```text
Ví dụ:
  Lần A: 100 req, 30 req warmup chậm -> warmup chiếm 30% -> p95 cao
  Lần B: 1000 req, 30 req warmup -> warmup chiếm 3% -> p95 thấp
  -> cùng server, p95 khác nhau chỉ vì tỷ lệ warmup

Fix: count cố định -> tỷ lệ warmup cố định -> p95 so được
     (hoặc tag riêng warmup để loại khỏi threshold)

→ per-vu: 1000 iter mỗi lần -> 30/1000 warmup cố định -> p95 nhất quán
```

#### Tổng kết: chỉ per-vu thỏa mãn cả (a) và (b)

| Executor | (a) Count chính xác | (b) Reproducible RPS | Verdict |
| --- | --- | --- | --- |
| **per-vu-iterations** | ✓ vus × iters tuyệt đối | ✓ pattern cố định mỗi lần | ✅ DÙNG |
| shared-iterations | ✓ count cố định | ✗ phân phối VU không đều -> RPS lệch | ⚠️ gần được |
| constant-vus (duration) | ✗ count theo latency | ✗ RPS theo throughput biến thiên | ❌ |
| constant-arrival-rate | ✗ có thể drop | ✓ RPS cố định (nếu không drop) | ❌ |
| ramping-vus | ✗ count biến thiên | ✗ RPS thay đổi theo stage | ❌ |
| ramping-arrival-rate | ✗ count biến thiên | ✗ RPS thay đổi theo stage | ❌ |

**Lưu ý case này**: `shared-iterations` cũng có count cố định (a), nhưng thua
ở (b) — phân phối iter giữa VU không đều khiến RPS dao động. `per-vu` cho
cả count VÀ pattern phân bố đều nhất → baseline ổn định nhất.

→ Chỉ **per-vu-iterations** đảm bảo "count chính xác + RPS tái lập", điều
kiện BẮT BUỘC để CI gate không báo nhầm (flaky).

## Config

```js
const VUS = 50;
const ITERS_PER_VU = 20;
// Total = 50 × 20 = 1000 (chính xác)

export const options = {
  scenarios: {
    ci_batch: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERS_PER_VU,
      maxDuration: "10m",
    },
  },
  thresholds: {
    iterations: ["count==1000"],
    http_reqs: ["count==2000"],
    "http_req_duration{tag:critical}": ["p(95)<550"],  // baseline 500 + 10%
    http_req_failed: ["rate<0.01"],
  },
};
```

## Endpoint flow

```text
Mỗi iter:
  GET /
  GET /api/quotes
  sleep(0.1)

Total: 2 req × 1000 iter = 2000 req
```

> **Case này KHÔNG dùng per-VU state**: mỗi iter là 2 request độc lập,
> không có token, session, cart cần giữ qua iter. Đây là trường hợp
> đặc biệt — per-vu được chọn vì count chính xác, không phải vì state
> persistence. Các case khác (01-06) đều dùng state, xem
> [case 01 / Per-VU state](./01_user-journey-replay.md#per-vu-state).

## Pass criteria (CI gate)

```text
1. iterations == 1000 (chính xác)
2. http_reqs == 2000 (chính xác)
3. p95 < baseline × 1.10
4. http_req_failed < 1%
```

## CI integration

```powershell
# Set baseline từ lần chạy ổn định trước (commit vào repo CI config)
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:BASELINE_P95_MS = "500"

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-07-ci-batch.js

# Local run không cần cloud upload
k6 run --quiet .\examples\per-vu-iterations\pvi-07-ci-batch.js

if ($LASTEXITCODE -ne 0) {
  Write-Host "CI gate FAILED: regression detected"
  exit 1
}
```

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

**Verify trên UI** (dùng cloud output):

```text
1. Paste token, click run mới nhất
2. Tile "iterations": 1000 ✓ (chính xác)
3. Tile "http_reqs": 2000 ✓ (chính xác)
4. http_req_duration{name=homepage} p95 < 550ms (baseline 500 + 10%)
5. http_req_duration{name=api_quotes} p95 < 550ms
```

## Update baseline khi cần

```bash
# Sau khi optimize, p95 giảm xuống 400ms
# Update baseline:
echo "BASELINE_P95_MS=400" > ci-baseline.env
```


## Đọc dashboard real-time charts cho case 07

Run thật đã verify bằng wrapper:

```powershell
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:BASELINE_P95_MS = "500"
.\run-with-summary.ps1 .\examples\per-vu-iterations\pvi-07-ci-batch.js
```

Run đã verify:

```text
run #26
percentile_source = k6_summary

VUS = 50
ITERS_PER_VU = 20
total_iterations = 50 × 20 = 1000
```

Summary quan trọng:

```text
iterations.............: 1000
http_reqs..............: 2000
checks_succeeded.......: 100.00%  2000 out of 2000
checks_failed..........: 0.00%    0 out of 2000
http_req_failed........: 0.00%

http_req_duration avg..: 81.67ms
http_req_duration p95..: 200.57ms
http_req_duration p99..: 293.62ms
http_req_duration max..: 390.47ms
```

Request breakdown:

| Endpoint | Count | Ý nghĩa |
| --- | ---: | --- |
| `products_list` | 1000 | 1 request mỗi iteration |
| `cart_add` | 1000 | 1 request mỗi iteration |
| Tổng | 2000 | đúng bằng threshold `http_reqs == 2000` |

CI threshold:

```text
BASELINE_P95_MS = 500
TOLERANCE = 10%
allowed p95 = 500 × 1.10 = 550ms
actual p95 = 200.57ms
verdict = PASS
```

Đọc nhanh:

```text
- Count chính xác: 1000 iterations + 2000 requests
- Checks sạch: 2000/2000 pass
- HTTP sạch: 0 fail
- p95 thấp hơn ngưỡng 550ms rất nhiều
=> exit 0 đáng tin: CI gate pass vì workload đúng và latency đạt.
```

Điểm học quan trọng:

```text
Dashboard không thay thế CI exit code.
Dashboard giải thích vì sao exit code đáng tin hoặc không đáng tin.
```

### 1. Overview có 3 chart cần đọc

| Chart | Câu hỏi trong CI batch gate | Không dùng để kết luận gì? |
| --- | --- | --- |
| Response time | p95/p99 có gần vượt baseline không? | không thay thế threshold cuối test |
| Execution timeline | batch 1000 iter / 2000 req chạy ổn định không? | không tự quyết định merge nếu count thiếu |
| VUs vs iter/s | 50 VU tạo iter/s ổn định và đủ 1000 không? | không tự chứng minh endpoint checks pass |

Một cách đọc nhanh:

```text
Response time      -> gate latency có an toàn không
Execution timeline -> request/iteration count có đúng workload không
VUs vs iter/s      -> executor có giữ 50 VU và đủ 1000 iter không
Summary thresholds -> CI pass/fail cuối cùng
```

### Chart 1 — Response time

Chart debug:

```text
Debug JSON: response-time
```

Run #26:

| Metric | Giá trị | Cách đọc |
| --- | ---: | --- |
| buckets | 6 | dashboard có 6 bucket response-time |
| total samples | 2000 | đúng bằng `summary http_reqs` |
| weighted avg | 81.67ms | request trung bình nhanh |
| summary p95 | 200.57ms | số dùng cho gate p95 |
| summary p99 | 293.62ms | tail vẫn dưới 300ms |
| summary max | 390.47ms | request chậm nhất vẫn dưới 550ms |
| bucket p95 peak | 297.98ms | bucket tệ nhất vẫn dưới threshold |
| bucket max peak | 390.47ms | max chart khớp summary max |

Đọc thực tế:

```text
- summary p95 = 200.57ms < 550ms -> threshold pass
- bucket p95 peak ~298ms cũng còn xa ngưỡng
- max ~390ms thấp hơn cả ngưỡng p95, run rất an toàn về latency
```

Đừng nhầm:

```text
CI threshold dùng summary p95, không dùng max.
```

Max hữu ích để quan sát outlier, nhưng gate được thiết kế theo percentile để
tránh một request lẻ làm fail PR nếu không đại diện cho số đông.

#### Cách phân tích sâu chart Response time

Với CI gate, đọc chart theo 4 câu:

```text
1. summary p95 có vượt baseline×1.10 không?
2. bucket p95 có đoạn nào tiến sát ngưỡng không?
3. p99/max có outlier bất thường cần điều tra không?
4. count có đúng 1000/2000 trước khi tin latency không?
```

Run #26:

```text
iterations = 1000
http_reqs = 2000
p95 = 200.57ms < 550ms
checks_failed = 0
```

nên CI verdict pass là đáng tin.

Shape cần cảnh giác:

| Shape | Nghĩa có thể có |
| --- | --- |
| p95 > 550ms nhưng count đúng | performance regression thật |
| count thiếu nhưng p95 đẹp | gate invalid, không được merge |
| bucket p95 spike gần 550ms | PR có nguy cơ flakey, cần chạy lại/điều tra |
| http fail > 1% | functional regression, chặn PR |

### Chart 2 — Execution timeline

Chart debug:

```text
Debug JSON: execution-timeline
```

Run #26:

| Bucket | VUs | HTTP reqs | Iterations | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 50 | 360 | 145 | bắt đầu batch, nhiều request in-flight |
| 2 | 50 | 342 | 172 | throughput ổn định |
| 3 | 50 | 390 | 193 | peak request rate |
| 4 | 50 | 388 | 199 | peak iteration rate |
| 5 | 50 | 360 | 178 | steady batch |
| 6 | 50 | 160 | 113 | tail hoàn thành nốt quota |

Kiểm tổng:

```text
sum(httpReqs) = 360 + 342 + 390 + 388 + 360 + 160 = 2000 = summary http_reqs ✓
sum(iterations) = 145 + 172 + 193 + 199 + 178 + 113 = 1000 = summary iterations ✓
```

Đọc thực tế:

```text
- 50 VUs giữ ổn định trong active window
- mỗi iteration có 2 request nên HTTP reqs xấp xỉ 2 × iterations
- tổng count khớp threshold CI, nên latency được đo trên đúng workload
```

Vì sao HTTP request gấp đôi iterations?

```text
mỗi iteration:
  1 GET products_list
  1 POST cart_add
=> 1000 iterations × 2 = 2000 http_reqs
```

### Batch 1 giây / time bucket đọc như nào?

Trong case 07:

```text
iterations trong bucket = số CI iteration hoàn thành
http_reqs trong bucket  = products_list + cart_add request
```

Không so từng bucket theo tỷ lệ đúng tuyệt đối `2×`, vì request có thể rơi vào
bucket trước còn iteration completion rơi vào bucket sau. Cách kiểm đúng là
tổng toàn chart:

```text
sum(httpReqs) = 2000
sum(iterations) = 1000
```

### Chart 3 — VUs vs iter/s

Chart debug:

```text
Debug JSON: vus-vs-iterations
```

Run #26:

| Bucket | Observed VUs | Actual iter/s | HTTP reqs | Ý nghĩa |
| --- | ---: | ---: | ---: | --- |
| 1 | 50 | 145 | 360 | CI batch bắt đầu |
| 2 | 50 | 172 | 342 | ổn định |
| 3 | 50 | 193 | 390 | gần peak |
| 4 | 50 | 199 | 388 | peak iter/s |
| 5 | 50 | 178 | 360 | ổn định |
| 6 | 50 | 113 | 160 | tail hoàn thành nốt quota |

Kiểm tổng:

```text
sum(Actual iter/s) = 145 + 172 + 193 + 199 + 178 + 113 = 1000 = summary iterations ✓
sum(httpReqs) = 2000 = summary http_reqs ✓
```

Chart này chứng minh:

```text
CI gate đã chạy đúng 1000 iterations với 50 VUs.
```

Chart này KHÔNG tự quyết định merge. Merge decision phải do thresholds:

```text
iterations == 1000
http_reqs == 2000
http_req_duration{tag:critical} p95 < 550
http_req_failed < 1%
checks > 99%
```

### 2. Tab Executor / Execution

Case 07 cần deterministic workload để CI không flakey:

```text
50 VUs × 20 iterations = 1000 iterations cố định
```

Tab Executor dùng để kiểm:

```text
- 50 VUs active ổn định
- không ramp/dropped như arrival-rate
- không duration-driven như constant-vus
- final iterations đúng 1000
```

Đây là lý do `per-vu-iterations` phù hợp cho CI gate: cùng code thì cùng số
mẫu, threshold p95 so sánh được qua các PR.

### 3. `metrics_push_count` khác `pointCount` — không phải bug

CI gate không quan tâm chart có bao nhiêu point. Nó quan tâm threshold cuối.
Dashboard dùng để debug shape, nên verify chart bằng tổng counter:

```text
360+342+390+388+360+160 = 2000
145+172+193+199+178+113 = 1000
```

### 4. Endpoint debug series theo metric

```text
GET http://localhost:13001/v1/tests/26/series?metric=http_reqs
GET http://localhost:13001/v1/tests/26/series?metric=iterations
GET http://localhost:13001/v1/tests/26/series?metric=http_req_duration
GET http://localhost:13001/v1/tests/26/series?metric=checks
```

Khi debug CI đỏ, đọc theo thứ tự:

```text
1. count có đủ không?
2. HTTP/checks có fail không?
3. p95 có vượt threshold không?
4. chart bucket nào gây spike?
```

### 5. Checklist đọc biểu đồ case 07

| Bước | Câu hỏi | Kết quả run #26 |
| --- | --- | --- |
| 1 | `iterations == 1000`? | 1000 ✓ |
| 2 | `http_reqs == 2000`? | 2000 ✓ |
| 3 | `products_list == 1000`? | 1000 ✓ |
| 4 | `cart_add == 1000`? | 1000 ✓ |
| 5 | `checks_fails == 0`? | 0 ✓ |
| 6 | `http_req_failed == 0`? | 0 ✓ |
| 7 | summary p95 < 550ms? | 200.57ms < 550ms ✓ |
| 8 | chart `httpReqs` sum = 2000? | 360+342+390+388+360+160=2000 ✓ |
| 9 | chart `iterations` sum = 1000? | 145+172+193+199+178+113=1000 ✓ |
| 10 | exit 0 có đáng tin không? | có, vì count + threshold đều pass |

### Cách chốt từ summary -> 3 chart

| Bước | Nhìn ở đâu | Kết luận run #26 |
| --- | --- | --- |
| Workload | summary + VUs vs iter/s | đủ 1000 iterations |
| Request count | breakdown + timeline | 1000 products + 1000 cart = 2000 |
| CI latency gate | summary Response time | p95 200.57ms < 550ms |
| Functional health | checks + http failed | 0 fail, 2000 checks pass |
| Execution shape | timeline / Executor | 50 VU ổn định, deterministic workload |
| Final verdict | tổng hợp | PASS: exit 0 đáng tin, PR không có regression theo gate này |

## Anti-pattern

```text
❌ constant-vus với duration:
   Số iter biến thiên theo network -> CI flakey

❌ constant-arrival-rate:
   Có thể drop -> count thiếu
   p95 latency biến thiên cao do queueing

❌ Bỏ tag critical:
   Threshold tính cả /api/static (CSS, JS)
   -> p95 không phản ánh API performance
```

## Kết luận thực tế: đọc exit code này thì CI pipeline quyết định gì?

Mục tiêu nghiệp vụ: làm **CI performance gate** — mỗi PR chạy đúng 1000
iter, threshold quyết định `exit 0` (merge được) hay `exit 1` (chặn PR).
Khác các case trước, "người đọc output" ở đây là **pipeline tự động**, nên
yêu cầu số 1 là **không flakey**: cùng code phải cho cùng verdict.

Nhắc lại kỳ vọng: 1000 iter + 2000 req cố định, p95 < baseline×1.10.

### Kịch bản A — mọi threshold pass: MERGE PR

```text
iterations.........: 1000        ✓ count==1000
http_reqs..........: 2000        ✓ count==2000
http_req_duration{tag:critical}: p(95)=512ms   ✓ < 550
http_req_failed....: 0.2%        ✓ < 1%
exit code: 0
```

Kết luận thực tế:

```text
- Count đúng tuyệt đối -> gate so p95 trên cùng workload mỗi lần -> không flakey
- p95 512ms < ngưỡng 550 (baseline 500 +10%) -> không regression hiệu năng
=> QUYẾT ĐỊNH (tự động): exit 0 -> PR được merge. Không cần người review số.
```

### Kịch bản B — p95 vượt ngưỡng: CHẶN PR

```text
iterations.........: 1000        ✓
http_reqs..........: 2000        ✓
http_req_duration{tag:critical}: p(95)=690ms   ✗ > 550
exit code: 1
```

Kết luận thực tế:

```text
- Count vẫn đúng 1000 -> gate hợp lệ, KHÔNG phải lỗi đo
- p95 690ms vượt ngưỡng 550 -> code trong PR này làm chậm critical path +38%
=> QUYẾT ĐỊNH (tự động): exit 1 -> CI đỏ -> chặn merge.
   Dev phải tối ưu rồi push lại. Vì count cố định, con số 690 này tin được,
   không phải "lần này CI chạy nhiều request hơn nên chậm".
```

### Kịch bản C — count ≠ 1000: GATE INVALID (phải fail-safe)

```text
iterations.........: 940         ✗ count==1000 fail
exit code: 1 (do threshold iterations fail)
```

Kết luận thực tế:

```text
- Thiếu 60 iter -> môi trường CI có vấn đề (máy yếu, maxDuration chạm,
  server test sập giữa chừng) -> KHÔNG phải tín hiệu hiệu năng đáng tin
- nếu lúc này p95 "pass" thì cũng VÔ NGHĨA (đo trên 940 mẫu, không so được)
=> QUYẾT ĐỊNH: threshold `iterations==1000` cố tình đặt để CASE NÀY cũng
   fail gate -> buộc điều tra hạ tầng CI, KHÔNG cho merge dựa trên dữ liệu
   thiếu. Đây là lý do gate phải kiểm count TRƯỚC, latency sau.
```

### Bảng ánh xạ nhanh output → hành động CI

| Output / exit code | Nghĩa nghiệp vụ | Hành động pipeline |
| --- | --- | --- |
| count đúng, mọi threshold pass, exit 0 | không regression | merge PR |
| count đúng, p95 vượt ngưỡng, exit 1 | regression hiệu năng | chặn PR, báo dev tối ưu |
| http_req_failed > 1%, exit 1 | regression chức năng | chặn PR |
| count ≠ 1000, exit 1 | hạ tầng CI lỗi | chặn + điều tra runner |
| baseline cần cập nhật sau optimize | ngưỡng cũ lỗi thời | update BASELINE_P95_MS |

Điểm cốt lõi: CI gate **phải deterministic mới dùng được** — nếu count
dao động (như constant-vus/arrival-rate), cùng code có lúc pass lúc fail
→ dev mất niềm tin vào CI. per-vu cố định 1000 iter biến gate thành "cùng
code → cùng verdict", và đặt `iterations==1000` làm threshold để chặn cả
trường hợp hạ tầng lỗi, tránh merge nhầm trên dữ liệu thiếu.

## Mở rộng

```js
const env = __ENV.K6_ENV || "staging";
const baselines = {
  staging: 500,
  production: 300,
  local: 100,
};
const BASELINE = baselines[env];
```

### B: Per-endpoint threshold

```js
thresholds: {
  "http_req_duration{name:homepage}": ["p(95)<200"],
  "http_req_duration{name:api_quotes}": ["p(95)<800"],
}
```

### C: Output JSON cho CI parser

```bash
k6 run --out json=ci-result.json pvi-07-ci-batch.js
# Parse ci-result.json để post comment lên PR
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- k6 thresholds: https://k6.io/docs/using-k6/thresholds/
