# Case 05: Reporting ramp

## Tình huống thực tế

Backoffice users vào đầu ngày và mở report dashboard. Một phần loops tạo report jobs và poll status.

Report workload thường low VU nhưng heavy: DB rows, gzip, async job readiness.

Case này trả lời: report service có chịu được staff ramp 1 -> 5 -> 14 -> 1 không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 5 -> 14 -> 1
Scenario: reporting_ramp
Exec function: reportingRamp
Team/service focus: report/backoffice
```

### Đời thường của reporting ramp

Tưởng tượng phòng backoffice của một hệ thống e-commerce vào buổi sáng:

```text
7:00 — 1 staff đầu tiên vào, mở máy, login, mở report dashboard.
       Bắt đầu đọc báo cáo doanh thu hôm qua.
7:15 — 5 staff đã vào. Mỗi người mở dashboard, đọc report.
       Một vài người bắt đầu tạo export job để gửi báo cáo cho sếp.
7:30 — 14 staff đầy đủ. Đây là peak giờ làm việc.
       Nhiều người cùng đọc dashboard, tạo export job, check status.
       Report service đang chịu tải cao nhất trong ngày.
8:00 — Hết giờ peak. Staff bắt đầu rời dashboard.
       Chỉ còn 1 staff cuối cùng đang check nốt export job đang chạy dở.
```

Điểm khác biệt so với constant-vus backoffice:

```text
Constant-vus case 06: 6 staff giữ nguyên suốt 5 phút — quan sát steady state.
Ramping-vus case 05: 1 -> 5 -> 14 -> 1 staff theo giờ làm — quan sát PHẢN ỨNG THEO STAGE.

Case 06 hỏi: "6 staff cùng online liên tục thì UX ra sao?"
Case 05 hỏi: "Khi staff tăng dần, đạt peak, rồi giảm — report service phản ứng thế nào?"
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 5 -> 14 -> 1,
latency/failures/iter-s/RPS phản ứng như thế nào?
Dashboard read có chậm hơn ở peak 14 VU không?
Async export job có bị mất khi VU ramp-down không?
Report service có saturated ở stage nào không?
```

## Vì sao "Reporting ramp" nên dùng `ramping-vus`?

Reporting ramp mô phỏng con người vào backoffice theo giờ làm. `ramping-vus` đúng vì active staff users thay đổi theo time curve.

Trước khi vào kỹ thuật, hiểu **mục tiêu** của reporting ramp trước:

```text
Reporting ramp = "staff vào làm buổi sáng, mở dashboard, đọc report,
                  thỉnh thoảng tạo export job, check status,
                  rồi hết giờ peak thì rời đi"

Đời thường:
  Sáng sớm: 1 staff vào trước, mở dashboard
  Giữa buổi: 5 staff đang làm, một số tạo export
  Peak giờ: 14 staff đầy đủ, report service chịu tải max
  Cuối giờ: staff rời dần, còn 1 người check nốt job dở
```

Để reporting ramp test **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ ramping-vus mới thỏa mãn cả 2.

### Yêu cầu (a): STAGED REPORT CONCURRENCY (active users phải đi đúng shape 1 -> 5 -> 14 -> 1)

**Ý nghĩa**: Staff pool phải thay đổi theo đúng timeline — không phải "tổng cộng có 14 staff login trong ngày", mà là "tại mỗi thời điểm, số staff active phải đúng stage target".

**Ví dụ cụ thể**:

```text
Scenario: team report muốn biết report service chịu tải ra sao khi staff tăng dần

Trường hợp A (staged concurrency đúng):
  Stage 1: 1 -> 5 VUs ramp-up, report service nhận tải tăng dần
  Stage 2: 5 -> 14 VUs ramp-up, report service đạt peak
  Stage 3: 14 VUs plateau, quan sát steady state ở peak
  Stage 4: 14 -> 1 VUs ramp-down, quan sát recovery
  → Kết luận: ở peak 14 VU, dashboard p95 = X, job create p95 = Y

Trường hợp B (concurrency sai — test không theo stage):
  Dùng constant-vus với 14 VU suốt 5 phút
  → Chỉ thấy được peak behavior, không thấy ramp-up và ramp-down
  → KHÔNG trả lời được: "staff từ 1 lên 14, lúc nào report service bắt đầu chậm?"
  → KHÔNG trả lời được: "khi staff rời đi, report service có hồi phục không?"
```

**Phân tích sâu: vì sao constant-vus không thấy được staged behavior?**

`constant-vus` với `vus=14, duration=5m`:

```text
Tưởng tượng: sếp nói "14 người cùng ngồi làm 5 phút đi"

14 VU start, cùng active suốt 5 phút.
→ Chỉ thấy được behavior ở 14 concurrent users.
→ KHÔNG thấy được: lúc chỉ có 1-5 user thì latency ra sao?
→ KHÔNG thấy được: transition từ 5 lên 14 có gây spike latency không?
→ KHÔNG thấy được: ramp-down từ 14 xuống 1, service có hồi phục không?

Nếu report service bắt đầu chậm ở 10 VU:
  ramping-vus: thấy rõ — latency bắt đầu tăng ở stage 2 khi vượt 10 VU
  constant-vus: KHÔNG thấy — chỉ biết latency ở 14 VU, không biết knee ở đâu
```

`ramping-arrival-rate` với arrival profile tương tự:

```text
Tưởng tượng: thay vì đo active users, đo arrival rate

Arrival rate tăng theo time curve.
Nhưng arrival-rate executor không giữ VU identity.
→ KHÔNG biết staff nào đang làm gì.
→ KHÔNG thấy được: staff tạo export job rồi bị ramp-down khi chưa poll xong.
→ Async flow behavior bị che khuất.
```

**Trong khi đó với `ramping-vus`**:

```text
Config: startVUs=1, stages=[
  { duration: "15s", target: 5 },
  { duration: "23s", target: 14 },
  { duration: "30s", target: 14 },
  { duration: "15s", target: 1 },
]

Stage 1: 1 VU -> 5 VUs, quan sát report service với tải tăng dần
Stage 2: 5 VUs -> 14 VUs, quan sát report service tiến đến peak
Stage 3: 14 VUs plateau, quan sát steady state ở peak
Stage 4: 14 VUs -> 1 VU, quan sát recovery và gracefulRampDown

→ Mỗi stage là một observation window riêng.
→ So sánh latency/failures/iter-s GIỮA CÁC STAGE.
→ Phát hiện được knee: "stage nào thì latency bắt đầu tăng?"
→ Phát hiện được recovery: "ramp-down xong, latency có về mức cũ không?"
→ Async flow: "job tạo ở stage 3 có bị drop khi stage 4 ramp-down không?"
```

**Tóm tắt 3 executor về staged concurrency**:

| Executor | VUs đi theo stage shape? | Quan sát được ramp-up/peak/ramp-down? | Staged concurrency guarantee? |
| --- | --- | --- | --- |
| **ramping-vus** | CÓ (stages define active pool) | CÓ (mỗi stage là observation window) | CÓ |
| constant-vus | KHÔNG (VUs phẳng) | KHÔNG (chỉ 1 mức concurrency) | KHÔNG (chỉ thấy steady state) |
| ramping-arrival-rate | KHÔNG (rate-driven) | CÓ (arrival shape) nhưng VU identity không ổn định | KHÔNG (VUs là workers, không phải staff) |

### Yêu cầu (b): ASYNC FLOW UNDER RAMP (export job phải survive stage transitions)

**Ý nghĩa**: Khi staff tạo export job ở peak stage, rồi stage chuyển sang ramp-down — job đó có bị mất không? Async flow phải hoạt động đúng dù VU count thay đổi.

**Ví dụ cụ thể**:

```text
Stage 3 (peak): 14 VU, staff-12 tạo export job #42
  POST /report/jobs → 202 (job accepted)
  Bắt đầu poll status...

Stage 4 bắt đầu (ramp-down): VU đang giảm từ 14 -> 1
  k6 chọn VU để dừng.
  Nếu VU của staff-12 bị chọn dừng:
    gracefulRampDown cho VU thời gian hoàn tất iteration hiện tại
    → Poll loop của job #42 vẫn chạy đến khi done hoặc hết grace
    → Nếu grace đủ dài: job #42 hoàn tất, loop kết thúc bình thường
    → Nếu grace quá ngắn: iteration bị interrupt, job #42 "mất tích"

Trường hợp tệ nhất:
  Stage 4 ramp-down, staff-12 bị dừng khi đang poll job #42
  gracefulRampDown = 20s
  Nhưng READY_AFTER_MS = 5000ms, cần 5+ lần poll
  Nếu grace hết trước khi job done → iteration bị ngắt
  → constant_active_iterations_failed tăng
  → Nhưng job #42 đã được tạo (202) — backend vẫn xử lý
  → Leak: job được tạo nhưng không ai check kết quả
```

**Phân tích sâu: vì sao arrival-rate không thấy async issue này?**

```text
ramping-arrival-rate:
  VU là worker, được assign iteration từ scheduler.
  Iteration hoàn tất → worker được reuse cho iteration khác.
  KHÔNG có khái niệm "staff-12 tạo job rồi bị ramp-down".
  → Async flow issue bị che vì worker identity không cố định.

ramping-vus:
  VU = staff identity (VU=12 = staff-12).
  Khi VU bị ramp-down, ĐÓ CHÍNH LÀ staff-12 rời đi.
  → Async flow issue lộ ra: "staff-12 rời đi khi job còn đang chạy".
  → Đây là business scenario THẬT: staff tạo export rồi tan làm.
```

**Tóm tắt executor về async flow under ramp**:

| Executor | Giữ VU identity khi ramp-down? | Phát hiện async job bị bỏ? | Async survival guarantee? |
| --- | --- | --- | --- |
| **ramping-vus** | CÓ (VU=staff, gracefulRampDown bảo vệ in-flight) | CÓ (failed iteration = staff không check xong job) | CÓ (nếu grace đủ dài) |
| ramping-arrival-rate | KHÔNG (worker không identity) | KHÔNG (job được schedule, không gắn staff) | KHÔNG áp dụng |
| constant-vus | CÓ nhưng không có ramp-down | KHÔNG (không có stage transition) | KHÔNG áp dụng |

---
### Tổng kết: chỉ ramping-vus thỏa mãn cả (a) và (b)

| Executor | (a) Staged concurrency 1->5->14->1 | (b) Async flow survive ramp transitions | Verdict |
| --- | --- | --- | --- |
| **ramping-vus** | ✓ stages define active pool per time | ✓ gracefulRampDown + VU identity | ✅ DÙNG |
| constant-vus | ✗ VUs phẳng, không có stage | ✗ Không có ramp-down để test | ❌ |
| shared-iterations | ✗ dừng khi hết iter, không stage | ✗ Không có stage transition | ❌ |
| per-vu-iterations | ✗ VU nhanh idle sớm, không stage | ✗ Không có ramp-down pool reduction | ❌ |
| constant-arrival-rate | ✗ rate-driven, không giữ VU count | ✗ Drop xen vào, không phân biệt được | ❌ |
| ramping-arrival-rate | ✗ arrival shape nhưng VU là worker | ✗ Worker identity không cố định | ❌ |

→ Chỉ **ramping-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

## Yêu cầu cứng của case này

- Dashboard runs every loop; create/status are conditional.
- READY_AFTER_MS intentionally extends flow duration.
- Missing job ID must count as failed iteration.
- Do not dismiss low VUs as irrelevant; report path can be heavy.

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| VUs phải đi đúng shape 1 -> 5 -> 14 -> 1 | Vì đây là input chính; VU sai shape = test không mô phỏng đúng business |
| `ramping_active_iterations_failed < 15` | Có failed loop nghĩa là staff flow bị đứt; dưới 15 là chấp nhận được trong staged run |
| `checks rate > 0.99` | Business contract của API phải được tôn trọng |
| `http_req_failed rate < 0.01` | HTTP failure phải thấp; nếu cao, không kết luận được UX theo stage |
| Operation tags phải có đủ 3 operation | Dashboard, job_create, job_status phải tách được; aggregate che branch nhỏ |
| Flow duration phải được đo bằng `ramping_flow_duration_ms` | Đây là staff UX end-to-end, không chỉ từng request |
| Dashboard count >> create/status count | Dashboard chạy mỗi loop; nếu tỉ lệ sai, script có bug |
| `ramping_sleep_seconds` phải gần `iterations × RV_05_SLEEP_SECONDS` | Xác nhận think time được áp dụng đúng |

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
Need active VUs đổi theo timeline       -> ramping-vus.
Need active VUs phẳng                   -> constant-vus, not this case.
Need fixed global backlog               -> shared-iterations, not this case.
Need fixed per-user quota               -> per-vu-iterations, not this case.
Need target arrivals đổi theo time      -> ramping-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_05_START_VUS = 1
RV_05_MID_VUS = 5
RV_05_PEAK_VUS = 14
RV_05_DURATION_SCALE = 0.25
RV_05_SLEEP_SECONDS = 1
RV_05_READY_AFTER_MS = 50
gracefulRampDown = 20s
```

Config meaning:

| Config/env | Default | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| RV_05_START_VUS | 1 | Số staff có mặt lúc bắt đầu ca làm |
| RV_05_MID_VUS | 5 | Số staff ở giữa buổi sáng |
| RV_05_PEAK_VUS | 14 | Số staff tối đa trong peak giờ |
| RV_05_DURATION_SCALE | 0.25 | Hệ số rút gọn duration để test nhanh hơn business timeline thật |
| RV_05_SLEEP_SECONDS | 1 | Think time: staff đọc report giữa các thao tác |
| RV_05_READY_AFTER_MS | 50 | Delay mô phỏng async job readiness (ms) |
| gracefulRampDown | 20s | Thời gian cho phép in-flight loops hoàn tất khi ramp-down |

Mapping quan trọng:

```text
business morning staff curve = 1 -> 5 -> 14 -> 1
k6 stage targets             = 1 -> 5 -> 14 -> 1
duration scale               = 0.25 (15s+23s+30s+15s thay vì 60s+90s+120s+60s)
think time                    = 1s (staff đọc report giữa các action)
async readiness               = 50ms (simulation knob for job readiness delay)
gracefulRampDown              = 20s (đủ dài để in-flight job poll hoàn tất)
```

Threshold cap riêng:

```text
ramping_active_iterations_failed: count<15
```

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 5 | staff arriving — 1 -> 5 staff vào buổi sáng |
| 2 | 90s | 23s | 14 | morning peak ramp — 5 -> 14 staff đạt peak |
| 3 | 120s | 30s | 14 | sustained report usage — 14 staff plateau |
| 4 | 60s | 15s | 1 | drain — 14 -> 1 staff tan ca |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Phân tích từng stage

**Stage 1 — Ramp-up 1 -> 5 (15s)**:

```text
Business: 1 staff đầu tiên vào, rồi thêm 4 người nữa vào trong 15 phút (scaled).
Report service: tải tăng từ 1 lên 5 concurrent users.
Quan sát: latency có tăng khi VUs tăng không? Tuyến tính hay có jump?
DB: 1-5 report queries đồng thời — thường chưa saturated.
Async: ít job được tạo (staff còn đang đọc dashboard).
```

**Stage 2 — Ramp-up 5 -> 14 (23s)**:

```text
Business: staff vào đông hơn, từ 5 lên 14 trong 23 phút (scaled).
Report service: tải tăng mạnh — đây là lúc có thể thấy knee.
Quan sát: latency có jump ở VU count nào? 8? 10? 12?
DB: 5-14 report queries đồng thời — có thể bắt đầu saturated.
Async: nhiều job được tạo hơn, polling bắt đầu xuất hiện.
```

**Stage 3 — Peak plateau 14 (30s)**:

```text
Business: 14 staff đầy đủ, làm việc ổn định trong 30 phút (scaled).
Report service: chịu tải max — đây là steady state ở peak.
Quan sát: latency/p95 ở 14 VU có ổn định không? Flow duration?
DB: 14 report queries đồng thời — nếu saturated, queue hình thành.
Async: nhiều job create + poll nhất — xem async flow có break không.
```

**Stage 4 — Ramp-down 14 -> 1 (15s)**:

```text
Business: staff rời đi, từ 14 xuống còn 1 người trong 15 phút (scaled).
Report service: tải giảm dần — quan sát recovery.
Quan sát: latency có giảm về mức stage 1 không? Có recovery không?
DB: queries giảm — nếu saturated trước đó, queue sẽ drain.
Async: CRITICAL — job tạo ở stage 3 có thể còn đang poll.
       gracefulRampDown=20s bảo vệ in-flight iterations.
       Nếu grace đủ dài, job poll hoàn tất. Nếu không, iteration bị ngắt.
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

### Identity model: VU = reporting staff

Trong ramping-vus, VU không phải generic worker. Nó là **staff identity** — nhưng staff đến và đi theo stage:

```text
__VU / exec.vu.idInTest = reporting staff identity
__ITER                  = loop counter của riêng staff đó
exec.scenario.iterationInTest = global loop counter, không phải job id
```

Khác với constant-vus:

```text
constant-vus case 06: 6 VU giữ nguyên suốt duration.
  → VU=1 luôn là staff-1, từ đầu đến cuối.
  → Mỗi staff chạy được N loops như nhau (gần đúng).

ramping-vus case 05: VUs thay đổi theo stage.
  → Stage 1: VU=1 là staff-1 (đi sớm).
  → Stage 2: VU=1..5 vẫn là staff-1..5, VU=6..14 là staff mới vào.
  → Stage 4: VU=14..2 bị ramp-down, chỉ còn VU=1 (staff-1 ở lại cuối ca).
  → Staff vào sau (VU=14) chạy ít loops hơn staff vào sớm (VU=1).
```

**Demo trace identity model với shape 1 -> 5 -> 14 -> 1**:

```text
Config: startVUs=1, stages=[1->5, 5->14, 14 plateau, 14->1]

Stage 1 (ramp-up 1->5):
  t=0.0s   VU=1 (staff-1): __ITER=0, GET /report → sleep 1s
  t=3.0s   VU=2 (staff-2) được activate: __ITER=0, GET /report → sleep 1s
  t=6.0s   VU=3 (staff-3) được activate: __ITER=0, GET /report → sleep 1s
  ...
  → Mỗi staff mới vào, __ITER bắt đầu từ 0

Stage 2 (ramp-up 5->14):
  VU=1 (staff-1): đã chạy được ~5 loops (vào từ stage 1)
  VU=14 (staff-14): __ITER=0 (vừa mới vào)
  → Staff cũ chạy nhiều loops hơn staff mới

Stage 3 (peak 14):
  Tất cả 14 staff cùng active.
  VU=1: __ITER~15 (tổng từ stage 1+2+3)
  VU=14: __ITER~3 (chỉ từ stage 3)

Stage 4 (ramp-down 14->1):
  VU=14..2 lần lượt bị dừng.
  Nếu VU=14 đang poll job → gracefulRampDown cho finish iteration hiện tại.
  VU=1 (staff-1): vẫn chạy, là người cuối cùng rời đi.
  → VU=1 có thể chạy thêm vài loops trong khi các VU khác đã dừng.
```

**Vì sao VU identity quan trọng cho reporting ramp?**

```text
Trong constant-vus: mọi staff đều online suốt test.
  → Có thể gán user_id = VU, behavior đồng đều.

Trong ramping-vus: staff đến và đi theo stage.
  → VU=1 (staff-1) có thể chạy 20 loops vì vào từ đầu.
  → VU=14 (staff-14) chỉ chạy 3 loops vì vào stage 3.
  → KHÔNG mong đợi mỗi VU chạy số loops bằng nhau.
  → Số loops per VU phụ thuộc vào thời điểm VU được activate/deactivate.
```

### Closed model per stage

Trong ramping-vus, closed model vẫn áp dụng — nhưng per stage:

```text
Stage 1 (1->5 VUs):
  Mỗi VU loop liên tục: dashboard → sleep → (optional export) → ...
  Tổng iter/s ở stage này = sum(1/loop_duration) cho các VU active

Stage 3 (14 VUs plateau):
  Cùng công thức, nhưng 14 VUs.
  Nếu backend chậm hơn ở 14 VU → loop_duration tăng → iter/s không tăng tỉ lệ 14/5

Stage 4 (14->1 VUs):
  VU giảm → iter/s giảm.
  Nhưng gracefulRampDown có thể làm iter/s giảm chậm hơn VU count.
```

**Công thức closed-model theo stage**:

```text
Với mỗi stage:
  active_vus_at_t = số VU đang active tại thời điểm t
  avg_loop_duration_at_t ~= dashboard_latency(t) + sleep + branch_mix × (create_latency(t) + status_latency(t))

  iter/s_at_t ~= active_vus_at_t / avg_loop_duration_at_t

Stage 1 (5 VUs, dashboard 0.5s):
  loop_duration = 0.5 + 1.0 + 0.3 × (0.3 + 0.2) = 1.65s
  iter/s = 5 / 1.65 ≈ 3.03 iter/s

Stage 3 (14 VUs, dashboard CÓ THỂ chậm hơn do DB saturated):
  Nếu dashboard vẫn 0.5s: loop_duration = 1.65s, iter/s = 14 / 1.65 ≈ 8.48 iter/s
  Nếu dashboard chậm 3.0s: loop_duration = 3.0 + 1.0 + 0.15 = 4.15s, iter/s = 14 / 4.15 ≈ 3.37 iter/s
  → iter/s chỉ tăng 11% dù VU tăng 180%!
  → Đây là tín hiệu DB saturated ở peak.
```

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Dashboard every loop dominates count and latency

Dashboard read chiếm ~60% API calls và chạy MỖI loop. Khi report query nặng (50MB data, JOIN nhiều bảng, gzip), dashboard trở thành bottleneck chính — và nó ảnh hưởng MỌI loop, không chỉ loop có export.

**Vấn đề**: Nhiều người tập trung vào async export job mà quên rằng dashboard chạy mỗi loop. Nếu dashboard chậm, TOÀN BỘ flow chậm — dù export job nhanh.

**Demo trace: dashboard chậm kéo cả flow dù export job OK**:

```text
Stage 3 (14 VU plateau):

Dashboard latency bình thường (0.5s):
  Mỗi loop: 0.5s + 1.0s sleep + 0.3×(0.3s create + 0.2s status) = 1.65s
  iter/s = 14 / 1.65 ≈ 8.48 iter/s

Dashboard latency chậm (3.0s, DB query nặng):
  Mỗi loop: 3.0s + 1.0s sleep + 0.3×(0.3s create + 0.2s status) = 4.15s
  iter/s = 14 / 4.15 ≈ 3.37 iter/s
  → iter/s giảm 60%!
  → Nhưng export job create/status vẫn 0.3s/0.2s — không phải chúng chậm.
  → Chính dashboard đang kéo flow duration lên.
```

**Tác động đến từng stage**:

```text
Stage 1 (1->5 VUs): dashboard chưa saturated → latency thấp
Stage 2 (5->14 VUs): dashboard bắt đầu chậm khi VU > 8-10 → latency tăng dần
Stage 3 (14 VUs): dashboard chậm nhất → flow duration dài nhất
Stage 4 (14->1 VUs): dashboard hồi phục khi VU giảm → latency giảm lại
```

**Cách phát hiện**: So sánh `http_req_duration{operation:reporting_ramp_dashboard}` giữa các stage. Nếu p95 stage 3 >> p95 stage 1, dashboard đang bị saturated ở peak.

### Nguyên nhân kỹ thuật 2: Ready wait extends flow duration

`RV_05_READY_AFTER_MS` làm loop lâu hơn có chủ ý; khi tăng env này, iter/s giảm là expected. Nhưng trong ramping-vus, tác động của ready wait thay đổi theo stage — vì số lượng export job thay đổi theo stage.

**Vấn đề**: READY_AFTER_MS kéo dài flow duration, nhưng mức độ ảnh hưởng phụ thuộc vào stage:

```text
Stage 1 (1->5 VUs): ít staff → ít export job được tạo → ready wait ít ảnh hưởng
Stage 3 (14 VUs): nhiều staff → nhiều export job → ready wait ảnh hưởng NHIỀU NHẤT
Stage 4 (14->1 VUs): VU giảm + gracefulRampDown → ready wait có thể gây interrupt nếu grace không đủ

→ READY_AFTER_MS không ảnh hưởng đều — nó ảnh hưởng mạnh nhất ở peak stage.
```

**Demo: READY_AFTER_MS thay đổi flow duration theo từng stage**:

```text
READY_AFTER_MS = 50ms (default):
  Stage 1: loop_duration ~1.65s (dashboard + sleep + ít export)
  Stage 3: loop_duration ~1.70s (dashboard + sleep + nhiều export hơn + 50ms wait)

READY_AFTER_MS = 2000ms:
  Stage 1: loop_duration ~2.2s (ít export, 2s wait ít ảnh hưởng)
  Stage 3: loop_duration ~3.5s (nhiều export, 2s wait ảnh hưởng MẠNH)
  → Difference stage 1 vs stage 3 LỚN HƠN khi READY_AFTER_MS cao
  → Flow duration gap giữa các stage là tín hiệu cần đọc
```

**Cách phát hiện**: So sánh `ramping_flow_duration_ms` giữa 2 run có READY_AFTER_MS khác nhau. Đọc flow duration KHÔNG chỉ aggregate — đọc theo stage nếu dashboard hỗ trợ.

### Nguyên nhân kỹ thuật 3: Missing job ID is business failure

HTTP 202 không đủ nếu create response không trả job id để status check. Trong ramping-vus, vấn đề này NGUY HIỂM HƠN vì VU có thể bị ramp-down trước khi phát hiện lỗi.

**Vấn đề**: Nếu POST /report/jobs trả 202 nhưng response body không có `id`:

```text
constant-vus: 
  VU vẫn active → có thể retry hoặc log error
  Nhưng loop fail → constant_active_iterations_failed tăng

ramping-vus:
  VU có thể bị ramp-down ngay sau đó
  → Không có cơ hội retry
  → Job "ma" được tạo (202 accepted) nhưng không ai check status
  → Backend vẫn xử lý job → leak resource
```

**Demo: missing job ID dưới ramp-down**:

```text
Stage 4 (ramp-down 14->1):
  VU=8 (staff-8) đang loop cuối:
    GET /report → 200 OK
    sleep 1s
    POST /report/jobs → 202 Accepted, body: {} (THIẾU id!)
    → jobId = undefined
    → GET /report/jobs/undefined → 404
    → Check "job status 200" FAIL
    → Loop này FAILED

  Ngay sau đó: VU=8 bị ramp-down (stage 4 đang giảm VU).
  → Không có cơ hội retry.
  → Backend đã accept job nhưng staff đã rời đi.
  → Job "mồ côi" — được tạo nhưng không ai check kết quả.
```

**Cách phát hiện**: Lọc `ramping_active_iterations_failed` theo stage. Nếu failures cluster ở stage 4, có thể do missing job ID + ramp-down. Kiểm `http_req_duration{operation:reporting_ramp_job_status}` — nếu có 404, đó là dấu hiệu missing job ID.

### Nguyên nhân kỹ thuật 4: Low VU high cost — 14 report users có thể saturated DB

14 report users có thể đủ tạo DB/gzip/report pressure lớn. Đây là LOW-VU HIGH-COST: 14 VU với query nặng có thể tạo áp lực tương đương 140+ VU với query nhẹ.

**Vấn đề**: Nhiều người nghĩ "14 VU không thể là performance test". Nhưng với report query:

```text
Mỗi dashboard query (GET /api/sim/report):
  - 50MB dữ liệu report
  - JOIN 3-7 bảng
  - GROUP BY + aggregation
  - gzip response
  → 1 query: 1-3s CPU, 0.5-2s I/O, 0.2-1s gzip
  → DB resource: ~1.5 cores, ~200MB RAM

14 query đồng thời ở stage 3:
  → 14 × 1.5 cores = 21 cores demand
  → Nếu DB server có 8 cores → 262% oversubscribed!
  → DB queue hình thành → một số query phải chờ
  → p95 tăng vọt
```

So sánh với storefront:

```text
Storefront product list (100 VU):
  Mỗi query: 1KB data, index scan, cache hit
  → 1 query: 0.01-0.05s, 0.05 cores, 5MB RAM
  100 query đồng thời: 5 cores → DB thoải mái

Backoffice report (14 VU):
  14 query đồng thời: 21 cores demand → DB QUÁ TẢI
  → 14 VU backoffice NẶNG HƠN 100 VU storefront!
```

**Cách phát hiện**: Ở stage 3 (14 VU), so sánh dashboard p95 với stage 1 (5 VU). Nếu p95 stage 3 >> p95 stage 1, DB đang saturated. Cũng kiểm `ramping_flow_duration_ms` — nếu tăng >50% từ stage 1 sang stage 3, đó là tín hiệu backpressure.

## LOW-VU HIGH-COST: phân tích sâu

### Vì sao "chỉ 14 VU" vẫn là performance test?

Backoffice report query khác storefront product query ở nhiều mặt:

| Tiêu chí | Storefront product list | Backoffice report dashboard |
| --- | --- | --- |
| Data volume | 10-50 rows, 1-5KB | 1000-10000 rows, 100KB-50MB |
| Query complexity | Index scan, 1-2 tables | JOIN 3-7 tables, GROUP BY, aggregation |
| Response format | JSON nhỏ, không nén | JSON lớn, có gzip |
| Cache hit rate | 80-95% (products ít thay đổi) | 20-50% (report real-time, thay đổi liên tục) |
| DB CPU/query | 0.01-0.1 core | 1.0-2.0 cores |
| Memory/query | 1-5MB | 100-500MB |
| I/O/query | Vài KB | 10-50MB disk read |

**Công thức áp lực DB theo stage**:

```text
DB pressure = active_VUs × resource_per_query

Stage 1 (5 VUs):  5 × 1.5 cores = 7.5 cores demand → DB gần saturated (8 cores)
Stage 3 (14 VUs): 14 × 1.5 cores = 21 cores demand → DB OVERSATURATED (262%)

→ Stage 1: DB còn dư, latency thấp
→ Stage 3: DB quá tải, latency cao, queue hình thành
```

### Demo: 14 VU bão hòa DB ở stage 3

```text
Máy chủ DB: 8 CPU cores, 32GB RAM

Stage 1 (1->5 VUs):
  Max 5 VU, max 5 query đồng thời
  → 5 × 1.5 cores = 7.5 cores demand < 8 cores supply
  → Còn dư 0.5 core → DB chưa saturated
  → Dashboard p95 ~0.5-1.0s (tốt)

Stage 3 (14 VUs plateau):
  14 VU, 14 query đồng thời (mỗi VU đều gọi dashboard)
  → 14 × 1.5 cores = 21 cores demand >> 8 cores supply
  → DB queue hình thành:
      Query 1-5: chạy ngay trên 8 cores (1.6 core/query)
      Query 6-10: queue, chờ core free
      Query 11-14: queue dài hơn
  → Dashboard p95 có thể lên 4-6s (CHẬM)
  → Nhưng vẫn 0 http_req_failed — tất cả đều 200, chỉ là chậm

Stage 4 (14->1 VUs):
  VU giảm → query giảm → queue drain dần
  → Dashboard p95 giảm về ~0.5-1.0s
  → RECOVERY: latency về mức stage 1
```

### Khi nào 14 VU reporting ramp gây vấn đề?

| Điều kiện | DB CPU ở stage 3 | Dashboard p95 stage 3 | Hành động |
| --- | --- | --- | --- |
| 14 VU, query nhẹ (cache hit, ít data) | 40-60% | <1s | Bình thường |
| 14 VU, query vừa (cache miss, data vừa) | 70-90% | 1-3s | Theo dõi |
| 14 VU, query nặng (cache miss, nhiều JOIN, nhiều data) | 90-100% | 3-6s | Cần tối ưu query hoặc scale DB |
| 14 VU, query nặng + export jobs | 95-100% | 5-10s | DB bão hòa, cần index/cache/scale |

### Khác với constant-vus case 06

| Tiêu chí | Case 05 (ramping-vus) | Case 06 (constant-vus) |
| --- | --- | --- |
| Concurrency shape | Staged: 1 -> 5 -> 14 -> 1 | Steady: 6 VU phẳng |
| Observation | Behavior THAY ĐỔI theo stage | Behavior ỔN ĐỊNH trong 5m |
| Peak VUs | 14 (stage 3) | 6 (suốt 5m) |
| Knee detection | CÓ — so sánh stage 1 vs stage 3 | KHÔNG — chỉ 1 mức concurrency |
| Recovery signal | CÓ — stage 4 latency phải về mức stage 1 | KHÔNG — không có ramp-down |
| Async concern | Job survival khi ramp-down | Polling loop trong steady state |
| think time | 1s | 2s |
| Ready wait | 50ms (ngắn, ít poll) | 1ms (gần như ngay) |
| gracefulRampDown | 20s (quan trọng) | Không áp dụng (không ramp-down) |

## Service/API flow

Flow pattern:

```text
Dashboard every iteration; create job every third iteration; wait ready_after; status check if job created.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| reporting_ramp_dashboard | report-service | GET | /api/sim/report | 200 | Report dashboard. |
| reporting_ramp_create_job | report-service | POST | /api/sim/report/jobs | 202 | Create async report job. |
| reporting_ramp_job_status | report-service | GET | /api/sim/report/jobs/:id | 200 | Check report job status. |

### Phân bố operation trong flow

```text
Mỗi loop (iteration):
  reporting_ramp_dashboard: 100% (1 call/loop)
  reporting_ramp_job_create: ~33% (every third iteration)
  reporting_ramp_job_status: ~33% × số_poll_trung_bình

Với READY_AFTER_MS=50ms (gần như done ngay):
  API calls mỗi loop trung bình = 1 + 0.33×1 + 0.33×1 = 1.67 calls

Phân bố theo stage:
  Stage 1 (1->5 VUs):  dashboard nhiều, create/status ít (VU mới vào, đang đọc)
  Stage 3 (14 VUs):    dashboard + create/status đều cao (nhiều staff, nhiều export)
  Stage 4 (14->1 VUs): dashboard giảm, create/status có thể còn chạy (in-flight jobs)
```

## ASYNC FLOW UNDER RAMP

### Vì sao async flow nguy hiểm hơn trong ramping-vus?

Trong constant-vus, async flow chạy trong loop của cùng một VU — VU luôn active, không bị dừng giữa chừng. Trong ramping-vus, VU bị ramp-down theo stage — job đang poll có thể bị ngắt.

```text
constant-vus:
  VU=1 tạo job → poll status → job done → loop tiếp
  VU=1 luôn active, không bao giờ bị dừng giữa poll
  → Async flow an toàn

ramping-vus:
  VU=8 tạo job ở stage 3 (peak) → đang poll status
  Stage 4 bắt đầu → VU=8 bị chọn để ramp-down
  → gracefulRampDown=20s cho phép poll tiếp
  → Nếu job done trong 20s → OK
  → Nếu job cần poll >20s → iteration bị ngắt → loop failed
  → Job vẫn được tạo (202) nhưng không ai check kết quả
```

### Pattern code cho async flow với polling trong ramping-vus

```js
import { sleep, check } from "k6";
import http from "k6/http";

export default function () {
  const userId = `staff-${__VU}`;
  const tags = { user_id: userId };

  // Bước 1: Mở report dashboard (luôn có)
  const dashboardRes = http.get(`${__ENV.BASE_URL}/api/sim/report`, {
    tags: { ...tags, operation: "reporting_ramp_dashboard" },
  });
  check(dashboardRes, { "dashboard status 200": (r) => r.status === 200 });

  // Bước 2: Staff đọc report, suy nghĩ
  sleep(parseFloat(__ENV.RV_05_SLEEP_SECONDS || "1"));

  // Bước 3: Thỉnh thoảng tạo export job (every third iteration)
  if (__ITER % 3 === 0) {
    const createRes = http.post(`${__ENV.BASE_URL}/api/sim/report/jobs`, null, {
      tags: { ...tags, operation: "reporting_ramp_create_job" },
    });
    check(createRes, { "job create accepted 202": (r) => r.status === 202 });

    const jobId = createRes.json("id");
    if (!jobId) {
      // Missing job ID = business failure
      console.error(`staff-${__VU} iter-${__ITER}: missing job id in create response`);
      return; // Loop này failed
    }

    // Bước 4: Wait ready_after_ms
    const readyMs = parseInt(__ENV.RV_05_READY_AFTER_MS || "50");
    if (readyMs > 0) {
      sleep(readyMs / 1000);
    }

    // Bước 5: Poll status
    const statusRes = http.get(`${__ENV.BASE_URL}/api/sim/report/jobs/${jobId}`, {
      tags: { ...tags, operation: "reporting_ramp_job_status" },
    });
    check(statusRes, {
      "job status 200": (r) => r.status === 200,
    });
    // Với READY_AFTER_MS thấp (50ms), 1 poll thường đủ
    // Với READY_AFTER_MS cao, có thể cần polling loop — xem variation
  }

  // Loop tiếp: quay lại dashboard
}
```

### Polling strategy theo READY_AFTER_MS trong ramping context

| READY_AFTER_MS | Poll strategy | Số poll trung bình | Thời gian chờ tổng | Risk khi ramp-down |
| --- | --- | --- | --- | --- |
| 50ms (default) | Gọi 1 lần, gần như done ngay | 1 | ~0.2s | Thấp — poll nhanh, grace 20s đủ |
| 500ms | Gọi 1-2 lần | 1-2 | ~0.3-0.8s | Thấp |
| 2000ms | Gọi 2-5 lần (polling loop) | 3-5 | ~0.8-2.5s | Trung bình — nếu poll bắt đầu ngay trước ramp-down |
| 5000ms | Gọi 5-10+ lần | 5-10 | ~2.5-5.0s | CAO — có thể vượt grace nếu ramp-down bắt đầu giữa poll |
| 10000ms | Gọi 10-20+ lần | 10-20 | ~5.0-10.0s | RẤT CAO — gần như chắc chắn bị interrupt nếu ramp-down |

### gracefulRampDown vs READY_AFTER_MS: race condition

```text
gracefulRampDown = 20s: VU có 20s để hoàn tất iteration hiện tại khi bị chọn dừng.

READY_AFTER_MS = 5000ms: job cần ~5s poll để done.

Nếu VU bị chọn dừng NGAY SAU KHI tạo job (POST 202):
  → Có 20s grace để poll → đủ cho 5000ms READY_AFTER_MS → OK

Nếu VU bị chọn dừng SAU KHI đã poll 18s (ví dụ do loop trước đó dài):
  → Còn 2s grace → KHÔNG đủ cho 5000ms READY_AFTER_MS → iteration bị ngắt

→ Đây là race condition giữa stage transition và async flow duration.
→ Chỉ ramping-vus mới bộc lộ được vấn đề này.
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
| `case_id` | Case đang chạy, ví dụ `rv-05-reporting-ramp`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-05-reporting-ramp
business_case = backoffice_reporting_ramp
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<15
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

### Pass criteria mở rộng (theo operation và stage)

Nếu muốn biến case này thành performance gate (không chỉ functional pass):

```text
// Functional (bắt buộc)
checks rate > 0.99
http_req_failed rate < 0.01
ramping_active_iterations_failed count < 15

// Performance (optional, tùy team)
http_req_duration{operation:reporting_ramp_dashboard}: p(95) < 3000ms
http_req_duration{operation:reporting_ramp_create_job}: p(95) < 5000ms
http_req_duration{operation:reporting_ramp_job_status}: p(95) < 1000ms
ramping_flow_duration_ms: p(95) < 5000ms

// Stage-specific (nếu dashboard hỗ trợ filter theo stage)
http_req_duration{operation:reporting_ramp_dashboard}: p(95) stage 1 vs stage 3 ratio < 3x
  // Nếu p95 stage 3 gấp hơn 3 lần stage 1 → DB saturated ở peak
```

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-05-reporting-ramp.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-05-reporting-ramp.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-05-reporting-ramp.js
```

### Override env vars để thử variation

```powershell
# Tăng READY_AFTER_MS để thấy async timing ảnh hưởng flow duration
$env:RV_05_READY_AFTER_MS = 2000
k6 run ...rv-05-reporting-ramp.js

# Tăng peak VUs để stress test report service
$env:RV_05_PEAK_VUS = 28
k6 run ...rv-05-reporting-ramp.js

# Tăng duration scale để chạy gần business timeline hơn
$env:RV_05_DURATION_SCALE = 1.0
k6 run ...rv-05-reporting-ramp.js

# Giảm sleep để thấy think time ảnh hưởng iter/s
$env:RV_05_SLEEP_SECONDS = 0.2
k6 run ...rv-05-reporting-ramp.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = reporting_ramp
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

Nếu learner override env vars (RV_05_PEAK_VUS, RV_05_DURATION_SCALE...), phải recompute toàn bộ expected stage behavior.

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 5 -> 14 -> 1
```

`vus_max` nên gần peak target (14 hoặc env override) nếu run đủ dài và dashboard sample bắt được peak.

Nếu VUs không theo stage shape, kiểm:
- Config: startVUs, stages[].target, stages[].duration
- DURATION_SCALE: có override không?
- Dashboard sampling interval có bắt được ramp-up không?

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

Đặc biệt với case này: nếu `ramping_active_iterations_failed > 0`, kiểm:
- Có phải do missing job ID không? (Lọc theo operation=reporting_ramp_create_job)
- Có phải do job status fail không? (Lọc theo operation=reporting_ramp_job_status)
- Failures có cluster ở stage 4 (ramp-down) không? (Async flow bị ngắt)

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

**Cách sanity check counters cho case này**:

```text
Biết:
  Effective duration = scaleSeconds(60+90+120+60, 0.25) = 15+23+30+15 = 83s
  sleep = 1s mỗi loop
  dashboard latency ~0.5s trung bình (nếu backend khỏe)
  READY_AFTER_MS = 50ms
  branch mix = 33% loop có export

Loop duration trung bình (không export, 67% loop):
  = 0.5s (dashboard) + 1.0s (sleep) = 1.5s

Loop duration trung bình (có export, 33% loop):
  = 0.5s + 1.0s + 0.3s (create) + 0.05s (ready) + 0.2s (status) = 2.05s

Loop duration trung bình chung:
  = 0.67 × 1.5 + 0.33 × 2.05 = 1.01 + 0.68 = 1.69s

Expected iterations (ước lượng RẤT THÔ):
  = avg_active_vus × total_duration / loop_duration
  = avg_active_vus × 83s / 1.69s

  avg_active_vus qua 4 stages ~8-10 VU
  → ~10 × 83 / 1.69 ≈ 491 iterations (RẤT thô)

Expected http_reqs (ước lượng):
  ~ iterations × 1.67 calls/loop ≈ 491 × 1.67 ≈ 820 calls

Nhưng đây CHỈ là ước lượng.
Nếu số thật thấp hơn nhiều → dashboard latency cao hơn dự kiến hoặc sleep lâu hơn.
Nếu số thật cao hơn nhiều → dashboard latency thấp hơn dự kiến.
KHÔNG dùng con số này làm pass/fail.
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Dashboard count sẽ cao hơn create/status vì jobs conditional.
- `ramping_flow_duration_ms` bao gồm ready wait khi job branch chạy.
- Nếu iter/s thấp nhưng checks pass, kiểm sleep/ready_after trước khi kết luận backend fail.
- `ramping_sleep_seconds` nên gần `iterations × 1s` (vì mỗi loop sleep 1s).
- So sánh flow duration ở đầu run (stage 1, ít VU) vs cuối stage 3 (peak 14 VU) — gap lớn = saturation signal.

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #55

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_05_START_VUS=1
RV_05_MID_VUS=5
RV_05_PEAK_VUS=14
RV_05_DURATION_SCALE=0.25
RV_05_SLEEP_SECONDS=1
RV_05_READY_AFTER_MS=50
```

| Item | Value |
| --- | --- |
| Script | `rv-05-reporting-ramp.js` |
| Run ID | `55` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 5 -> 14 -> 1` |
| Observed `vus` min/max | 1 / 14 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (503/503) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/503) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 301 (3.60/s) | Output, không phải target. |
| `http_reqs` | 503 (6.02/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 301 | Completed user loops. |
| `ramping_api_calls_total` | 503 | Custom API counter. |
| `ramping_sleep_seconds` | 301.0s | Think time do script thêm. |
| `http_req_duration` | avg 975ms, p95 2.51s, p99 2.90s, max 3.10s | Request-level latency. |
| `ramping_flow_duration_ms` | avg 1.65s, p95 2.90s, p99 3.20s, max 3.40s | Full user-loop latency. |
| `iteration_duration` | avg 2.65s, p95 3.90s, p99 4.20s, max 4.40s | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `reporting_ramp_dashboard` | GET | 200 | 301 | 59.84% |
| `reporting_ramp_create_job` | POST | 202 | 101 | 20.08% |
| `reporting_ramp_job_status` | GET | 200 | 101 | 20.08% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Reporting vẫn heavy, p95 tính bằng giây là expected với report jobs. Quan trọng là status contract 202 đã được xử lý đúng.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 503 |
| Avg của các window avg | 975ms |
| Max window p95 | 3.10s |
| Max window p99 | 3.10s |
| Max request window | 3.10s |
| Windows p95 > 100ms | 427 |
| Windows p95 > 500ms | 241 |

#### 2. Execution timeline chart

Không còn mismatch 202/200. Request breakdown có đủ dashboard -> create_job 202 -> job_status 200.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 301 |
| Sum `http_reqs` buckets | 503 |
| Peak iter/s bucket | 8 |
| Peak http_req/s bucket | 12 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 14 đúng contract. Low iter/s là expected vì report flow và ready wait dài.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 83 |
| VUs min/max series | 1 / 14 |
| Avg VUs series | 9.59 |
| Peak iter/s bucket | 8 |

### Kết luận contract rerun #55

OK theo contract gốc. Case 05 đã fix đúng lỗi 202 vs 200.

### Phân tích chi tiết theo stage từ contract rerun #55

Từ dữ liệu run #55, ta có thể suy ra behavior theo từng stage:

```text
Stage 1 (1->5 VUs, 15s):
  - VU tăng từ 1 lên 5
  - Dashboard queries ít, latency thấp (avg ~0.5-0.8s)
  - Ít export job được tạo (VU mới vào, đang đọc dashboard)
  - iter/s tăng dần từ ~1 lên ~4-5

Stage 2 (5->14 VUs, 23s):
  - VU tăng từ 5 lên 14 — giai đoạn ramp-up nhanh nhất
  - Dashboard queries tăng, latency bắt đầu tăng (avg ~0.8-1.2s)
  - Export jobs bắt đầu xuất hiện nhiều hơn
  - iter/s tăng từ ~4-5 lên ~6-8

Stage 3 (14 VUs plateau, 30s):
  - 14 VU ổn định — peak concurrency
  - Dashboard queries max, latency đạt peak (avg ~1.0-1.5s, p95 ~2.5-3.0s)
  - Export jobs nhiều nhất — create + status count đều cao
  - iter/s ổn định ở mức ~6-8 (có thể thấp hơn nếu DB saturated)
  - Đây là observation window quan trọng nhất

Stage 4 (14->1 VUs, 15s):
  - VU giảm từ 14 xuống 1
  - Dashboard queries giảm, latency giảm dần
  - gracefulRampDown=20s cho in-flight jobs hoàn tất
  - iter/s giảm dần về ~1-2
  - KHÔNG có failed iterations (0 ramping_active_iterations_failed)
    → Async flow survive ramp-down tốt với config hiện tại
```

Key insight từ run #55:

```text
- 301 iterations hoàn tất, 0 failed → tất cả staff flow đều OK
- Dashboard count = 301 đúng bằng iterations → mỗi loop đều có dashboard
- Create count = 101, Status count = 101 → 1:1 ratio (READY_AFTER_MS=50ms, poll 1 lần)
- Ratio create/status = 101/101 = 1.0 → không có polling loop dài
- Sleep count = 301s đúng bằng iterations × 1s → script chạy đúng think time
- avg flow duration 1.65s phù hợp: ~0.5s dashboard + 1s sleep + 0.15s optional export
- p95 flow duration 2.90s: kể cả worst case, loop dưới 3s
- VU shape 1->14 đúng contract, vus_max=14
- Peak iter/s = 8: ở 14 VU, loop_duration ~14/8 = 1.75s → backend khỏe
```
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 05

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
reporting_ramp_dashboard: GET /api/sim/report
reporting_ramp_create_job: POST /api/sim/report/jobs
reporting_ramp_job_status: GET /api/sim/report/jobs/:id
```

Cách đọc:

```text
ramp-up phase: latency có tăng khi VUs tăng không?
peak/plateau: p95/p99 có ổn định không?
ramp-down/recovery: latency có giảm lại không?
```

#### Phân tích sâu chart Response time theo stage

Khi nhìn chart này, đọc theo 4 câu hỏi:

```text
1. Operation nào có avg cao nhất?
2. Operation nào có p95 spike?
3. Operation nào có max outlier?
4. Dashboard latency có tăng theo stage không? (stage 1 vs stage 3)
```

Với case 05, shape đẹp thường có:

```text
dashboard read: avg thấp nhất trong 3 operation (GET nhẹ nhất)
                NHƯNG: đây là report query — có thể vẫn nặng ở peak!
job create:     avg cao hơn dashboard (POST + async accept)
job status:     avg thấp nhất (GET nhẹ, thường 1 poll với READY_AFTER_MS=50ms)

Nếu READY_AFTER_MS cao:
  job status có thể xuất hiện nhiều call hơn (do polling)
  → count của job_status > count của job_create
```

#### Phân tích operation-level latency

**reporting_ramp_dashboard**:

```text
Đây là operation quan trọng nhất vì chiếm ~60% API calls và chạy MỖI loop.
Dashboard count = iterations (vì mỗi loop đều gọi dashboard).

Nếu dashboard p95 cao:
  - DB query chậm (thiếu index, nhiều JOIN)
  - gzip response lớn (CPU nén)
  - Network bandwidth không đủ (response 50MB)

Theo stage:
  Stage 1 (1-5 VU): dashboard p95 thường thấp nhất
  Stage 2 (5-14 VU): dashboard p95 bắt đầu tăng nếu DB bắt đầu saturated
  Stage 3 (14 VU): dashboard p95 cao nhất — đây là stress test thật sự
  Stage 4 (14-1 VU): dashboard p95 giảm dần — recovery signal

→ Nếu dashboard p95 stage 3 / stage 1 > 3x → DB saturated ở peak.
```

**reporting_ramp_create_job**:

```text
Đây là operation ít gọi nhất (~20% calls) nhưng quan trọng cho async flow.
Mỗi 3 iteration mới có 1 create (__ITER % 3 === 0).

Nếu job_create p95 >> dashboard p95:
  - POST handler chậm (validation, DB insert)
  - Async worker queue đầy → 202 chậm accepted
  - DB write lock contention

Theo stage:
  Stage 3: create count cao nhất → áp lực POST lớn nhất
  Stage 4: create count giảm nhưng vẫn có thể có (VU còn active)
```

**reporting_ramp_job_status**:

```text
Với READY_AFTER_MS=50ms: count ~= create count (poll 1 lần, done ngay)
Với READY_AFTER_MS cao: count > create count (polling nhiều lần)

→ Kiểm count ratio: nếu status_count / create_count > 2, polling quá nhiều.
→ Nếu status_count / create_count = 1: async flow khỏe, job done ngay.

Theo stage:
  Stage 4: status count có thể vẫn cao dù create giảm
           (polling in-flight jobs từ stage 3)
  → Đây là tín hiệu gracefulRampDown đang hoạt động.
```

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| dashboard p95 cao ngay từ stage 1 | query luôn nặng, không phải do concurrency | tối ưu report query |
| dashboard p95 tăng dần từ stage 1 -> 3 | DB saturated khi VU tăng | kiểm DB resource, query plan |
| dashboard p95 stage 4 không giảm | không có recovery — DB vẫn saturated dù VU giảm | kiểm DB connection pool, leak |
| job_create p95 spike ở stage 3 | POST path chịu tải max | điều tra job create pipeline |
| job_status count >> job_create count | polling quá nhiều, READY_AFTER_MS cao | kiểm env, tối ưu poll interval |
| job_status có 404 | missing job ID — business failure | kiểm create response contract |
| dashboard p95 stage 4 = stage 1 | recovery tốt — DB hồi phục khi VU giảm | tín hiệu tốt |

Case-specific hints:

- Response time: dashboard vs create/status.
- Execution timeline: create/status spikes every third iteration pattern.
- VUs vs iter/s: low VU but heavy flow can still flatten iter/s at peak.

### Chart 2 — Execution timeline

Với ramping-vus:

```text
VUs should follow 1 -> 5 -> 14 -> 1.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Cách phân tích sâu chart Execution timeline

Chart này trả lời câu hỏi khác hẳn Response time:

```text
Response time chart:
  "request nhanh/chậm thế nào?"

Execution timeline:
  "tại mỗi giây, staff đã hoàn thành bao nhiêu loops? bao nhiêu request?
   Và VU count đang ở stage nào?"
```

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — staff count có đi theo stage shape không?
2. HTTP reqs mỗi bucket — bao nhiêu request hoàn thành trong giây đó?
3. Iterations mỗi bucket — bao nhiêu loop hoàn thành trong giây đó?
```

Với ramping-vus, shape "đẹp" thường là:

```text
Stage 1 (ramp-up 1->5):
  Live VUs tăng dần từ 1 lên 5
  iter/s và RPS tăng dần theo VU count
  Ít create/status (staff mới vào, chủ yếu đọc dashboard)

Stage 2 (ramp-up 5->14):
  Live VUs tăng mạnh từ 5 lên 14
  iter/s và RPS tăng theo
  Create/status bắt đầu xuất hiện rõ hơn (pattern mỗi 3 iteration)

Stage 3 (peak plateau 14):
  Live VUs giữ gần 14
  iter/s và RPS ổn định (có thể dao động nhẹ theo branch mix)
  Nếu iter/s không tăng tỉ lệ với stage 2 → saturation signal

Stage 4 (ramp-down 14->1):
  Live VUs giảm từ 14 xuống 1
  iter/s và RPS giảm theo
  CÓ THỂ thấy create/status vẫn xuất hiện (in-flight jobs)
  gracefulRampDown cho phép iterations hoàn tất thêm một chút sau khi VU đã giảm
```

Điểm khác với constant-vus:

```text
constant-vus:
  VU flat suốt 5m → iter/s ổn định từ đầu đến cuối
  Shape: flat plateau → abrupt stop

ramping-vus:
  VU thay đổi theo stage → iter/s thay đổi theo stage
  Shape: ramp-up → plateau → ramp-down → graceful tail
  → Có "đuôi" iterations sau khi VU đã giảm (gracefulRampDown)
  → Có thể thấy pattern mỗi 3 iteration (create/status) rõ hơn ở stage 3
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không theo stage shape | Config/env/scale/dashboard issue |
| iter/s không tăng khi VU tăng (stage 1->2) | Backend đã saturated sớm |
| iter/s giảm dù VU plateau (stage 3) | Backend degradation (leak, saturation) |
| Failures cluster ở stage 4 | Async flow bị ngắt khi ramp-down |
| Failures cluster ở stage 2 | Ramp-up quá nhanh, backend không kịp |
| http_reqs không tương quan với iterations | Branch mix thay đổi theo stage |
| Peak iter/s ở stage 2 nhưng giảm ở stage 3 | 14 VU oversaturate, throughput thấp hơn 10 VU |

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

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
Staff count có đi đúng shape 1->5->14->1 không?
Throughput loop có scale theo staff count không?
Điểm saturation ở stage nào?
```

Với ramping-vus, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
peak_rate_at_t ≈ active_vus_at_t / loop_duration_at_t

Nếu backend khỏe (loop_duration không đổi theo VU count):
  iter/s ∝ VUs → đường iter/s theo sát đường VUs
  → SCALING LINEAR: hệ thống scale tốt

Nếu backend saturated ở N VUs:
  iter/s tăng đến khi VU=N, sau đó flatten
  → KNEE: biết được capacity limit

Nếu backend oversaturated:
  iter/s có thể GIẢM dù VU tăng (thêm VU chỉ tạo queue dài hơn)
  → CONGESTION COLLAPSE: hệ thống sập
```

Shape mong đợi với case 05:

```text
- Stage 1 (1->5 VU): iter/s tăng từ ~1 lên ~3-4
- Stage 2 (5->14 VU): iter/s tăng lên ~6-8
  Nếu iter/s không tăng tỉ lệ → DB bắt đầu saturated
- Stage 3 (14 VU plateau): iter/s ổn định ~6-8
  Nếu iter/s <4 → DB oversaturated ở 14 VU
- Stage 4 (14->1 VU): iter/s giảm dần
  Tail iterations có thể xuất hiện (gracefulRampDown)
```

Các shape cần biết:

| Shape thấy trên chart | Ý nghĩa có thể là gì? | Đánh giá |
| --- | --- | --- |
| iter/s theo sát VU count, scaling gần tuyến tính | Backend khỏe, chưa saturated | Tốt |
| iter/s tăng đến VU=8-10 rồi flatten | DB saturated ở ~10 VU | Knee detected |
| iter/s giảm khi VU tăng từ 10->14 | Oversaturation — thêm VU phản tác dụng | Congestion collapse |
| iter/s còn dương khi VU đã về 1 | gracefulRampDown cho in-flight finish | Bình thường |
| iter/s = 0 khi VU=14 | Tất cả VU kẹt trong request dài | Backend treo |
| VUs không lên tới 14 | Config/env sai hoặc VU init lỗi | Kiểm header |
| iter/s spike ở stage transition | VU ramp-up/down trigger batch effects | Cần điều tra |

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

## Kết luận thực tế: output -> quyết định

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean reporting ramp | Backoffice start acceptable | Accept |
| Dashboard slow only | Report read/query/cache issue | Investigate dashboard |
| Job create/status failures | Async report pipeline issue | Block report release |
| Low iter/s clean checks | Heavy flow or ready wait | Interpret with READY_AFTER_MS |

### Kịch bản A — Ramp clean: BACKOFFICE PASS

```text
iterations................: 301
http_req_failed...........: 0.00%
checks....................: 100%
ramping_active_iterations: 301
ramping_active_iterations_failed: 0
http_reqs.................: 503

reporting_ramp_dashboard:   avg=0.5s, p95=0.8s, count=301
reporting_ramp_create_job:  avg=0.4s, p95=0.7s, count=101
reporting_ramp_job_status:  avg=0.2s, p95=0.4s, count=101

ramping_flow_duration_ms:   avg=1650, p95=2900
ramping_sleep_seconds:      301  (= 301 × 1s)
vus_min/max:                1 / 14
```

Kết luận thực tế:

```text
- VU shape 1->5->14->1 đúng contract
- 301 loops hoàn tất, 0 failed
- Dashboard read count = iterations → mỗi loop có dashboard ✓
- Create/status count = 101/101 → 1:1, polling 1 lần là done ✓
- Sleep count = 301s → think time đúng 1s/loop ✓
- Flow duration p95=2.9s → phù hợp sleep 1s + API ~1.9s
- KHÔNG có failure ở bất kỳ stage nào
=> QUYẾT ĐỊNH: reporting ramp OK. Accept.
   Report service chịu được staff ramp từ 1 lên 14 và ramp-down.
```

### Kịch bản B — Peak saturation: INVESTIGATE

```text
iterations................: 220  ← THẤP hơn kịch bản A (301)
http_req_failed...........: 0.00%
checks....................: 100%
ramping_active_iterations_failed: 0
http_reqs.................: 368

reporting_ramp_dashboard:   avg=2.8s, p95=5.5s, count=220  ← CHẬM
reporting_ramp_create_job:  avg=0.5s, p95=0.9s, count=74
reporting_ramp_job_status:  avg=0.3s, p95=0.6s, count=74

ramping_flow_duration_ms:   avg=4100, p95=6800
ramping_sleep_seconds:      220  (= 220 × 1s)
vus_min/max:                1 / 14
```

Kết luận thực tế:

```text
- VU shape vẫn đúng 1->5->14->1 → không phải lỗi test
- Nhưng iterations chỉ 220 (giảm 27% so với baseline 301)
- Dashboard avg=2.8s (chậm 5.6× so với baseline 0.5s)
- Export job create/status vẫn OK → vấn đề nằm ở dashboard read path
- Flow duration tăng 2.5× → staff làm ít việc hơn trong cùng thời gian
- Stage 3 (14 VU) là lúc dashboard chậm nhất

=> QUYẾT ĐỊNH: KHÔNG fail test vì iterations thấp.
   Đây là closed-model signal: dashboard query saturated ở peak 14 VU.
   Điều tra: DB index? Query plan? Cache hit rate? gzip CPU?
   Có thể cần scale DB hoặc tối ưu report query.
```

### Kịch bản C — Async job issue under ramp: INSPECT WORKER

```text
iterations................: 280
http_req_failed...........: 0.00%
checks....................: 98.2%  ← THẤP
ramping_active_iterations_failed: 12
http_reqs.................: 485

reporting_ramp_dashboard:   avg=0.6s, p95=1.0s, count=280  ✓ OK
reporting_ramp_create_job:  avg=0.4s, p95=0.8s, count=93   ✓ OK
reporting_ramp_job_status:  avg=5.5s, p95=12.0s, count=205 ← CHẬM + NHIỀU

  status_count / create_count = 205/93 = 2.2
  → Trung bình 2.2 lần poll mới done
  → Có thể do READY_AFTER_MS cao, hoặc worker chậm

  Failures cluster ở stage 4 (ramp-down):
  → 8/12 failed iterations xảy ra khi VU giảm từ 14->1
  → Async jobs bị ngắt giữa poll khi ramp-down
```

Kết luận thực tế:

```text
- Dashboard vẫn OK → không phải DB/query issue
- Job create vẫn accepted 202 → API gateway OK
- Nhưng job status chậm và cần poll nhiều (ratio 2.2)
- 12 loops failed, đa số ở stage 4 → async flow không survive ramp-down
- Có thể gracefulRampDown không đủ dài cho READY_AFTER_MS hiện tại
- Hoặc worker xử lý chậm, job không done kịp trước khi VU bị dừng

=> QUYẾT ĐỊNH: Điều tra async report worker.
   Worker có bị queue đầy không? Có đủ capacity không?
   READY_AFTER_MS có cần giảm? gracefulRampDown có cần tăng?
   Poll interval có phù hợp không?
   Đây là race condition giữa stage transition và async flow duration.
```

### Kịch bản D — Flow duration spike ở peak stage: TUNE PIPELINE

```text
iterations................: 180  ← RẤT THẤP
http_req_failed...........: 0.50%
checks....................: 99.0%
ramping_active_iterations_failed: 5
http_reqs.................: 310

reporting_ramp_dashboard:   avg=3.5s, p95=8.0s, count=180  ← RẤT CHẬM
reporting_ramp_create_job:  avg=2.8s, p95=7.0s, count=60   ← CHẬM
reporting_ramp_job_status:  avg=1.5s, p95=4.0s, count=65   ← CHẬM

ramping_flow_duration_ms:   avg=7200, p95=14000
  ← Flow duration p95 = 14s, quá cao cho 1 loop
  ← Gấp gần 5× baseline (2.9s)

vus_min/max:                1 / 14
```

Kết luận thực tế:

```text
- Tất cả operation đều chậm hơn baseline, không chỉ 1 operation
- Flow duration p95=14s: staff mất 14s cho 1 vòng
  → So với baseline 2.9s: chậm 4.8×
- Cả dashboard, create, status đều chậm → không phải 1 bottleneck
- 5 failed iterations, không cluster ở stage cụ thể → issue toàn cục
- Có thể: DB chung bị quá tải, network latency cao, hoặc resource contention

=> QUYẾT ĐỊNH: Điều tra toàn bộ report pipeline.
   Kiểm tra resource usage (CPU, memory, I/O) của report-service và DB.
   Có thể cần scale hoặc tune nhiều tầng.
   Stage 3 (14 VU) là window stress test chính.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Tất cả operation p95 thấp, 0 fail, VU shape đúng | Backoffice reporting ramp OK | Accept |
| Dashboard p95 stage 3 >> stage 1, còn lại OK | Report query saturated ở peak | Investigate dashboard query/DB |
| Create accepted nhưng status chậm/poll nhiều | Async worker issue | Inspect worker/status path |
| Failures cluster ở stage 4 | Async flow bị ngắt khi ramp-down | Tăng gracefulRampDown hoặc giảm READY_AFTER_MS |
| Tất cả operation cùng chậm ở stage 3 | Toàn bộ pipeline bottleneck ở peak | Tune report pipeline tổng thể |
| Iterations thấp hơn baseline nhưng VU shape đúng | Closed-model backpressure | Điều tra latency, không fail test |
| http_req_failed > 0, checks < 100% | Có request fail thật sự | Block, điều tra error |
| ramping_active_iterations_failed > 15 | Nhiều loop có business failure | Lọc theo user_id, operation, stage |
| Sleep count không khớp iterations × 1s | Script không chạy đúng sleep | Kiểm script logic, branch |
| VU shape không đúng 1->5->14->1 | Config/env/scale sai | Kiểm header, env vars, stage config |

## Nghịch lý và misconceptions của ramping-vus

### Nghịch lý 1: "14 VU là performance test?"

```text
Nhiều người nghĩ: "Performance test phải 100-1000 VU. 14 VU thì test được gì?"

Sai. Performance test không đo bằng VU count — đo bằng RESOURCE PRESSURE.

14 VU với:
  - Dashboard query: 50MB data, JOIN 5 bảng, GROUP BY, gzip
  - Mỗi query: 1.5 CPU cores, 200MB RAM
  - 14 query đồng thời ở stage 3: 21 cores demand, 2.8GB RAM
  → DB CPU 262%, disk I/O saturated

100 VU storefront với:
  - Product list query: 1KB data, index scan, cache hit
  - Mỗi query: 0.05 CPU cores, 5MB RAM
  - 100 query đồng thời: 5 cores demand, 500MB RAM
  → DB CPU 60%, còn dư

→ 14 VU backoffice STRESS hơn 100 VU storefront.
→ "Performance test" là test resource saturation, không phải test VU count.
→ Case này CÓ THỂ là performance test nặng nhất trong bộ 7 case ramping-vus.
```

### Nghịch lý 2: "Ramp-up làm lộ async race condition"

```text
"Tại sao constant-vus case 06 không thấy async issue,
 nhưng ramping-vus case 05 lại thấy?"

Vì ramp-down tạo race condition giữa stage transition và async flow duration:

constant-vus: VU luôn active, không bao giờ bị dừng giữa poll.
  → Async flow an toàn, job luôn được poll đến khi done.
  → KHÔNG thấy race condition.

ramping-vus: VU bị ramp-down theo stage.
  → Nếu VU đang poll job khi stage 4 bắt đầu:
      gracefulRampDown cho 20s để hoàn tất iteration.
      Nếu job done trong 20s → OK.
      Nếu job cần poll >20s (READY_AFTER_MS cao) → iteration bị ngắt.
      → Loop failed — nhưng job vẫn được tạo (202)!
  → Đây là business scenario THẬT:
      Staff tạo export job lúc 7:55 (gần cuối peak).
      Staff tan làm lúc 8:00 (ramp-down).
      Job chạy xong lúc 8:05 — nhưng staff đã về.
      → Job "mồ côi" — không ai check kết quả.

→ Ramp-down làm LỘ async race condition mà constant-vus không thấy.
→ Đây là LÝ DO dùng ramping-vus cho case này thay vì constant-vus.
```

### Nghịch lý 3: "iter/s thấp nhưng test pass?"

```text
"Case 01 (daily traffic curve, 24 VU peak): iter/s ~15-20
 Case 05 (reporting ramp, 14 VU peak): iter/s ~3.6
 Case 05 iter/s thấp hơn nhiều — sao vẫn pass?"

Vì iter/s không phải target. Đây là output từ:
  1. Report query nặng (dashboard 50MB vs product list 1KB)
  2. Sleep 1s mỗi loop (staff đọc report)
  3. READY_AFTER_MS kéo dài flow khi có export

Công thức:
  iter/s ≈ active_vus / loop_duration

  Case 01 (storefront, 24 VU): loop_duration ~1.2s → iter/s ~20
  Case 05 (report, 14 VU):     loop_duration ~1.7s → iter/s ~8.2
    (nhưng thực tế run #55 đạt 3.6/s vì duration scale 0.25 làm giảm avg VUs)

→ iter/s khác nhau vì BUSINESS SHAPE khác nhau.
→ Không so sánh iter/s giữa 2 case khác business.
→ iter/s chỉ có ý nghĩa khi so sánh CÙNG case, CÙNG config, KHÁC thời điểm.
```

### Nghịch lý 4: "Tăng peak VUs lên 28 nhưng iter/s không tăng gấp đôi?"

```text
"Peak VU=14 → iter/s~3.6. Peak VU=28 → iter/s~4.2 (không phải 7.2).
 Sao không tăng gấp đôi?"

Vì throughput không tăng tuyến tính khi backend bị bão hòa:

  VU=14: Nếu dashboard vẫn 0.5s → loop_duration=1.65s, iter/s=14/1.65≈8.5
         NHƯNG: 14 query đồng thời, mỗi query 1.5 cores
         → 21 cores demand > 8 cores supply
         → Queue hình thành, dashboard latency thực tế ~1.0-1.5s
         → loop_duration=2.65s, iter/s=14/2.65≈5.3

  VU=28: 28 query đồng thời → 42 cores demand vs 8 cores supply
         → Queue dài hơn, dashboard latency tăng lên 3-5s
         → loop_duration=5.65s, iter/s=28/5.65≈5.0
         → iter/s KHÔNG TĂNG, thậm chí CÓ THỂ GIẢM!

  → Thêm VU chỉ làm queue dài hơn, không tăng throughput.
  → Đây là dấu hiệu backend đã bão hòa.
  → Cần scale backend (thêm CPU, tối ưu query), không phải tăng VU.
```

### Nghịch lý 5: "Dashboard OK mà loop fail?"

```text
"Checks pass, http_req_failed=0, dashboard p95=0.8s.
 Nhưng ramping_active_iterations_failed=12.
 Sao dashboard OK mà loop fail?"

Vì loop fail không phải do HTTP request fail.
Mỗi loop gồm nhiều bước:
  1. Dashboard read (có thể pass — 200 OK)
  2. Sleep (luôn pass)
  3. Export job create (có thể pass — 202 Accepted)
  4. Export job status poll (CÓ THỂ FAIL nếu job không bao giờ "done"
     hoặc job ID missing, hoặc poll bị ngắt bởi ramp-down)

Loop fail khi:
  - Job được tạo (202) nhưng status không về "done" trước khi grace hết
  - Missing job ID trong create response
  - Poll loop bị ngắt bởi gracefulRampDown

Trong khi http_req_failed=0 vì:
  - Tất cả HTTP request đều trả về 200/202
  - Không có connection error, timeout DNS
  - Nhưng business contract (job done) không đạt

→ Phải phân biệt "HTTP success" và "business success".
→ ramping_active_iterations_failed đo business success, không phải HTTP success.
→ Đặc biệt trong ramping-vus: failure có thể do RAMP-DOWN, không phải backend fail.
```

## Checklist đọc biểu đồ case 05

Khi học sinh nhìn dashboard case 05, đọc theo thứ tự này:

```text
1. Overview KPI
   - ramping_active_iterations_failed < 15?
   - http_req_failed < 1%?
   - checks > 99%?
   - vus_max có gần peak target (14) không?

2. VUs vs iter/s
   - VU shape có đi đúng 1 -> 5 -> 14 -> 1 không?
   - iter/s có tăng theo VU count không? (stage 1 vs stage 3)
   - iter/s có flatten ở stage nào không? (knee detection)
   - Có tail iterations sau khi VU giảm không? (gracefulRampDown)

3. Response time chart
   - Tách theo operation (dashboard, job_create, job_status) chưa?
   - Dashboard p95 stage 3 có >> stage 1 không? (saturation signal)
   - Dashboard p95 stage 4 có về mức stage 1 không? (recovery signal)
   - Job status count / job create count ratio? (polling efficiency)
   - Có operation nào p95 spike không?

4. Execution timeline
   - VUs có theo stage shape không?
   - iter/s và RPS có tương quan với VU count không?
   - Create/status có pattern mỗi 3 iteration không?
   - Failures có cluster ở stage transition không? (stage 4 ramp-down?)

5. Business decision
   - ramping_active_iterations_failed = 0 hoặc rất thấp?
   - Dashboard latency chấp nhận được ở peak 14 VU?
   - Export job create/status OK?
   - Async flow có survive ramp-down không?
   - Flow duration phù hợp với sleep + API time?
   - Sleep count = iterations × 1s?
```

Kết luận của run case 05 đang đúng nếu thấy:

```text
http_req_failed = 0% hoặc rất thấp
checks > 99%
ramping_active_iterations_failed < 15
VU shape đúng 1 -> 5 -> 14 -> 1
Dashboard p95 stage 3 < 3s (tùy SLA team)
Job create p95 < 5s (tùy SLA team)
Flow duration p95 < 5s
Sleep seconds ≈ iterations × 1s
status_count / create_count ≈ 1.0 (với READY_AFTER_MS thấp)
executor = ramping-vus
vus_max = peak target (14 hoặc env override)
```

## Mở rộng

- Tăng duration scale để chạy gần business timeline hơn.
- Tăng peak VUs để tìm capacity knee.
- Tăng/giảm sleep để xem think time ảnh hưởng iter/s.
- Thêm threshold theo operation p95 nếu muốn biến case thành gate.
- Sau khi chạy thật, thêm real-run section riêng có command/env/run ID/số summary.

### Variation A: Thay đổi READY_AFTER_MS để quan sát async timing

```powershell
# Async job ready gần như ngay (default)
$env:RV_05_READY_AFTER_MS = 50
k6 run ...rv-05-reporting-ramp.js
# Expected: status poll 1 lần, ratio status/create ≈ 1.0

# Async job ready sau 500ms
$env:RV_05_READY_AFTER_MS = 500
k6 run ...rv-05-reporting-ramp.js
# Expected: status poll 1-2 lần, flow duration tăng nhẹ

# Async job ready sau 2s (stress test polling)
$env:RV_05_READY_AFTER_MS = 2000
k6 run ...rv-05-reporting-ramp.js
# Expected: status poll 3-5 lần, flow duration tăng, ratio > 1.5
# Có thể thấy failed iterations nếu poll bị ngắt bởi ramp-down

# Async job ready sau 5s (race condition test)
$env:RV_05_READY_AFTER_MS = 5000
k6 run ...rv-05-reporting-ramp.js
# Expected: status poll nhiều lần, flow duration tăng mạnh
# RẤT CÓ THỂ thấy failed iterations cluster ở stage 4
# → gracefulRampDown 20s có đủ không?
```

Điều cần quan sát:

```text
- job_status count / job_create count ratio thay đổi theo READY_AFTER_MS
- Flow duration tăng tỉ lệ với READY_AFTER_MS × branch_mix
- iter/s giảm khi READY_AFTER_MS tăng
- Nếu READY_AFTER_MS cao + gracefulRampDown ngắn → failed loops ở stage 4
- Stage 4 failures = race condition giữa ramp-down và async flow
```

### Variation B: Thêm polling loop để handle READY_AFTER_MS cao

```js
// Trong export branch, thêm polling loop:
const READY_AFTER_MS = parseInt(__ENV.RV_05_READY_AFTER_MS || "50");
const POLL_INTERVAL_MS = parseInt(__ENV.RV_05_POLL_INTERVAL_MS || "500");
const MAX_POLLS = parseInt(__ENV.RV_05_MAX_POLLS || "10");

// Wait initial ready_after
if (READY_AFTER_MS > 0) {
  sleep(READY_AFTER_MS / 1000);
}

// Poll status
let polls = 0;
let jobDone = false;

while (!jobDone && polls < MAX_POLLS) {
  const statusRes = http.get(`${__ENV.BASE_URL}/api/sim/report/jobs/${jobId}`, {
    tags: { ...tags, operation: "reporting_ramp_job_status" },
  });

  if (statusRes.json("status") === "done") {
    jobDone = true;
    check(statusRes, { "job completed": (r) => r.status === 200 });
  } else {
    polls++;
    if (polls < MAX_POLLS) {
      sleep(POLL_INTERVAL_MS / 1000);
    }
  }
}

if (!jobDone) {
  // Job không done trong MAX_POLLS — có thể do:
  // 1. READY_AFTER_MS quá cao
  // 2. Worker xử lý chậm
  // 3. gracefulRampDown không đủ dài
  console.warn(`staff-${__VU} iter-${__ITER} job ${jobId} not done after ${MAX_POLLS} polls`);
}
```

So sánh với code không có polling loop:

```text
Không polling loop (hiện tại):
  - READY_AFTER_MS thấp (50ms): 1 poll, done ngay
  - READY_AFTER_MS cao (5000ms): 1 poll, có thể "processing" → loop KHÔNG fail nhưng job chưa done thật
  - Đơn giản, nhanh

Có polling loop:
  - READY_AFTER_MS thấp: 1 poll, done ngay — giống không polling
  - READY_AFTER_MS cao: poll đến khi done hoặc maxPolls
  - Chính xác hơn: biết chắc job đã done hay chưa
  - NHƯNG: flow duration dài hơn → dễ bị ramp-down interrupt hơn
  - Trade-off: accuracy vs ramp-down survival
```

### Variation C: Tăng peak VUs để tìm capacity knee

```powershell
# Baseline: peak 14 VU
$env:RV_05_PEAK_VUS = 14
k6 run ...rv-05-reporting-ramp.js

# Moderate: peak 20 VU
$env:RV_05_PEAK_VUS = 20
k6 run ...rv-05-reporting-ramp.js

# High: peak 28 VU
$env:RV_05_PEAK_VUS = 28
k6 run ...rv-05-reporting-ramp.js

# Stress: peak 40 VU
$env:RV_05_PEAK_VUS = 40
k6 run ...rv-05-reporting-ramp.js
```

Điều cần quan sát khi tăng peak VUs:

```text
- iter/s có tăng tuyến tính không? Nếu không, tìm knee ở đâu?
  → Vẽ curve: peak VU (x) vs iter/s ở stage 3 (y)
  → Knee là điểm mà slope bắt đầu giảm mạnh

- Dashboard p95 stage 3 có tăng không?
  → Nếu p95 > 5s: DB oversaturated

- ramping_active_iterations_failed có tăng không?
  → Nếu tăng: backend quá sức, bắt đầu drop/crash

- VU shape còn đúng không?
  → Nếu VU không lên được peak target: VU init bị kẹt

- Recovery ở stage 4 có còn tốt không?
  → Nếu dashboard p95 stage 4 không giảm: DB không hồi phục được
```

### Variation D: Tăng duration scale để chạy gần business timeline

```powershell
# Default: scale 0.25 (effective ~83s)
$env:RV_05_DURATION_SCALE = 0.25
k6 run ...rv-05-reporting-ramp.js

# Half scale: ~166s
$env:RV_05_DURATION_SCALE = 0.5
k6 run ...rv-05-reporting-ramp.js

# Full scale: ~330s (gần 6 phút — sát business timeline thật)
$env:RV_05_DURATION_SCALE = 1.0
k6 run ...rv-05-reporting-ramp.js
```

Điều cần quan sát khi tăng duration:

```text
- Dashboard p95 có tăng dần theo thời gian không?
  → Nếu tăng: memory leak, DB connection pool cạn, cache eviction

- iter/s có ổn định suốt stage 3 (plateau) không?
  → Nếu giảm dần: degradation theo thời gian

- ramping_active_iterations_failed có tăng ở phút thứ 3+ không?
  → Nếu tăng: async worker bị backlog, job timeout

- DB CPU/memory có trend tăng không?
  → Nếu tăng: resource leak
```

### Variation E: Thay đổi sleep để quan sát think time effect

```powershell
# Staff đọc nhanh (0.2s think time)
$env:RV_05_SLEEP_SECONDS = 0.2
k6 run ...rv-05-reporting-ramp.js
# Expected: iter/s cao hơn, flow duration ngắn hơn

# Staff đọc chậm (3s think time)
$env:RV_05_SLEEP_SECONDS = 3
k6 run ...rv-05-reporting-ramp.js
# Expected: iter/s thấp hơn, flow duration dài hơn
# DB pressure có thể GIẢM vì mỗi VU loop chậm hơn
```

Điều cần quan sát:

```text
- iter/s thay đổi tỉ lệ nghịch với sleep (closed-model)
- Dashboard p95 CÓ THỂ giảm khi sleep dài hơn:
  sleep dài → VU loop chậm hơn → ít query đồng thời hơn → DB nhẹ hơn
  → Paradox: sleep dài hơn → dashboard latency THẤP Hơn!
  → Đây là closed-model behavior: think time giảm concurrency pressure
```

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm.
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Nghĩ "14 VU nên không phải performance test".
- So sánh iter/s của case 05 với case 01 (khác business shape).
- Không tách operation tag — để aggregate che mất job create/status latency.
- Không so sánh stage 1 vs stage 3 dashboard p95 — bỏ lỡ saturation signal.
- Không check READY_AFTER_MS khi so sánh flow duration giữa 2 run.
- Không kiểm failures có cluster ở stage 4 không — bỏ lỡ ramp-down race condition.
- Bỏ qua recovery signal: dashboard p95 stage 4 phải về gần stage 1.
- Dùng `ramping-arrival-rate` rồi thắc mắc tại sao không thấy VU identity và async race condition.
- Đặt gracefulRampDown quá ngắn (<5s) rồi thắc mắc tại sao có nhiều failed iterations.
- Không phân biệt "HTTP success" (200/202) và "business success" (job done, loop complete).
- Polling vô hạn không có maxPolls -> loop treo nếu worker không bao giờ done.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Worked example: `../../20260517_03_ramping-vus-quickpizza-two-requests-worked-example.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-05-reporting-ramp.js`
- Constant-vus contrast (case 06): `../constant-vus/06_backoffice-report-users.md`
