# Case 05: Report API ingress

## Tình huống thực tế

Backoffice/reporting APIs thường có 2 loại traffic:

```text
1. dashboard read: user mở report/dashboard — nhẹ, nhanh, 1 HTTP GET
2. async job: user tạo job export/report dài rồi poll trạng thái — nặng, chậm, 2 HTTP calls + wait
```

Traffic này đến theo ingress rate từ UI hoặc scheduler cron job. Ví dụ thực tế:

```text
Mỗi sáng 8h, 200 nhân viên sales mở dashboard xem báo cáo doanh số hôm qua.
Mỗi người mở dashboard (~70%) hoặc trigger async export report (~30%).

Nếu report service chậm (async job queue đầy, DB backup đang chạy, external API timeout):
  - User mở dashboard -> vẫn OK, load nhanh
  - User trigger async export -> chờ lâu, giữ connection, tốn worker thread
  - Nhiều user cùng trigger async -> pool cạn -> request mới bị từ chối

Câu hỏi: hệ thống có chịu được áp lực này ở rate cố định không?
```

Câu hỏi business:

```text
Report service có chịu được 6 report arrivals/s trong 45s không?
Với 30% là async job (tạo job + poll status, mỗi event kéo dài ~140ms+)?
```

### Vì sao case này là "THE FAILING CASE" — case dạy quan trọng nhất series

Trong toàn bộ series constant-arrival-rate, đây là case được thiết kế để **cố tình FAIL**. Không phải fail vì HTTP 500, không phải fail vì check sai. Fail vì:

```text
checks = 100%     ← tất cả HTTP response đều đúng status code
http_req_failed = 0%  ← không request nào bị lỗi mạng/protocol
nhưng
dropped_iterations = 22 > 0  ← TEST FAIL
```

Đây là nghịch lý cốt lõi của open model mà case này dạy: **"Tất cả request đều OK nhưng test vẫn FAIL"**. Sinh viên nào hiểu được nghịch lý này thì đã nắm được bản chất của constant-arrival-rate.

```text
Trong closed model (constant-vus): nếu tất cả request OK -> test pass.
Trong open model (constant-arrival-rate): hợp đồng là ARRIVAL RATE,
không phải HTTP status. Nếu arrival không start được (drop) -> breach contract.
```

Case này sẽ được dùng làm "case study chính" khi giảng dạy open model, vì nó phơi bày toàn bộ 4 nghịch lý, 5 nguyên nhân gốc, và dạy cách đọc dropped_iterations như tín hiệu contract breach chứ không phải "lỗi HTTP".

## 2 yêu cầu cốt lõi

### Yêu cầu (a): 6 report arrivals/s duy trì trong 45s

**Ý nghĩa**: Dù backend chậm hay nhanh, dù async job kéo dài bao lâu, hệ thống kiểm thử phải start ĐÚNG 6 arrivals mỗi giây. Không được phép "tự giảm tốc" vì async path chậm.

**Ví dụ cụ thể**:

```text
Scenario: team ops muốn biết report service có handle được load giờ cao điểm không.

Trường hợp A (open model — constant-arrival-rate):
  rate=6/s, duration=45s
  Backend chậm -> VU pool căng -> một số slot bị drop
  Kết quả: iterations=249 (thiếu 21 so với 270 expected)
  -> Kết luận: hệ thống KHÔNG đủ năng lực ở 6/s, cần scale up HOẶC tối ưu async path

Trường hợp B (closed model — constant-vus):
  vus=20, duration=45s
  Backend chậm -> mỗi VU hoàn thành ít iteration hơn -> throughput tự giảm
  Kết quả: iterations=180, http_req_duration p95=2s — trông "bình thường" vì không drop
  -> Kết luận: SAI! Throughput thực tế là 180/45=4/s, không phải 6/s.
     Test không phát hiện được hệ thống không chịu nổi 6/s.
     Đây là "silent degradation" — nguy hiểm nhất.
```

**Vì sao throughput tự giảm trong closed model là nguy hiểm?**

```text
Khi report service vào giờ cao điểm:
  - UI/scheduler vẫn gửi 6 request/s đến API gateway
  - Nếu service chậm, request queue đầy, gateway bắt đầu drop/timeout
  - User thấy "504 Gateway Timeout" hoặc dashboard không load được

Nhưng test với constant-vus:
  - k6 có 20 VU, mỗi VU xong 1 event mới bắt đầu event tiếp
  - Khi async job chậm, VU bị giữ lâu -> ít event hoàn thành hơn
  - Test report: "180 iterations, avg response 800ms, mọi thứ OK"
  - Không hề có tín hiệu "drop" hay "timeout" vì k6 KHÔNG tạo request mới
    khi tất cả VU đang bận

-> Production: 6 request/s -> gateway drop/timeout
-> Test: "OK" vì closed model tự throttle
-> Đây là "false negative" trong performance test: test pass nhưng production fail
```

**Phân tích sâu: vì sao constant-arrival-rate là executor duy nhất phát hiện được?**

`constant-vus` với `vus=20, duration="45s"`:

```text
Công thức throughput khi chạy:
  throughput = vus / event_duration
             = 20 / W

Nếu W = 0.5s (toàn dashboard): throughput = 20/0.5 = 40/s -> dư sức
Nếu W = 5s (async job chậm): throughput = 20/5 = 4/s -> dưới target 6/s

Nhưng test không báo FAIL! Nó chỉ báo "chạy được 180 iterations trong 45s".
Người đọc phải TỰ TÍNH 180/45=4/s và TỰ SO với target 6/s.
90% người đọc test sẽ không làm phép tính này, họ chỉ nhìn "checks=100%, 0 fail -> OK".
```

`constant-arrival-rate` với `rate=6, duration="45s"`:

```text
Công thức:
  N_sched = rate × duration = 6 × 45 = 270 slots
  N_done = N_sched - N_drop

Nếu backend chậm:
  - k6 vẫn cố tạo 6 arrival events/s
  - Khi VU pool cạn -> dropped_iterations tăng
  - Kết quả: iterations=249, dropped=22

Người đọc thấy ngay: "dropped_iterations=22 > 0 -> FAIL".
Không cần tự tính. Drop là tín hiệu rõ ràng, không thể bỏ qua.
```

**Tóm tắt 2 executor về phát hiện capacity issue**:

| Executor | Có tự giảm throughput khi backend chậm? | Có báo hiệu rõ khi thiếu capacity? | Phát hiện được "false negative"? |
| --- | --- | --- | --- |
| **constant-arrival-rate** | KHÔNG (giữ rate cố định) | CÓ (dropped_iterations) | ✅ CÓ |
| constant-vus (duration) | CÓ (throughput = vus/W) | KHÔNG (test vẫn "pass") | ❌ KHÔNG |
| ramping-vus | CÓ (tương tự constant-vus) | KHÔNG | ❌ KHÔNG |
| shared-iterations | CÓ (hết iter thì dừng) | KHÔNG | ❌ KHÔNG |
| per-vu-iterations | N/A (không có duration target) | N/A | ❌ KHÔNG |

→ Chỉ **constant-arrival-rate** phát hiện được capacity issue khi async latency cao.
→ Đây là lý do case này DÙNG constant-arrival-rate.

### Yêu cầu (b): Zero dropped iterations dù có async wait

**Ý nghĩa**: Async job branch có `sleep(140ms)` giữ VU. Dù vậy, VU pool phải đủ lớn để không slot nào bị drop. Đây là bài toán sizing VU cho open model với bimodal event duration.

**Vì sao đây là yêu cầu khó?**

```text
Dashboard event: 1 GET request, hoàn thành trong ~1-5ms -> W_dashboard ≈ 1-5ms
Async job event: POST create (2ms) + wait(140ms) + GET status (2ms) -> W_async ≈ 144ms

Đây là bimodal distribution: 70% events rất nhanh, 30% events chậm hơn ~100 lần.

Công thức VU cần thiết (Little's Law):
  required_vus = λ × W_avg
               = 6 × (0.7 × 0.003 + 0.3 × 0.144)
               = 6 × (0.0021 + 0.0432)
               = 6 × 0.0453
               ≈ 0.27 VU  ← TRÊN LÝ THUYẾT, quá ít!

Nhưng thực tế: Run 93 với preAllocatedVUs=20, maxVUs=50 vẫn DROP 22 iterations.
Vì sao?

Vì Little's Law dùng W_avg (trung bình), nhưng VU pool exhaustion xảy ra do TAIL LATENCY.
Khi p95 event duration = 7950ms (7.95 giây!), một số VU bị giữ hàng giây.
Trong lúc đó, arrival scheduler vẫn bắn 6 slots/s.
Nếu 6 slots/s × 7.95s = ~48 VU bị chiếm cùng lúc -> vượt maxVUs=50 -> drop.

Công thức đúng phải là:
  required_vus_for_no_drop ≥ λ × W_p95 (không phải W_avg)
  ≥ 6 × 7.95
  ≥ 47.7 ≈ 48 VU

Và thực tế maxVUs=50, active VU max observed=41, drop=22.
→ Vẫn chưa đủ vì p95 thực tế còn cao hơn, và arrival distribution không đều.
```

## Vì sao chọn `constant-arrival-rate`?

### So sánh executor cho case report API ingress

| Executor | Giữ được arrival rate cố định? | Phát hiện drop khi thiếu capacity? | Phù hợp test ingress contract? | Verdict |
| --- | --- | --- | --- | --- |
| **constant-arrival-rate** | ✅ rate=6 cố định | ✅ dropped_iterations | ✅ đúng mục tiêu | ✅ DÙNG |
| constant-vus | ❌ throughput giảm khi W tăng | ❌ không có drop | ❌ test sai bản chất | ❌ |
| ramping-vus | ❌ throughput biến thiên | ❌ không có drop | ❌ không fixed rate | ❌ |
| ramping-arrival-rate | ⚠️ có thể nhưng phức tạp hóa | ✅ có drop | ⚠️ overkill cho case này | ❌ |
| shared-iterations | ❌ hết iter thì dừng | ❌ không concept drop | ❌ không duration-based | ❌ |
| per-vu-iterations | ❌ không có duration | ❌ không drop | ❌ hoàn toàn sai mục đích | ❌ |

### Phân tích sâu: vì sao constant-vus "dối" trong case này?

Dùng constant-vus để test ingress contract là một trong những sai lầm phổ biến nhất. Hãy xem xét 3 kịch bản:

```text
Kịch bản 1: Backend khỏe, dashboard + async job đều nhanh
  constant-vus (vus=20, duration=45s):
    W_avg ≈ 5ms -> throughput = 20/0.005 = 4000 events/s -> dư sức
    Kết luận: "pass" -> đúng, nhưng không nói lên được gì về capacity thật
  constant-arrival-rate (rate=6/s):
    W_avg ≈ 5ms -> required_vus ≈ 0.03 -> 20 VU dư rất nhiều
    Kết luận: "pass" -> đúng

Kịch bản 2: Backend hơi chậm, async job ~200ms
  constant-vus:
    W_avg ≈ 0.7×5ms + 0.3×200ms = 63.5ms
    throughput = 20/0.0635 ≈ 315 events/s
    Kết luận: "315 events/s > 6/s -> pass" -> SAI! Đây là test closed model,
    không kiểm tra được liệu system có handle 6 arrivals/s khi có external traffic không
  constant-arrival-rate:
    W_avg ≈ 63.5ms -> required_vus ≈ 0.38 -> 20 VU vẫn dư
    Kết luận: "pass" -> đúng

Kịch bản 3: Backend rất chậm, async job ~8s (như Run 93 thực tế)
  constant-vus:
    W_avg ≈ 0.7×5ms + 0.3×8000ms = 2405ms
    throughput = 20/2.405 ≈ 8.3 events/s
    Kết luận: "8.3 events/s > 6/s -> vẫn pass?" -> SIÊU SAI!
    Vì 8.3/s là throughput CỦA 20 VU TRONG CLOSED MODEL.
    Production có 6 arrivals/s từ bên ngoài, mỗi arrival cần VU riêng.
    20 VU không đủ cho 6 arrivals/s với W_p95=8s.
  constant-arrival-rate:
    drop=22 -> FAIL rõ ràng
    Kết luận: "KHÔNG đủ capacity cho 6/s" -> ĐÚNG!
```

**Ghi nhớ**: Khi test ingress/arrival contract, LUÔN dùng open model executor. Closed model executor (constant-vus, ramping-vus) sẽ "giấu" capacity issue bằng cách tự giảm throughput.

### Vì sao async latency không được phép throttle ingress?

Trong production thực tế:

```text
Người dùng không tự động "chậm lại" khi server chậm.
Họ vẫn click, vẫn gửi request với cùng tốc độ.
Nếu server chậm -> request queue đầy -> gateway từ chối request mới.

Đây chính xác là điều constant-arrival-rate mô phỏng:
  - rate=6/s: scheduler vẫn tạo 6 arrivals/s đều đặn
  - Nếu không đủ VU -> drop (tương đương gateway từ chối)
  - Đây là hành vi THẬT của production, không phải artifact của test
```

Nguyên tắc thiết kế:

```text
"Async latency is the system's problem, not the caller's problem.
 The caller should not slow down because the system is slow.
 If the system can't handle the ingress rate, it must be scaled up —
 not silently degrade the caller's experience."
```

## Phân tích nguyên nhân gốc kỹ thuật (5)

### RC1: sleep/wait trong iteration giữ VU vượt quá HTTP response time

**Mô tả**: Trong async_job branch, sau khi POST create job, code có `wait((READY_AFTER_MS + 20) / 1000)` = `wait(0.14)` — giữ VU 140ms. HTTP response time của POST có thể chỉ 2ms, nhưng VU vẫn bị giữ thêm 140ms vì wait.

```js
// Code thật từ car-05-report-api-ingress.js (async_job branch)
const create = requestJson('POST', `${TARGET_URL}/api/sim/report/jobs?...`, ...);
// create mất ~2ms -> HTTP response đã về
const jobId = create.ok ? responseJson(create.response, 'data.job_id', '') : '';
if (jobId) {
  wait((READY_AFTER_MS + 20) / 1000);  // ← GIỮ VU 140ms SAU KHI HTTP đã xong!
  // Trong 140ms này, VU không làm gì, nhưng vẫn "bận"
  // Scheduler vẫn bắn 6 slots/s -> cần VU mới
  const status = requestJson('GET', `${TARGET_URL}/api/sim/report/jobs/${jobId}?...`, ...);
}
```

**Phân biệt quan trọng**:

```text
http_req_duration:     thời gian HTTP request hoàn thành (~2ms cho POST, ~2ms cho GET)
event_duration:         thời gian từ start đến khi toàn bộ callback xong
                       = http_req_duration + wait_time + processing_time
                       ≈ 2ms + 140ms + 2ms = 144ms

W_effective = event_duration (KHÔNG phải http_req_duration)

Sai lầm phổ biến: Dùng http_req_duration để sizing VU.
Đúng: Phải dùng event_duration vì wait/sleep cũng giữ VU.
```

**Demo trace cho 1 async_job event**:

```text
T=0.000s: VU #15 bắt đầu event
T=0.002s: POST /api/sim/report/jobs hoàn thành (http_req_duration=2ms)
          job_id = "job-abc-123" -> parse được
T=0.002s: BẮT ĐẦU wait(0.14)
          → VU #15 vẫn "busy", không nhận event mới
          → Scheduler tạo slot mới -> cần VU khác
T=0.142s: KẾT THÚC wait -> BẮT ĐẦU GET job status
T=0.144s: GET /api/sim/report/jobs/job-abc-123 hoàn thành (http_req_duration=2ms)
T=0.144s: finishEvent() -> VU #15 được giải phóng

Tổng event_duration = 144ms
Trong đó: http_req_duration = 2ms + 2ms = 4ms (CHỈ 2.8% !)
          wait_time = 140ms (97.2% thời gian)

→ 140ms/144ms = 97.2% thời gian VU bận là do wait, không phải HTTP!
→ Dùng http_req_duration để sizing -> sai 1 bậc magnitude (4ms vs 144ms = 36x)
```

### RC2: async_job branch tạo bimodal event duration distribution

**Mô tả**: Case này có 2 loại event với duration khác biệt rất lớn:

```text
Dashboard event (70%):
  - 1 GET request: ~1-5ms
  - Không có wait
  - W_dashboard ≈ 1-5ms
  - VU được giải phóng gần như ngay lập tức

Async job event (30%):
  - POST create (~2ms) + wait(140ms) + GET status (~2ms)
  - W_async ≈ 144ms (danh nghĩa, với READY_AFTER_MS=120)
  - Nhưng thực tế W_async có thể CAO HƠN NHIỀU do backend xử lý thật
  - VU bị giữ lâu hơn ~30-100 lần so với dashboard event
```

**Bimodal distribution visualized**:

```text
Event duration distribution (conceptual):

Dashboard (70%):  ████████████████████████████████████████  (1-5ms)
                  0ms                                        10ms

Async job (30%):                                    ████████  (144ms+)
                                                   100ms     8000ms
                                                            (p95 thực tế)

Phân phối bimodal: 2 "đỉnh" tách biệt
  - Đỉnh 1 ở ~2ms (dashboard)
  - Đỉnh 2 ở ~144ms-8000ms (async_job)
  - Khoảng cách giữa 2 đỉnh: 70-4000 lần
```

**Vì sao bimodal nguy hiểm cho VU pool?**

```text
Với phân phối unimodal (tất cả event ~cùng duration):
  - Tất cả VU bận khoảng thời gian như nhau
  - VU pool quay vòng đều đặn
  - Little's Law với W_avg dự đoán chính xác

Với phân phối bimodal (2 nhóm duration rất khác nhau):
  - Nhóm nhanh (dashboard): VU quay vòng nhanh, luôn sẵn sàng
  - Nhóm chậm (async_job): VU bị giữ lâu, "kẹt" trong pool
  - Khi nhiều async_job chạy cùng lúc -> pool cạn VU nhanh
  - Dashboard event mới không tìm được VU (dù chỉ cần 1-5ms) -> DROP

  Vấn đề không phải là THIẾU VU tổng thể, mà là VU bị "chiếm dụng" bởi nhóm chậm.
  Đây gọi là "head-of-line blocking" trong VU pool.
```

**Minh họa bằng số**:

```text
Thời điểm T=10s: đã schedule 60 slots (10s × 6/s)
  Dashboard expected: 60 × 0.7 = 42 events, mỗi event 5ms -> 42 VU cần trong 5ms
  Async expected:     60 × 0.3 = 18 events, mỗi event 144ms -> 18 VU cần trong 144ms

Tại T=10.000s: 42 dashboard event đã xong (chỉ mất 5ms)
               18 async_job vẫn đang chạy (đã 144ms nhưng chưa xong nếu vừa start)
Tại T=10.001s: scheduler bắn thêm 6 slots
               6 VU cần ngay, nhưng 18 VU đang bận với async_job
               Nếu pool chỉ có 20 VU -> 18 đang bận, chỉ còn 2 VU trống
               -> 6 slots cần 6 VU, chỉ có 2 -> 4 DROP!

Đây là cơ chế "VU pool exhaustion under bimodal latency".
Không cần W_avg lớn, chỉ cần một nhóm event giữ VU đủ lâu.
```

### RC3: VU pool exhaustion dưới bimodal latency — slot được schedule nhưng không có worker

**Mô tả**: Đây là cơ chế trung tâm dẫn đến FAIL. Hãy trace từng bước.

**Bước 1: Arrival scheduler hoạt động độc lập**

```text
Scheduler không quan tâm có bao nhiêu VU đang rảnh.
Nó chỉ làm 1 việc: mỗi 1/6 giây (~167ms), tạo 1 slot mới.

T=0.000s: slot #1
T=0.167s: slot #2
T=0.333s: slot #3
T=0.500s: slot #4
T=0.667s: slot #5
T=0.833s: slot #6
T=1.000s: slot #7  (hết giây 1: 6 slots)
...
T=45.000s: slot #270
```

**Bước 2: VU dispatcher cố gắng gán slot cho VU**

```text
Mỗi khi có slot mới:
  1. Dispatcher kiểm tra: có VU nào rảnh không?
  2. Nếu có -> gán slot cho VU đó -> VU chạy event
  3. Nếu không -> tăng dropped_iterations +1
     -> Slot này "rơi", không ai xử lý
```

**Bước 3: Trace thực tế tại T=10s (ước lượng từ dữ liệu Run 93)**

```text
preAllocatedVUs = 20 (luôn sẵn sàng)
maxVUs = 50 (có thể spawn thêm đến 50)

T=0s đến T=10s: scheduler đã tạo 60 slots
  Dashboard events (70% = 42 slots): mỗi event 5ms
    -> 42 VU bận 5ms, xong rất nhanh, trả VU về pool
  Async_job events (30% = 18 slots): mỗi event 144ms-8000ms
    -> 18 VU bị giữ lâu

Tại T=10.000s:
  - 10 async_job VẪN ĐANG CHẠY (chưa xong vì event duration dài)
  - 10 VU còn lại trong preAllocated pool (20-10=10)
  - Dispatcher thấy 10 VU rảnh -> cố spawn thêm đến maxVUs=50
  - Đã spawn thêm ~20 VU (tổng ~30 active)

T=10.000s đến T=10.167s: scheduler tạo thêm 1 slot
  - Nếu là dashboard (70%): cần 1 VU trong 5ms -> có thể OK
  - Nếu là async_job (30%): cần 1 VU trong 144ms+ -> VU bị giữ thêm

T=15.000s (tổng 90 slots):
  - ~27 async_job đã được schedule
  - ~20 async_job vẫn đang chạy (do duration dài + arrival chồng lấn)
  - Dashboard vẫn đến đều, nhưng ít VU rảnh hơn
  - maxVUs=50 đã đạt -> không spawn thêm được
  - Dispatcher bắt đầu drop slot vì tất cả 50 VU đang bận

T=20.000s đến T=45.000s:
  - Mỗi khi tất cả 50 VU đang xử lý async_job dài -> slot mới bị drop
  - Drop tập trung vào các thời điểm nhiều async_job overlap
  - Tổng drop: 22 iterations (Run 93)
```

**Bước 4: Công thức drop — vì sao 22?**

```text
Công thức ước lượng drop:
  N_drop ≈ max(0, N_sched - N_capacity)

Trong đó:
  N_sched = 270
  N_capacity = tổng số slot VU pool có thể xử lý trong 45s

  Với preAllocatedVUs=20, maxVUs=50:
    VU pool trung bình active = ?
    Thời gian trung bình 1 VU xử lý 1 event = W_avg ≈ ?

  Nhưng con số chính xác phụ thuộc vào distribution của event duration
  và thời điểm các async_job start/kết thúc.

  Với W_p95 thực tế = 7950ms:
    Nếu tất cả event đều có duration = p95 -> cần 6 × 7.95 = 47.7 VU
    maxVUs=50 chỉ vừa đủ, nhưng thực tế một số event còn dài hơn p95
    -> vượt 50 VU -> drop.

  Nếu 22 drop đến từ các thời điểm peak overlap:
    - Mỗi drop = 1 slot mất ≈ 1 iteration thiếu
    - 22 drop/270 slots = 8.1% drop rate
    - Đây là tín hiệu rõ: capacity thiếu ~8% ở peak
```

### RC4: checks=100% + http_req_failed=0% != PASS — dropped_iterations là tín hiệu contract

**Mô tả**: Đây là bài học QUAN TRỌNG NHẤT của case này. Trong open model, "tất cả HTTP request OK" không đồng nghĩa với "test pass".

**Run 93 output**:

```text
checks....................: 100.00% ✓ 309 / 309
http_req_failed..........: 0.00%   ✓ 0 / 309
http_req_duration........: avg=XXms p95=YYms
  █ KẾT LUẬN SAI: "Test pass! Tất cả request OK!"
dropped_iterations.......: 22      ✗ 22 > 0
  █ KẾT LUẬN ĐÚNG: "Test FAIL! 22 arrivals không được phục vụ!"
```

**Vì sao người mới dễ kết luận sai?**

```text
Thói quen từ closed model testing:
  - "Nếu không có HTTP 500, không có timeout -> test pass"
  - "Nếu checks 100% -> mọi thứ hoạt động đúng"
  - "dropped_iterations? Chưa bao giờ thấy metric này -> bỏ qua"

Trong open model, dropped_iterations KHÔNG phải là "HTTP error".
Nó là "slot được schedule nhưng không có VU để chạy".
Event chưa từng bắt đầu -> không có HTTP request nào được tạo.
Vì vậy http_req_failed=0% là đúng (không request nào fail).
Nhưng test vẫn FAIL vì contract là ARRIVALS, không phải RESPONSES.
```

**So sánh 2 loại "fail"**:

| Loại fail | Metric | Xảy ra khi | Nghĩa nghiệp vụ |
| --- | --- | --- | --- |
| HTTP fail | `http_req_failed` | Request gửi đi nhưng server trả lỗi | Server nhận request nhưng xử lý hỏng |
| Check fail | `checks` | Response không thỏa điều kiện | Server trả lời nhưng sai nội dung |
| **Drop iteration** | `dropped_iterations` | Slot được schedule nhưng không có VU | Server không bao giờ nhận được request |
| Event fail | `constant_arrival_events_failed` | Event bắt đầu nhưng kết thúc với ok=false | Logic trong event báo lỗi |

```text
Drop iteration là tệ nhất vì:
  - User gửi request -> không đến được server
  - Không có HTTP response nào để check
  - Không có log server nào để debug
  - User chỉ thấy timeout/connection refused

Trong production, đây là "request bị drop ở load balancer vì upstream full".
```

**Bài học**:

```text
Khi test với constant-arrival-rate:
  1. Luôn đọc dropped_iterations TRƯỚC KHI đọc checks/http_req_failed
  2. Nếu dropped > threshold -> FAIL, bất kể checks/http_req_failed thế nào
  3. Drop là tín hiệu CAPACITY, không phải tín hiệu CORRECTNESS
  4. Test open model = test capacity contract, không phải correctness contract
```

### RC5: Tăng VU pool giúp giảm drop nhưng không giải quyết triệt để nếu event duration không bounded

**Mô tả**: Run 96 tăng preAllocatedVUs từ 20 lên 60, maxVUs từ 50 lên 100. Kết quả: drop giảm từ 22 xuống 6 nhưng vẫn > 0. Vì sao?

**Run 93 (pre=20, max=50) vs Run 96 (pre=60, max=100)**:

| Metric | Run 93 | Run 96 | Thay đổi |
| --- | ---: | ---: | --- |
| Iterations | 249 | 265 | +16 (gần target hơn) |
| Dropped | 22 | 6 | -16 (cải thiện 73%) |
| HTTP reqs | 309 | 325 | +16 |
| p95 event duration | 7950.6ms | 12785ms | +61% (!) |
| Active VU max | 41 | ~60+ | + |
| Result | FAIL | FAIL | vẫn FAIL |

**Nghịch lý: tăng VU pool 3x nhưng p95 event duration tăng 61%**:

```text
Với pre=20, max=50:
  - Khi VU pool cạn -> slot bị drop -> không có event mới
  - Drop làm giảm áp lực lên backend -> backend xử lý nhanh hơn
  - p95 = 7950ms

Với pre=60, max=100:
  - Nhiều VU hơn -> ít drop hơn -> nhiều event được xử lý hơn
  - Backend chịu nhiều concurrent request hơn -> chậm hơn
  - p95 = 12785ms (tăng 61%)
  - Nhiều event hơn nhưng mỗi event lâu hơn -> tổng thời gian VU bận không giảm nhiều

Đây là hiệu ứng "self-limiting": khi bạn thêm VU, backend chịu thêm tải,
mỗi event lâu hơn, nên VU pool vẫn không đủ.
```

**Công thức mở rộng**:

```text
W = f(concurrency)
  = W_base + α × concurrency  (khi backend bão hòa)

Khi tăng maxVUs:
  - concurrency tăng (nhiều VU active hơn)
  - W tăng (backend chậm hơn vì nhiều concurrent request)
  - required_vus = λ × W cũng tăng
  - Có thể vẫn không đủ dù đã tăng maxVUs

Đây là vòng lặp: thêm VU -> backend chậm hơn -> cần thêm VU nữa -> ...
Chỉ dừng khi:
  - Backend không còn chậm thêm (đã đạt saturation)
  - Hoặc maxVUs đủ lớn để chịu được W_max
  - Hoặc optimize backend để giảm W_base
```

**Kết luận từ RC5**:

```text
Giải pháp đúng cho case này KHÔNG phải là "tăng maxVUs vô hạn".
Giải pháp đúng là:
  1. Giảm event duration (tối ưu async job, giảm READY_AFTER_MS)
  2. Hoặc tăng maxVUs ĐỦ LỚN để chịu W_p95 (có thể cần >100)
  3. Hoặc chấp nhận drop nếu drop nằm trong budget (MAX_DROPPED > 0)
```

## Identity model deep-dive

### User identity trong case 05

Case này dùng `userPool=250` — 250 user identity khác nhau. Khác với case 01 (per-vu-iterations) nơi user identity bound vào VU, ở đây identity được chọn theo iteration.

```js
// Từ common.js: userContext()
export function userContext(seed = 'arrival', up = 500) {
  const it = exec.scenario.iterationInTest;
  const p = Math.max(1, up);
  const un = (it % p) + 1;
  return {
    seed,
    vuId: exec.vu.idInTest,
    iter: it,
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `arrival-user-${un}`,
    requestKey: `${seed}-${it}-${exec.vu.idInTest}`,
    abVariant: it % 2 === 0 ? 'b' : 'a',
  };
}
```

**Cách identity hoạt động trong open model**:

| Thành phần | Công thức | Ví dụ | Ý nghĩa |
| --- | --- | --- | --- |
| `userId` | `arrival-user-${(it % 250) + 1}` | `arrival-user-1` đến `arrival-user-250` | User identity xoay vòng |
| `vuId` | `exec.vu.idInTest` | `15`, `23`, `41` | VU nào đang xử lý event |
| `iter` | `exec.scenario.iterationInTest` | `0`, `1`, ..., `269` | Số thứ tự iteration toàn cục |
| `requestKey` | `${seed}-${it}-${vuId}` | `1718900000-42-15` | Unique key cho tracing |
| `abVariant` | `it % 2 === 0 ? 'b' : 'a'` | `a`, `b` | A/B test variant |

**So sánh identity model giữa các executor**:

| Executor | Identity bound vào | User xoay vòng thế nào? | State qua iter? |
| --- | --- | --- | --- |
| **per-vu-iterations** | VU | VU=1 luôn là user-1 | CÓ (module-level state) |
| **constant-arrival-rate** | Iteration | `(iter % pool) + 1` | KHÔNG (VU khác nhau mỗi iter) |
| shared-iterations | Iteration (nhưng VU ngẫu nhiên) | Tương tự | KHÔNG |
| constant-vus | VU (nhưng reuse) | Phụ thuộc impl | CÓ (nếu cẩn thận) |

```text
Trong case 05, VU #15 có thể xử lý event cho user-1 (iter 0),
sau đó user-251 (iter 250), rồi user-101 (iter 100), v.v.

Điều này đúng với bản chất open model: VU là anonymous worker.
Identity không thuộc về VU, mà thuộc về arrival event.
```

### Async job ID tracking

Mỗi async_job event tạo 1 job ID duy nhất:

```js
const jobId = create.ok ? responseJson(create.response, 'data.job_id', '') : '';
// jobId được server sinh ra, unique cho mỗi POST
// Sau đó dùng jobId để GET status
const status = requestJson('GET', `${TARGET_URL}/api/sim/report/jobs/${jobId}?...`, ...);
```

Trace cho 1 async_job:

```text
Event #42:
  vuId=15, userId=arrival-user-43, iter=42
  POST /api/sim/report/jobs -> jobId="job-abc-042"
  wait(140ms)
  GET /api/sim/report/jobs/job-abc-042 -> status=completed
  finishEvent()

Event #43:
  vuId=8, userId=arrival-user-44, iter=43
  weightedPick -> dashboard (70%)
  GET /api/sim/report -> 200
  finishEvent()
```

## Phân tích open model — từng bước trace T0 đến T45

### Mô hình toán học

```text
λ (lambda) = arrival rate = 6 events/s
T = duration = 45s
N_sched = λ × T = 270 slots

W = event duration (biến ngẫu nhiên, bimodal)
W_dashboard ~ Uniform(1ms, 5ms)
W_async_job ~ 144ms danh nghĩa, thực tế đến 8000ms+ p95

VU pool: preAllocated=20, max=50
ρ (utilization) = λ × W_avg / active_vus
```

### Timeline trace

**Phase 1: T=0s đến T=5s — Khởi động**

```text
T=0.000s: Scheduler bắt đầu
T=0.000s: 20 preAllocatedVUs sẵn sàng
T=0.167s: Slot #1 -> VU #1 nhận, chạy event
          Nếu dashboard: xong trong 5ms -> VU #1 rảnh ở T=0.172s
          Nếu async_job: VU #1 bận đến ~T=0.311s (144ms)
T=0.333s: Slot #2 -> VU khác nhận
...

Đến T=5s: 30 slots đã schedule (= 5 × 6)
  Dashboard expected: 21 events (70%), tất cả đã xong
  Async expected: 9 events (30%), một số vẫn đang chạy
  VU active: ~9 (các async_job) + một vài dashboard đang chạy ≈ 10-15
  Drop: 0 (vẫn dư VU)
```

**Phase 2: T=5s đến T=15s — VU pool bắt đầu căng**

```text
T=5s đến T=15s: thêm 60 slots (= 10 × 6)
  Tổng đến T=15s: 90 slots

  Async_job events: 90 × 0.3 = 27 events
  Dashboard events: 90 × 0.7 = 63 events

  Async_job W thực tế có thể cao hơn 144ms vì backend bắt đầu có tải:
    - Nhiều concurrent POST /api/sim/report/jobs
    - DB queue, CPU usage tăng
    - W_async thực tế có thể 200ms-500ms

  VU active: 15-25 (async_job đang chạy + dashboard mới)
  preAllocatedVUs=20 đã dùng hết -> dispatcher bắt đầu spawn thêm VU
  maxVUs=50 -> còn room để spawn
  Drop: vẫn 0 (chưa đạt maxVUs, dispatcher spawn kịp)
```

**Phase 3: T=15s đến T=30s — Cao điểm, drop bắt đầu**

```text
T=15s đến T=30s: thêm 90 slots
  Tổng đến T=30s: 180 slots

  Async_job events: 180 × 0.3 = 54 events
  Nhiều async_job chạy đồng thời -> backend bão hòa
  W_async thực tế: 1000ms-8000ms (p95 tăng mạnh)

  VU active: 30-41 (tiến gần maxVUs=50)
  Một số thời điểm tất cả 50 VU đều bận -> slot mới không có VU -> DROP

  Cơ chế drop:
    T=20.500s: 50 VU đang bận (40 async_job + 10 dashboard)
    T=20.667s: Slot mới -> dispatcher kiểm tra: 0 VU rảnh
             -> đã đạt maxVUs=50, không spawn thêm được
             -> dropped_iterations++

  Drop lẻ tẻ, mỗi lần 1-2 slot, tổng đến T=30s: ~10-15 drop
```

**Phase 4: T=30s đến T=45s — Duy trì, drop tiếp tục**

```text
T=30s đến T=45s: thêm 90 slots
  Tổng: 270 slots

  Backend đã bão hòa, W_async tiếp tục cao
  VU active dao động 35-41 (max observed = 41)
  Drop tiếp tục ở các thời điểm overlap cao

  Tổng drop cuối: 22 (Run 93)

  Lưu ý: maxVUs=50 nhưng active VU max chỉ đạt 41.
  Vì sao không lên 50?
    - Khi đạt ~41 VU active, một số async_job kết thúc -> giải phóng VU
    - VU được giải phóng nhận slot mới ngay
    - Con số 41 là observed max, không phải "không thể lên 50"
    - Thực tế có thể có lúc đạt 45-48 VU nhưng không được sample
```

**Phase 5: T=45s — Kết thúc**

```text
T=45.000s: Scheduler dừng tạo slot mới
  Các VU đang chạy nốt event hiện tại
  gracefulStop cho phép event đang chạy hoàn thành
  Khi tất cả VU xong -> test kết thúc

  Kết quả cuối:
    iterations = 249 (thay vì 270)
    dropped_iterations = 22
    active_vus_max = 41
```

### So sánh với constant-vus — "silent degradation"

Nếu dùng constant-vus thay vì constant-arrival-rate cho cùng case:

```text
Config: vus=20, duration=45s

T=0s: 20 VU bắt đầu
  Mỗi VU chạy 1 event, xong mới bắt đầu event mới
  Dashboard event xong trong 5ms -> VU bắt đầu event mới ngay
  Async_job event mất 144ms+ -> VU bận lâu hơn

Throughput tại mỗi thời điểm:
  throughput(t) = active_vus / W_avg(t)
  Khi nhiều async_job: W_avg tăng -> throughput giảm
  Khi ít async_job: W_avg thấp -> throughput cao

Tổng iterations sau 45s:
  iterations = tổng throughput tích lũy
  ≈ 180-200 (ước lượng, phụ thuộc distribution của async_job)

Kết quả: iterations=~190
  KHÔNG CÓ DROP (vì không có khái niệm drop trong closed model)
  checks=100%, http_req_failed=0%
  -> Người đọc kết luận: "Test pass!"
  -> Nhưng throughput thực tế = 190/45 ≈ 4.2/s < 6/s target
  -> SILENT FAILURE
```

**Bảng so sánh output giữa 2 executor cho cùng backend**:

| Metric | constant-arrival-rate (Run 93) | constant-vus (giả định) |
| --- | ---: | ---: |
| Iterations | 249 | ~190 |
| Throughput trung bình | 5.53/s | ~4.2/s |
| dropped_iterations | **22** | N/A |
| Có phát hiện được thiếu capacity? | **CÓ (drop=22)** | KHÔNG |
| Kết luận | FAIL | FALSE PASS |

## Bảng service/API flow

### Branch map

| Branch | Weight | Flow | Số HTTP calls | Expected status | W điển hình |
| --- | ---: | --- | ---: | --- | ---: |
| `dashboard` | 70% | `GET /api/sim/report` | 1 | `200` | ~1-5ms |
| `async_job` | 30% | `POST /api/sim/report/jobs` → `wait(140ms)` → `GET /api/sim/report/jobs/:id` | 2 | `202`, `200` | ~144ms+ (danh nghĩa) |

### Chi tiết từng HTTP request

**Dashboard (GET /api/sim/report)**:

```http
GET /api/sim/report?cpu_ms=0&db_rows=1&gzip_kb=0 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: constant-arrival-rate
X-User-ID: arrival-user-42

Response 200 OK:
{
  "data": { ... }
}
```

Tag trên request:
```text
case_id: car-05-report-api-ingress
service: report-service
operation: report_arrival_dashboard
endpoint: GET /api/sim/report
user_id: arrival-user-42
```

**Async job — Create (POST /api/sim/report/jobs)**:

```http
POST /api/sim/report/jobs?cpu_ms=2&db_writes=1&external_ms=20&ready_after_ms=120 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: constant-arrival-rate
X-User-ID: arrival-user-43

{
  "report_type": "sales-hourly",
  "requested_by": "arrival-user-43"
}

Response 202 Accepted:
{
  "data": {
    "job_id": "job-abc-043",
    "status": "processing",
    "ready_after_ms": 120
  }
}
```

Tag trên request:
```text
case_id: car-05-report-api-ingress
service: report-service
operation: report_arrival_create_job
endpoint: POST /api/sim/report/jobs
user_id: arrival-user-43
```

**Async job — Status (GET /api/sim/report/jobs/:id)**:

```http
GET /api/sim/report/jobs/job-abc-043?cpu_ms=0&db_rows=0 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: constant-arrival-rate
X-User-ID: arrival-user-43

Response 200 OK:
{
  "data": {
    "job_id": "job-abc-043",
    "status": "completed"
  }
}
```

Tag trên request:
```text
case_id: car-05-report-api-ingress
service: report-service
operation: report_arrival_job_status
endpoint: GET /api/sim/report/jobs/:id
user_id: arrival-user-43
```

### Weighted API call calculation

```text
Với 270 scheduled slots, expected mix:
  Dashboard: 270 × 0.70 = 189 events × 1 HTTP call  = 189 calls
  Async_job: 270 × 0.30 = 81 events  × 2 HTTP calls = 162 calls
  Total expected API calls: 189 + 162 = 351 calls

Tỷ lệ calls/event = 351/270 = 1.3

Thực tế Run 93:
  Iterations = 249
  HTTP reqs = 309
  Tỷ lệ thực tế: 309/249 = 1.241 calls/event

  Vì sao thấp hơn 1.3?
  - Một số async_job không có job_id (create fail) -> chỉ 1 call
  - Drop tập trung vào async_job (cần 2 VU slots) hay dashboard?
    Thực tế drop có thể ảnh hưởng cả 2 branch.
  - 309 = 249 events × weighted avg calls/event
    Nếu 249 events: dashboard=~174, async=~75
    174×1 + 75×2 = 324 (nếu tất cả async_job OK)
    Nhưng 309 < 324 -> ~7-8 async_job không có đủ 2 calls
```

## Metrics & tags deep-dive

### Custom metrics từ common.js

| Metric | Type | Tag | Ý nghĩa |
| --- | --- | --- | --- |
| `constant_arrival_events_total` | Counter | `case_id`, `service`, `operation`, `user_id` | Tổng số arrival event đã bắt đầu |
| `constant_arrival_events_failed` | Counter | `case_id`, `service`, `operation`, `user_id` | Số event có `ok=false` khi finish |
| `constant_arrival_api_calls_total` | Counter | `case_id`, `service`, `operation`, `endpoint`, `user_id` | Tổng số HTTP API call |
| `constant_arrival_event_duration_ms` | Trend | `case_id`, `service`, `operation`, `user_id` | Event duration (ms), đo từ start đến finish |

### k6 built-in metrics trong case này

| Metric | Ý nghĩa | Tag quan trọng |
| --- | --- | --- |
| `iterations` | Số event đã hoàn thành (= N_done) | `executor_family`, `workload_shape` |
| `dropped_iterations` | Số slot bị drop (= N_drop) | `executor_family` |
| `http_reqs` | Tổng HTTP request | `case_id`, `service`, `operation`, `endpoint` |
| `http_req_duration` | HTTP request duration | `case_id`, `service`, `operation`, `endpoint` |
| `http_req_failed` | HTTP request fail rate | `case_id`, `service` |
| `checks` | Check pass rate | `case_id` |
| `vus` | Số VU active | — |
| `vus_max` | Số VU tối đa active | — |

### Cách reconcile counts

```text
Kiểm tra 1: iterations vs constant_arrival_events_total
  iterations = số event đã finish (k6 built-in)
  constant_arrival_events_total = số event đã finish (custom counter)
  → Phải gần bằng nhau (±1 do timing)

Kiểm tra 2: constant_arrival_api_calls_total vs http_reqs
  constant_arrival_api_calls_total = số API call (custom counter, increment trong requestJson)
  http_reqs = số HTTP request (k6 built-in)
  → Phải gần bằng nhau (mỗi API call = 1 HTTP request)

Kiểm tra 3: http_reqs vs iterations × 1.3
  http_reqs ≈ iterations × (0.7×1 + 0.3×2) = iterations × 1.3
  Sai số do: weightedPick dùng modulo -> phân phối gần đúng, không tuyệt đối

Kiểm tra 4: dropped_iterations vs (270 - iterations)
  N_sched = 270
  iterations = N_done
  dropped_iterations = N_drop
  N_sched = N_done + N_drop + N_int
  N_int = interrupted iterations ≈ 0 nếu gracefulStop đủ

  Vậy: dropped_iterations ≈ 270 - iterations
  Run 93: 22 ≈ 270 - 249 = 21 (lệch 1 do interrupted hoặc rounding)
```

### Drill-down theo operation tag

Để phân tích sâu, drill theo tag `operation`:

```text
Các operation trong case này:
  - report_arrival_dashboard      (dashboard branch, 1 GET)
  - report_arrival_create_job     (async branch, POST)
  - report_arrival_job_status     (async branch, GET)
  - report_dashboard_arrival      (finishEvent cho dashboard)
  - report_async_job_arrival      (finishEvent cho async_job)

Phân tích:
  - Nếu report_arrival_create_job nhiều fail -> job creation hỏng
  - Nếu report_arrival_job_status nhiều fail -> poll status hỏng
  - Nếu report_arrival_dashboard fail -> dashboard read hỏng
  - Nếu event fail (constant_arrival_events_failed > 0) -> drill operation
```

## Pass criteria

### Tiêu chí chính

| # | Check | Pass khi | Ưu tiên | Ghi chú |
| --- | --- | --- | --- | --- |
| 1 | `dropped_iterations` | `count <= 0` | **CAO NHẤT** | Contract breach nếu > 0 |
| 2 | `checks` | `rate > 0.99` | Cao | Tất cả HTTP response đúng |
| 3 | `http_req_failed` | `rate < 0.01` | Cao | Không lỗi HTTP |
| 4 | `constant_arrival_events_failed` | `count < 5` | Trung bình | Một vài event fail chấp nhận được |
| 5 | `iterations` | gần `270` | Tham chiếu | Nếu không drop, phải ~270 |

### Vì sao dropped_iterations là tiêu chí SỐ 1?

```text
Trong open model, contract là ARRIVAL RATE:
  "Tôi hứa tạo 6 arrivals/s trong 45s = 270 arrivals"

Nếu dropped_iterations > 0:
  - Một số arrival KHÔNG ĐƯỢC TẠO (không có VU để chạy)
  - Contract bị BREACH
  - Test phải FAIL, bất kể checks/http_req_failed thế nào

Nếu dropped_iterations = 0:
  - Tất cả 270 arrivals đã được tạo
  - Contract được thực hiện đúng
  - Sau đó mới xét chất lượng (checks, http_req_failed)

Thứ tự đọc output:
  1. dropped_iterations == 0?
     - YES -> tiếp tục bước 2
     - NO  -> FAIL, không cần đọc tiếp
  2. checks rate > 0.99?
  3. http_req_failed rate < 0.01?
  4. constant_arrival_events_failed count < 5?
```

### Tiêu chí tham chiếu (không phải pass/fail, dùng để hiểu)

| Check | Kỳ vọng | Dùng để |
| --- | --- | --- |
| `iterations` | `≈ 270` (nếu 0 drop) hoặc `= 270 - dropped` | Verify N_sched - N_drop khớp |
| `http_reqs` | `≈ iterations × 1.3` | Verify weighted branch mix |
| `constant_arrival_api_calls_total` | `≈ http_reqs` | Verify custom counter khớp built-in |
| `constant_arrival_events_total` | `≈ iterations` | Verify event counter khớp |
| `constant_arrival_event_duration_ms p95` | Càng thấp càng tốt | Hiểu VU pressure |
| `vus_max` | Phụ thuộc event duration | Hiểu VU sizing |

### Bảng pass/fail tổng hợp

| Tình huống | dropped | checks | http_failed | Kết luận | Hành động |
| --- | --- | --- | --- | --- | --- |
| Run 93 | 22 | 100% | 0% | **FAIL** | Tăng VU pool hoặc giảm async latency |
| Run 96 | 6 | 100% | 0% | **FAIL** | Vẫn chưa đủ, cần VU pool lớn hơn hoặc giảm READY_AFTER_MS |
| Lý tưởng | 0 | >99% | <1% | **PASS** | Report service đạt contract |
| Server lỗi thật | 0 | <99% | >0% | **FAIL** | Điều tra server error |
| Vừa drop vừa lỗi | >0 | <99% | >0% | **FAIL** | Cả capacity + correctness |

## Cách chạy

### Local run với dashboard

```powershell
# 1. Set biến môi trường
$env:BASE_URL = "http://localhost:8088"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# 2. Chạy với cloud output (xem dashboard)
cd "E:\Khoa hoc\k6"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"

# 3. Mở dashboard
# http://localhost:13001/
# Paste token: student-token-1234567890
# Chọn run mới nhất
```

### Override env vars

Tất cả tham số đều có thể override qua biến môi trường:

```powershell
# Cấu hình mặc định
$env:CAR_05_RATE = "6"
$env:CAR_05_TIME_UNIT = "1s"
$env:CAR_05_DURATION = "45s"
$env:CAR_05_PREALLOCATED_VUS = "20"
$env:CAR_05_MAX_VUS = "50"
$env:CAR_05_USER_POOL = "250"
$env:CAR_05_READY_AFTER_MS = "120"
$env:CAR_05_MAX_DROPPED = "0"
$env:CAR_05_BASE_URL = "http://localhost:8088"

# Override đơn lẻ — thử nghiệm READY_AFTER_MS thấp hơn
$env:CAR_05_READY_AFTER_MS = "5"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_READY_AFTER_MS -ErrorAction SilentlyContinue

# Override VU pool lớn hơn
$env:CAR_05_PREALLOCATED_VUS = "60"
$env:CAR_05_MAX_VUS = "100"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_PREALLOCATED_VUS -ErrorAction SilentlyContinue
Remove-Item Env:CAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

### Chạy local không dashboard

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
```

## Phân tích output 5 bước

### Bước 1: Header/config

Đọc header để verify config:

```text
executor: constant-arrival-rate
scenario: report_api_ingress
rate: 6
timeUnit: 1s
duration: 45s
preAllocatedVUs: 20
maxVUs: 50
```

**Run 93**: config đúng như trên.
**Run 96**: preAllocatedVUs=60, maxVUs=100, các tham số khác giữ nguyên.

### Bước 2: Tính expected slots

```text
N_sched = rate × duration
        = 6 × 45
        = 270 slots

Expected http_reqs = N_sched × 1.3 = 351 (weighted)
Expected iterations = N_sched = 270 (nếu không drop)
```

### Bước 3: Đọc summary counts — so sánh 2 run

**Run 93 (default config)**:

```text
iterations........................: 249
dropped_iterations................: 22
http_reqs.........................: 309
checks............................: 100.00% (309/309)
http_req_failed...................: 0.00% (0/309)
constant_arrival_events_total.....: 249
constant_arrival_events_failed....: 0
constant_arrival_api_calls_total..: 309
constant_arrival_event_duration_ms: p95=7950.6ms
vus_max............................: 41

Phân tích:
  N_done = 249
  N_drop = 22
  N_sched = 270
  N_int (interrupted) = 270 - 249 - 22 = -1??? -> làm tròn/metric timing
  Thực tế: 249 + 22 ≈ 271 (lệch 1 do counter timing)

  http_reqs = 309
  309 / 249 = 1.241 calls/event (gần 1.3, lệch do async_job mix thực tế)

  p95 event duration = 7950.6ms (~8 giây!)
  VU active max = 41 (gần maxVUs=50)

KẾT LUẬN: FAIL — dropped_iterations=22 > 0
```

**Run 96 (tăng VU pool: pre=60, max=100)**:

```text
iterations........................: 265
dropped_iterations................: 6
http_reqs.........................: 325
checks............................: 100.00%
http_req_failed...................: 0.00%
constant_arrival_event_duration_ms: p95=12785ms
vus_max............................: >60

Phân tích:
  N_done = 265 (cải thiện 16 iteration so với Run 93)
  N_drop = 6 (giảm 16 drop, còn 27% so với Run 93)
  265 + 6 = 271 (gần 270, lệch 1)

  http_reqs = 325
  325 / 265 = 1.226 calls/event

  p95 event duration = 12785ms (~12.8 giây!) — TĂNG 61% so với Run 93!
  VU active max > 60

KẾT LUẬN: VẪN FAIL — dropped_iterations=6 > 0
           Dù cải thiện 73% drop nhưng p95 tăng mạnh do backend chịu thêm tải
```

### Bước 4: Branch reconciliation

```text
Run 93: 249 iterations, 309 http_reqs
  Nếu gọi x = số dashboard events, y = số async_job events:
    x + y = 249
    x×1 + y×2 = 309
  => y = 309 - 249 = 60 async_job events
     x = 249 - 60 = 189 dashboard events

  Tỷ lệ async_job = 60/249 = 24.1% (thấp hơn 30% expected)
  -> Có thể async_job bị drop nhiều hơn dashboard
  -> Hoặc weightedPick phân phối khác 30% trong 249 iterations

Run 96: 265 iterations, 325 http_reqs
  x + y = 265
  x×1 + y×2 = 325
  => y = 60, x = 205

  Tỷ lệ async_job = 60/265 = 22.6% (càng thấp hơn 30%)
  -> Thêm VU giúp dashboard events tăng (189->205) nhưng async_job vẫn ~60
  -> Async_job bị "kẹt" — dù thêm VU, async_job vẫn chiếm VU lâu,
     làm giảm số async_job mới được schedule
```

### Bước 5: Business conclusion

| Output | Kết luận nghiệp vụ | Hành động |
| --- | --- | --- |
| Run 93: 249 iter, 22 drop, p95=7950ms | Report service KHÔNG chịu được 6/s với async job 120ms ready | FAIL — cần tối ưu hoặc scale |
| Run 96: 265 iter, 6 drop, p95=12785ms | Tăng VU pool giúp giảm drop nhưng backend bão hòa nặng hơn | FAIL — cần optimize backend trước khi thêm VU |
| Lý tưởng: 270 iter, 0 drop, p95 thấp | Report service chịu được 6/s | PASS — sẵn sàng production |
| 0 drop nhưng VUs tăng cao | Async wait ăn headroom nhưng contract vẫn đạt | PASS — cần monitor VU usage trong production |
| job-status fail | Async workflow hỏng | FAIL — điều tra job processing pipeline |

## Dashboard 3-chart deep analysis

### Chart 1 — Response time

Chart này cho thấy response time của HTTP requests (KHÔNG phải event duration). Cần drill theo operation tag để thấy sự khác biệt lớn giữa các loại request.

**Các operation trên chart**:

```text
report_arrival_dashboard       — GET /api/sim/report (~1-5ms)
report_arrival_create_job      — POST /api/sim/report/jobs (~2-10ms)
report_arrival_job_status      — GET /api/sim/report/jobs/:id (~2-5ms)
```

**Kỳ vọng shape**:

```text
- report_arrival_dashboard:       avg ~1-5ms, p95 ~5-10ms (nhanh nhất)
- report_arrival_create_job:      avg ~2-10ms, p95 ~10-50ms
- report_arrival_job_status:      avg ~2-5ms, p95 ~5-10ms

Tất cả HTTP request đều nhanh vì backend sim chỉ sleep để mô phỏng.
KHÔNG CÓ HTTP request nào mất >100ms.

→ Đây là điểm mấu chốt: http_req_duration p95 CÓ THỂ <50ms
  nhưng event_duration p95 = 7950ms!
```

**Đừng nhầm http_req_duration với event_duration**:

```text
http_req_duration:       thời gian 1 HTTP request hoàn thành (2-50ms)
event_duration:          thời gian từ start đến finish của cả event (144ms-8000ms)

Sự khác biệt đến từ:
  - wait(140ms) giữa create job và get status
  - Thời gian backend thực sự xử lý job (ready_after_ms)
  - Thời gian VU chờ đợi trong hàng đợi nội bộ

→ Nếu chỉ nhìn http_req_duration: "Mọi thứ rất nhanh, sao lại drop?"
→ Phải nhìn event_duration để hiểu VU bị giữ bao lâu.
```

**Bảng so sánh http_req_duration vs event_duration**:

| Metric | Dashboard | Async job (danh nghĩa) | Async job (Run 93 thực tế) |
| --- | ---: | ---: | ---: |
| HTTP request duration (avg) | ~2ms | ~2ms/create + ~2ms/status | ~5ms |
| HTTP request duration (p95) | ~5ms | ~10ms | ~50ms |
| Event duration (avg) | ~3ms | ~144ms | ~2000ms+ |
| Event duration (p95) | ~8ms | ~200ms | **7950ms** |
| Tỷ lệ event/HTTP | ~1.5x | ~72x | **~160x-4000x** |

**Cách đọc chart Response time cho case này**:

```text
1. Drill theo operation tag để tách 3 loại request
2. Tất cả HTTP request nên nhanh (<100ms)
3. Nếu HTTP request nào chậm (>500ms) -> backend có vấn đề thật
4. Không dùng chart này để đánh giá VU pressure — dùng event_duration

Câu hỏi chart này trả lời:
  "HTTP request có nhanh không?"
  "Có request nào bị timeout/server error không?"

Câu hỏi chart này KHÔNG trả lời:
  "VU bị giữ bao lâu?"
  "Vì sao bị drop?"
```

### Chart 2 — Execution timeline

Chart này cho thấy Live VUs, RPS, và iterations hoàn thành theo thời gian.

**Kỳ vọng cho case 05 (pass)**:

```text
- Live VUs: bắt đầu ở 20 (preAllocated), tăng dần khi cần thêm async_job,
  nhưng không vượt maxVUs=50
- RPS (http_reqs/s): ~7.8/s trung bình (6 events/s × 1.3 calls/event)
- Iterations/s: ~6/s (bám sát arrival rate)

Nếu pass (0 drop):
  - Tổng iterations = 270
  - Iterations/s gần 6/s trong suốt 45s
  - Live VUs dao động nhưng không bao giờ chạm maxVUs mà vẫn thiếu
```

**Shape thực tế Run 93 (FAIL)**:

```text
- Live VUs: tăng nhanh từ 20 lên 35-41, chạm trần ~41
  (không lên 50 vì drop xảy ra trước khi cần 50)
- RPS: dao động, có thể thấp hơn 7.8/s khi nhiều drop
- Iterations/s: có thể tụt dưới 6/s ở các đoạn nhiều drop

- Tổng iterations = 249 (thiếu 21)
- Tổng http_reqs = 309

Dấu hiệu trên chart:
  - Live VUs phẳng ở mức cao (35-41) trong phần lớn thời gian
  - Iterations/s thấp hơn 6/s ở một số bucket -> đó là lúc drop xảy ra
  - RPS không ổn định, có bucket thấp bất thường
```

**Shape thực tế Run 96 (cải thiện nhưng vẫn FAIL)**:

```text
- Live VUs: tăng từ 60 lên >60, active cao hơn Run 93
- RPS: cao hơn Run 93 (nhiều event được xử lý hơn)
- Iterations/s: gần 6/s hơn, nhưng vẫn có bucket tụt
- Tổng iterations = 265 (thiếu 5)
- Drop còn 6 -> chart gần đẹp hơn nhưng vẫn chưa đạt

Dấu hiệu trên chart:
  - Live VUs cao nhưng iterations/s vẫn có lúc < 6/s
  - p95 event duration tăng -> mỗi event lâu hơn
  - Vòng lặp: thêm VU -> backend chậm -> event lâu -> vẫn drop
```

**Các shape bất thường cần chú ý**:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| Live VUs phẳng ở maxVUs, iterations/s < rate | VU pool cạn, đang drop | Tăng maxVUs hoặc giảm event duration |
| Live VUs thấp hơn preAllocatedVUs | VU init lỗi hoặc config sai | Kiểm tra preAllocatedVUs, VU startup |
| RPS biến động mạnh, không ổn định | Async/sync mix không đều, backend không ổn định | Drill theo operation tag |
| Iterations/s tụt về 0 giữa test | Backend crash hoặc network mất | Kiểm tra server log |
| Tổng iterations < N_sched - N_drop | Có interrupted iterations | Kiểm tra maxDuration, gracefulStop |

### Chart 3 — VUs vs iter/s

Đây là chart quan trọng nhất cho case 05.

**Mục đích**: Cho thấy mối quan hệ giữa VU pool size và iteration throughput. Khi VU tăng mà iter/s không tăng tương ứng -> dấu hiệu VU bị kẹt trong event dài.

**Kỳ vọng cho case pass**:

```text
- Executor VUs: theo envelope của constant-arrival-rate
- Actual iter/s: gần 6/s, ổn định
- Không có đoạn dài Actual iter/s tụt dưới 6/s

Nếu pass (0 drop):
  - Actual iter/s dao động quanh 6/s
  - Executor VUs đủ để duy trì iter/s
  - Không có "gap" giữa Executor VUs và Observed VUs
```

**Run 93 trên chart này**:

```text
- Executor VUs: envelope constant-arrival-rate
- Observed VUs: tăng dần 20 -> 35 -> 41
- Actual iter/s: dao động, có đoạn < 6/s
- Gap: Observed VUs cao nhưng Actual iter/s không tăng tương ứng

Đọc:
  "Dù có 35-41 VU active, throughput vẫn không đạt 6/s ổn định.
   VU đang bị kẹt trong async_job event dài.
   Cần nhiều VU hơn hoặc event ngắn hơn."
```

**Run 96 trên chart này**:

```text
- Observed VUs: cao hơn (>60)
- Actual iter/s: ổn định hơn Run 93, nhưng vẫn có đoạn < 6/s
- p95 event duration tăng lên 12785ms

Đọc:
  "Thêm VU giúp iter/s ổn định hơn, nhưng backend bão hòa nặng hơn.
   p95 event duration tăng 61% vì nhiều concurrent request hơn.
   Vẫn còn 6 drop -> vẫn chưa đủ VU cho W_p95 mới."
```

**Công thức trên chart này**:

```text
Mối quan hệ:
  Actual iter/s ≈ Observed VUs / W_avg

Khi thêm VU:
  - Observed VUs tăng
  - Nhưng W_avg cũng tăng (backend bão hòa)
  - Actual iter/s có thể không tăng tỷ lệ với VUs

Điểm "diminishing returns":
  Thêm VU từ 20 lên 60 (tăng 200%)
  Nhưng iterations chỉ tăng từ 249 lên 265 (tăng 6.4%)
  -> Hiệu quả biên rất thấp
  -> Vấn đề gốc là backend capacity, không phải VU pool size
```

### Executor tab

Tab Executor cho case này phải detect:

```text
EXECUTOR = constant-arrival-rate
```

Checklist cho tab Executor:

```text
1. Executor detect đúng "constant-arrival-rate" không?
2. rate/timeUnit/duration khớp config (6/1s/45s)?
3. preAllocatedVUs=20, maxVUs=50 (hoặc giá trị override)?
4. dropped_iterations khớp summary?
5. Observed VUs có xu hướng tăng khi cần, không vượt maxVUs?
6. Actual iter/s có bám sát rate target không?
```

**Điểm đặc biệt của constant-arrival-rate trên Executor tab**:

```text
Khác với per-vu-iterations:
  - Không có "Fixed VUs" cố định
  - VUs = variable pool: preAllocatedVUs <= active <= maxVUs
  - Executor tự động spawn thêm VU khi cần (đến maxVUs)
  - Executor tự động giảm VU khi ít việc (xuống preAllocatedVUs)

Khác với constant-vus:
  - Mục tiêu là RATE, không phải VU count
  - VUs là phương tiện, không phải mục tiêu
  - Nếu event nhanh -> ít VU vẫn đạt rate
  - Nếu event chậm -> nhiều VU vẫn có thể drop
```

## 4 output -> decision scenarios

### Scenario A: Hypothetical perfect pass (270 iter, 0 drop)

```text
Điều kiện giả định: READY_AFTER_MS = 5ms, backend khỏe

iterations........................: 270
dropped_iterations................: 0
http_reqs.........................: ~351
checks............................: 100.00%
http_req_failed...................: 0.00%
constant_arrival_events_failed....: 0
constant_arrival_event_duration_ms: p95=50ms

Kết luận:
  - Tất cả 270 arrivals được phục vụ -> contract đạt
  - Event duration p95=50ms, thấp -> VU pool dư sức
  - preAllocatedVUs=20 thừa nhiều, có thể giảm xuống 5-10

Hành động:
  - Report service sẵn sàng cho 6/s ingress
  - Có thể tăng rate lên để tìm capacity limit thật
  - Document: "Với READY_AFTER_MS=5, report service chịu được 6/s"
```

**Config nào đạt được scenario này?**

```powershell
$env:CAR_05_READY_AFTER_MS = "5"
$env:CAR_05_PREALLOCATED_VUS = "10"
$env:CAR_05_MAX_VUS = "30"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
```

Với READY_AFTER_MS=5:
```text
W_async ≈ 2ms (create) + (5+20)/1000 wait + 2ms (status) = 29ms
W_avg ≈ 0.7×3ms + 0.3×29ms = 2.1 + 8.7 = 10.8ms
required_vus ≈ 6 × 0.011 = 0.066 -> 1 VU là đủ!

Nhưng thực tế backend có thể chậm hơn khi có tải thật,
nên preAllocatedVUs=10 là an toàn.
```

### Scenario B: Run 93 reality (249 iter, 22 dropped, p95=7950ms)

```text
iterations........................: 249
dropped_iterations................: 22
http_reqs.........................: 309
checks............................: 100.00%
http_req_failed...................: 0.00%
constant_arrival_event_duration_ms: p95=7950.6ms
vus_max............................: 41

Kết luận:
  - FAIL rõ ràng: 22 arrivals không được phục vụ
  - Tất cả HTTP request OK (checks 100%, fail 0%)
  - Nhưng contract bị breach vì drop > 0
  - Đây là case dạy: checks và http_req_failed KHÔNG đủ để pass

Điều tra:
  - p95 event duration = 7950ms -> rất cao
  - Tại sao event duration cao như vậy?
    + Backend xử lý thật mất thời gian (ready_after_ms=120 + processing)
    + Có thể backend bị quá tải khi nhiều concurrent request
    + wait(140ms) giữ VU, nhưng 140ms không giải thích được 7950ms
    + 7950ms là p95 của EVENT DURATION, bao gồm cả thời gian chờ VU?
      KHÔNG — event duration tính từ start đến finish trong cùng VU.
      Vậy 7950ms đến từ đâu?
      -> Backend thực sự mất 7-8 giây để xử lý job khi có nhiều concurrent!
      -> ready_after_ms=120 là "mô phỏng", nhưng backend thật có thể chậm hơn
         khi chịu tải cao (DB lock, queue đầy, CPU bão hòa)
      -> Đây là "emergent behavior" — behavior chỉ xuất hiện khi có load!

Hành động:
  - KHÔNG release report service với config hiện tại
  - Cần điều tra backend performance ở 6 concurrent async jobs
  - Hoặc tăng maxVUs đủ lớn để chịu W_p95=7950ms
    required_vus ≥ 6 × 7.95 = 47.7 -> maxVUs ≥ 60-70 mới an toàn
  - Hoặc optimize backend để giảm processing time
```

### Scenario C: Run 96 with bigger pool (265 iter, 6 dropped, p95=12785ms)

```text
iterations........................: 265
dropped_iterations................: 6
http_reqs.........................: 325
checks............................: 100.00%
http_req_failed...................: 0.00%
constant_arrival_event_duration_ms: p95=12785ms
vus_max............................: >60

Kết luận:
  - VẪN FAIL: 6 arrivals không được phục vụ
  - Cải thiện: drop giảm 73% (22 -> 6), iterations tăng 6.4% (249 -> 265)
  - Nhưng p95 tăng 61% (7950 -> 12785ms) — tác dụng phụ không mong muốn
  - Backend bão hòa nặng hơn vì nhiều concurrent request hơn

Phân tích:
  - Thêm VU giúp giảm drop vì có thêm worker
  - Nhưng thêm VU cũng tăng load lên backend -> backend chậm hơn
  - Backend chậm hơn -> event duration tăng -> cần thêm VU nữa
  - Đây là vòng lặp "diminishing returns"

  Để đạt 0 drop với W_p95=12785ms:
    required_vus ≥ 6 × 12.785 = 76.7 VU
    -> maxVUs cần ≥ 80-100

  Nhưng nếu tăng maxVUs lên 100:
    - Backend có thể còn chậm hơn nữa (W_p95 có thể lên 20s+)
    - Vòng lặp tiếp tục
    - Có thể không bao giờ đạt 0 drop nếu backend không được optimize

Hành động:
  - Giải pháp đúng: optimize backend (giảm processing time, thêm DB index, tăng connection pool)
  - Giải pháp tạm: tăng maxVUs lên 150-200 và chấp nhận p95 cao
  - Hoặc: chấp nhận drop nếu drop nằm trong SLO budget
    (vd: set CAR_05_MAX_DROPPED=10, coi 6 drop là pass)
```

### Scenario D: What-if — READY_AFTER_MS = 5ms

```text
Giả định: set CAR_05_READY_AFTER_MS=5

W_async danh nghĩa = 2ms (POST) + 25ms wait + 2ms (GET) = 29ms
W_avg = 0.7×3ms + 0.3×29ms = 10.8ms
required_vus = 6 × 0.011 = 0.066 -> 1 VU

Với preAllocatedVUs=10, maxVUs=30:
  - Dư sức rất nhiều
  - 0 drop
  - p95 event duration ~50ms

Kết luận: Dễ dàng pass nếu async job nhanh.
Điều này chứng minh: gốc rễ vấn đề là ASYNC LATENCY, không phải VU pool size.
```

## "Nghịch lý" (4)

### Nghịch lý 1: "checks=100%, http_req_failed=0% nhưng test FAIL"

```text
Đây là nghịch lý TRUNG TÂM của case này và của toàn bộ open model testing.

Người mới nhìn output Run 93:
  checks = 100% ✓
  http_req_failed = 0% ✓
  -> "Test pass! Mọi thứ hoạt động tốt!"

Nhưng:
  dropped_iterations = 22 ✗
  -> 22 arrivals không bao giờ được bắt đầu
  -> 22 user không nhận được phản hồi
  -> Contract "6 arrivals/s" bị breach

Giải thích:
  checks và http_req_failed chỉ đo CHẤT LƯỢNG của những request ĐÃ ĐƯỢC GỬI.
  Chúng không đo SỐ LƯỢNG request được gửi so với target.

  Tương tự như:
    "Tất cả email đã gửi đều không bị lỗi" (checks=100%)
    nhưng "Chỉ gửi được 249/270 email" (drop=22)
    -> 21 email bị thất lạc trước khi gửi

  Đây là lý do dropped_iterations phải là tiêu chí SỐ 1.
  Trong open model, capacity contract quan trọng hơn correctness contract.
```

**Bài học**:

```text
Khi dùng constant-arrival-rate, đọc output theo thứ tự:
  1. dropped_iterations == 0?  ← CAPACITY
  2. checks rate > threshold?  ← CORRECTNESS
  3. http_req_failed rate < threshold?  ← RELIABILITY

Đừng bao giờ bỏ qua dropped_iterations chỉ vì checks=100%.
```

### Nghịch lý 2: "Tăng VU pool từ 20->60, max 50->100 mà vẫn drop"

```text
Trực giác: "Thêm worker -> xử lý được nhiều việc hơn -> hết drop"

Nhưng thực tế Run 96:
  preAllocatedVUs: 20 -> 60 (tăng 200%)
  maxVUs: 50 -> 100 (tăng 100%)
  drop: 22 -> 6 (giảm 73%, nhưng vẫn > 0!)

Vì sao?
  1. Thêm VU -> thêm concurrent request đến backend
  2. Backend chịu thêm tải -> xử lý chậm hơn
  3. p95 event duration: 7950ms -> 12785ms (tăng 61%)
  4. required_vus = λ × W_p95 cũng tăng theo
  5. Vòng lặp: thêm VU -> backend chậm -> cần thêm VU nữa

Điểm dừng:
  - Khi backend đạt saturation (không thể chậm hơn)
  - Hoặc khi maxVUs đủ lớn để chịu W_max

  Với case này, maxVUs=100 vẫn chưa đủ để chịu W_p95=12785ms
  (cần ít nhất 6 × 12.785 = 76.7, nhưng thực tế vẫn drop 6)

Nguyên nhân gốc: BACKEND CAPACITY, không phải VU POOL SIZE.
Thêm VU chỉ là giải pháp tạm thời.
Giải pháp thật: optimize backend hoặc scale backend horizontally.
```

**Minh họa vòng lặp diminishing returns**:

```text
Iteration 1 (pre=20, max=50):
  Load lên backend: 30-41 concurrent requests
  Backend W_p95 = 7950ms
  Drop = 22

Iteration 2 (pre=60, max=100):
  Load lên backend: 50-70 concurrent requests (tăng ~70%)
  Backend W_p95 = 12785ms (tăng 61%)
  Drop = 6 (giảm 73%)

Iteration 3 (giả định pre=100, max=200):
  Load lên backend: 70-100 concurrent requests
  Backend W_p95 = ? (có thể 18000ms+)
  Drop = ? (có thể 1-2, hoặc vẫn > 0)

→ Hiệu quả biên của việc thêm VU giảm dần.
→ Cần giải pháp khác: tối ưu backend.
```

### Nghịch lý 3: "p95 event duration = 7950ms nhưng http_req_duration avg thấp"

```text
Người mới đọc output:
  http_req_duration avg = XXms (thấp)
  -> "Request nhanh mà, sao lại drop?"

Nhưng:
  constant_arrival_event_duration_ms p95 = 7950ms
  -> "Event kéo dài gần 8 giây!"

Sự khác biệt:
  http_req_duration = thời gian 1 HTTP request/response round-trip
                    ≈ 2-50ms cho case này

  event_duration = thời gian từ start đến finish của cả event
                 = http_req_duration + wait_time + processing
                 ≈ 2ms + 140ms + ~7800ms (backend processing thực tế)
                 = 7950ms

  wait_time chiếm phần lớn thời gian VU bận.
  Nhưng wait_time không xuất hiện trong http_req_duration.

Công thức:
  event_duration >> http_req_duration
  vì event_duration bao gồm cả THINK TIME / WAIT TIME giữa các request.

  Trong case này:
    http_req_duration p95 ≈ 50ms (ước tính)
    event_duration p95 = 7950ms
    Tỷ lệ: 7950/50 = 159x

  Nghĩa là: VU bận lâu hơn 159 lần so với thời gian HTTP request!
  Nguyên nhân: backend xử lý job thật sự mất thời gian.
```

**Vì sao http_req_duration vẫn thấp dù backend chậm?**

```text
Backend mô phỏng (k6-metrics-server) xử lý request theo cơ chế:
  - Nhận HTTP request -> trả response NGAY (2-5ms)
  - Xử lý "backend job" trong background (thread pool, queue)
  - Khi poll GET status, backend kiểm tra job đã xong chưa

Vậy http_req_duration thấp vì server trả response nhanh.
Nhưng "job processing" trong backend vẫn đang chạy.
Khi nhiều job cùng chạy -> queue đầy -> job lâu hoàn thành.
Đến khi poll status, job vẫn "processing" -> có thể phải retry.

Tuy nhiên trong code case này, wait time được hardcode là 140ms,
và chỉ poll 1 lần. Nếu sau 140ms job chưa xong, GET status có thể
trả "processing" thay vì "completed" — nhưng code không retry.
Đây là một điểm cần lưu ý khi thiết kế test thực tế.
```

### Nghịch lý 4: "rate=6/s thấp nhưng cần preAllocatedVUs=20+"

```text
Trực giác: "6 requests/s là rất thấp. Tại sao cần đến 20 VU pre-allocated?
          1 VU xử lý 6 requests/s nếu mỗi request chỉ mất ~10ms."

Tính toán đơn giản:
  Nếu tất cả event đều là dashboard (W=3ms):
    required_vus = 6 × 0.003 = 0.018 -> 1 VU là đủ!
    Tại sao config preAllocatedVUs=20?

Câu trả lời: VÌ BIMODAL DISTRIBUTION + TAIL LATENCY.

  Với 30% async_job, W_async có thể lên đến 8000ms:
    W_avg = 0.7×3ms + 0.3×8000ms = 2.1 + 2400 = 2402ms
    required_vus ≈ 6 × 2.402 = 14.4 VU

  Với p95 = 7950ms:
    required_vus_peak ≈ 6 × 7.95 = 47.7 VU

  Vậy preAllocatedVUs=20 là ĐỦ cho W_avg, nhưng maxVUs=50 là CẦN cho W_p95.

Bài học:
  - VU sizing cho open model với bimodal latency KHÔNG dùng W_avg.
  - Phải dùng W_p95 hoặc W_p99.
  - Một số ít event chậm có thể "ăn" toàn bộ VU pool.
  - preAllocatedVUs nên đủ cho steady state.
  - maxVUs nên đủ cho peak (khi nhiều async_job overlap).

Công thức sizing:
  preAllocatedVUs ≥ λ × W_avg (cho steady state)
  maxVUs ≥ λ × W_p95 (cho peak, để tránh drop)
  Hoặc an toàn hơn: maxVUs ≥ λ × W_p99
```

## Checklist

### Checklist chung cho case 05

```text
1. Kiểm tra config
   - rate = 6
   - timeUnit = 1s
   - duration = 45s
   - preAllocatedVUs = 20 (hoặc giá trị override)
   - maxVUs = 50 (hoặc giá trị override)

2. Tính expected
   - N_sched = 6 × 45 = 270
   - Expected http_reqs ≈ 270 × 1.3 = 351
   - Expected iterations = 270 (nếu 0 drop)

3. Đọc output — THEO THỨ TỰ NÀY
   - dropped_iterations == 0? -> ĐÂY LÀ SỐ 1
   - iterations ≈ 270?
   - http_reqs ≈ 351?
   - checks rate > 0.99?
   - http_req_failed rate < 0.01?
   - constant_arrival_events_failed count < 5?

4. Đọc event duration
   - constant_arrival_event_duration_ms p95
   - So sánh với http_req_duration p95
   - Nếu event_duration >> http_req_duration -> async wait chiếm thời gian

5. Đọc dashboard
   - Response time: HTTP request nhanh không? Drill theo operation.
   - Execution timeline: iter/s có ổn định 6/s không? Live VUs thế nào?
   - VUs vs iter/s: Observed VUs có bám Executor VUs không? Gap?
   - Executor tab: detect đúng constant-arrival-rate?

6. Kết luận
   - Drop > 0 -> FAIL (capacity)
   - Drop = 0, checks OK -> PASS
   - Drop = 0, checks fail -> FAIL (correctness)
```

### Checklist đặc thù cho async/bimodal latency

```text
7. Kiểm tra async branch
   - constant_arrival_api_calls_total có ≈ http_reqs không?
   - Số lượng operation "report_arrival_create_job" có ≈ 30% iterations không?
   - Số lượng operation "report_arrival_job_status" có ≈ số create_job không?
   - Nếu job_status < create_job -> một số job không được poll (job_id rỗng?)

8. Kiểm tra bimodal impact
   - event_duration p95 / http_req_duration p95 > 10? -> bimodal đang ảnh hưởng
   - vus_max có gần maxVUs không? -> VU pool đang căng
   - Nếu vus_max = maxVUs và vẫn drop -> cần thêm maxVUs hoặc giảm event duration

9. Kiểm tra weighted branch mix
   - Tính ratio: http_reqs / iterations
   - Kỳ vọng: ~1.3 (70%×1 + 30%×2)
   - Nếu < 1.2: async_job ít hơn 30% (weightedPick phân phối khác, hoặc drop tập trung async)
   - Nếu > 1.4: async_job nhiều hơn 30% (weightedPick phân phối khác)
```

## Mở rộng / variations

### Variation 1: Smoke test với rate thấp

```powershell
$env:CAR_05_RATE = "2"
$env:CAR_05_DURATION = "30s"
$env:CAR_05_PREALLOCATED_VUS = "5"
$env:CAR_05_MAX_VUS = "15"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_RATE, Env:CAR_05_DURATION, Env:CAR_05_PREALLOCATED_VUS, Env:CAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Expected: 2 × 30 = 60 slots
Với rate=2/s, VU pressure thấp hơn nhiều -> dễ pass
Dùng để verify setup trước khi chạy rate cao.
```

### Variation 2: READY_AFTER_MS = 5ms (fast async) — dễ pass

```powershell
$env:CAR_05_READY_AFTER_MS = "5"
$env:CAR_05_PREALLOCATED_VUS = "10"
$env:CAR_05_MAX_VUS = "30"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_READY_AFTER_MS, Env:CAR_05_PREALLOCATED_VUS, Env:CAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

```text
W_async ≈ 29ms -> W_avg ≈ 10.8ms
required_vus ≈ 0.07 -> 10 VU dư rất nhiều
Kỳ vọng: 270 iter, 0 drop, p95 event duration < 100ms

Dạy: async latency là yếu tố QUYẾT ĐỊNH VU pressure.
     Giảm async latency -> giảm VU cần thiết -> hết drop.
     Đây là giải pháp TỐT NHẤT (thay vì tăng maxVUs vô hạn).
```

### Variation 3: READY_AFTER_MS = 500ms (very slow async) — massive drops

```powershell
$env:CAR_05_READY_AFTER_MS = "500"
$env:CAR_05_PREALLOCATED_VUS = "30"
$env:CAR_05_MAX_VUS = "100"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_READY_AFTER_MS, Env:CAR_05_PREALLOCATED_VUS, Env:CAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

```text
W_async danh nghĩa ≈ 522ms
W_avg ≈ 0.7×3 + 0.3×522 = 158.7ms
required_vus_avg ≈ 6 × 0.159 = 0.95 -> 1 VU? Vẫn ít?

Nhưng VẤN ĐỀ là backend thực tế:
  - Với ready_after_ms=500, backend giữ job lâu hơn
  - Nhiều concurrent job -> queue đầy -> processing time còn cao hơn
  - W_p95 có thể lên đến 10-20 giây
  - required_vus_peak ≈ 6 × 15 = 90 VU
  - maxVUs=100 có thể vừa đủ, nhưng drop vẫn có thể xảy ra

Kỳ vọng: drop nhiều (>50), iterations << 270
Dạy: async latency là "đòn bẩy" — tăng READY_AFTER_MS làm tăng VU pressure
     theo cấp số nhân (do backend saturation).
```

### Variation 4: Tăng async_job weight lên 70%

Sửa code (tạm thời) hoặc dùng biến môi trường (nếu được hỗ trợ):

```js
// Sửa trong file test:
// Từ: weightedPick([{ name: 'dashboard', weight: 70 }, { name: 'async_job', weight: 30 }], ...)
// Sang: weightedPick([{ name: 'dashboard', weight: 30 }, { name: 'async_job', weight: 70 }], ...)
```

```text
Với 70% async_job:
  W_avg ≈ 0.3×3ms + 0.7×144ms = 0.9 + 100.8 = 101.7ms (danh nghĩa)
  W_avg thực tế cao hơn nhiều do backend saturation

  required_vus_avg ≈ 6 × 0.102 = 0.61 -> vẫn ít về lý thuyết
  Nhưng required_vus_peak khi nhiều async_job overlap: >> 50

Kỳ vọng: drop rất nhiều, có thể >100
Dạy: tỷ lệ async_job ảnh hưởng trực tiếp đến VU pressure.
     Càng nhiều async -> càng nhiều VU bị giữ lâu -> càng dễ drop.
```

### Variation 5: maxVUs = 200, quan sát có hết drop không

```powershell
$env:CAR_05_PREALLOCATED_VUS = "80"
$env:CAR_05_MAX_VUS = "200"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js"
Remove-Item Env:CAR_05_PREALLOCATED_VUS, Env:CAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Với maxVUs=200:
  - Có thể đủ VU để chịu W_p95 = 12785ms (cần ~77 VU)
  - Nhưng khi thêm VU, backend có thể chậm hơn nữa
  - required_vus có thể tăng theo -> vẫn có thể drop

Kỳ vọng: drop giảm nhiều, có thể về 0 nếu backend không bão hòa thêm.
         Nhưng p95 event duration sẽ rất cao (có thể >20s).

Dạy: thêm VU là giải pháp "brute force". Nó có thể làm hết drop,
     nhưng không giải quyết gốc rễ (backend performance).
     Trong production, 200 VU đồng nghĩa 200 concurrent request đến backend
     -> có thể gây cascading failure.
```

## Anti-patterns (mở rộng)

### Anti-pattern 1: "Async job chậm thì arrival rate giảm là bình thường"

```text
SAI: "Khi report job chậm, đương nhiên số lượng report xử lý mỗi giây sẽ giảm.
      Đó là điều bình thường, không cần test."

ĐÚNG: Trong open model, arrival rate là ĐỘC LẬP với processing time.
      User/scheduler vẫn gửi 6 requests/s bất kể backend chậm hay nhanh.
      Nếu backend không xử lý kịp, request sẽ bị DROP/TIMEOUT,
      không phải "tự động giảm tốc độ gửi".

      Test với constant-arrival-rate mô phỏng đúng hành vi này.
      Test với constant-vus mô phỏng SAI (tự giảm throughput).

Hậu quả nếu dùng constant-vus:
  - Test báo "pass" (throughput 4/s nhưng không drop)
  - Production: user vẫn gửi 6/s -> gateway timeout -> incident
  - Đây là "false negative" nguy hiểm nhất trong performance test
```

### Anti-pattern 2: "http_reqs phải bằng iterations"

```text
SAI: "Mỗi iteration là 1 HTTP request, nên http_reqs = iterations."

ĐÚNG: Case này có 2 branch với số lượng HTTP request khác nhau:
      - Dashboard: 1 request/event
      - Async_job: 2 requests/event
      Với mix 70/30: http_reqs ≈ iterations × 1.3

      Nếu http_reqs = iterations -> async_job branch không hoạt động!
      (Tất cả request đều là dashboard)

      Nếu http_reqs ≈ iterations × 2 -> dashboard branch không hoạt động!
      (Tất cả request đều là async_job)

Cách kiểm:
  http_reqs / iterations nên ≈ 1.2-1.4
  Nếu ngoài khoảng này -> weighted mix có vấn đề.
```

### Anti-pattern 3: "http_req_duration đủ để sizing VU"

```text
SAI: "Tôi thấy http_req_duration avg=XXms, p95=YYms.
      Vậy tôi cần khoảng rate × p95 = 6 × YY VUs."

ĐÚNG: Phải dùng EVENT DURATION, không phải HTTP REQUEST DURATION.
      Vì wait/sleep trong event cũng giữ VU.

      http_req_duration: thời gian 1 HTTP request hoàn thành
      event_duration: thời gian VU bận (từ start đến finish của event)

      Với case này:
        http_req_duration p95 ≈ 50ms
        event_duration p95 = 7950ms (Run 93)
        Tỷ lệ: 159x

      Nếu dùng http_req_duration để sizing:
        required_vus = 6 × 0.05 = 0.3 -> 1 VU là đủ!
        -> SAI HOÀN TOÀN. Thực tế cần >40 VU.

      Nếu dùng event_duration để sizing:
        required_vus = 6 × 7.95 = 47.7 -> cần ~50 VU
        -> ĐÚNG. Khớp với thực tế (active VU max=41, vẫn drop 22).
```

### Anti-pattern 4: "Checks 100% là đủ để pass"

```text
SAI: "Tất cả check đều OK -> test pass."

ĐÚNG: checks chỉ verify response content của những request ĐÃ GỬI.
      Nó không verify rằng TẤT CẢ request đã được gửi.

      Trong open model, contract là ARRIVAL RATE:
        "Phải start được 6 events/s"

      Nếu drop > 0:
        - Một số event không được start
        - Không có HTTP request -> không có check
        - checks=100% là đúng (tất cả request đã gửi đều OK)
        - Nhưng contract bị breach (không đủ arrivals)

      checks=100% + drop=0 -> PASS thật sự
      checks=100% + drop>0 -> FAIL (dù checks đẹp)

Thứ tự đọc output cho open model:
  1. dropped_iterations
  2. iterations (so với N_sched)
  3. checks
  4. http_req_failed
```

### Anti-pattern 5: "Tăng maxVUs là giải pháp cho mọi vấn đề drop"

```text
SAI: "Bị drop? Cứ tăng maxVUs lên là hết."

ĐÚNG: Tăng maxVUs có thể giảm drop, nhưng:
      1. Có diminishing returns (backend chậm hơn khi thêm load)
      2. Có thể không bao giờ hết drop nếu backend có hard limit
      3. Trong production, VU = connection/thread -> không thể vô hạn
      4. Giải pháp gốc: optimize backend hoặc scale horizontally

      Case này chứng minh:
        maxVUs 50 -> drop 22
        maxVUs 100 -> drop 6 (vẫn drop!)
        Cần maxVUs ~150-200 mới có thể hết drop
        Nhưng đó không phải giải pháp bền vững.

Giải pháp đúng:
  1. Giảm READY_AFTER_MS (tối ưu async processing)
  2. Thêm cache, DB index, connection pool (tối ưu backend)
  3. Scale ngang (thêm instance report service)
  4. Chấp nhận drop nếu nằm trong SLO budget
```

### Anti-pattern 6: "VUs max = 41 < maxVUs = 50 nên không thiếu VU"

```text
SAI: "Active VU chỉ đạt 41/50 -> vẫn còn 9 VU trống -> sao lại drop?"

ĐÚNG: VUs max = 41 là giá trị OBSERVED MAXIMUM — con số cao nhất
      quan sát được tại các thời điểm sample. Nó không có nghĩa là
      "lúc nào cũng còn 9 VU trống".

      Thực tế:
      - Tại thời điểm T=20.500s: tất cả 50 VU có thể đang bận
      - Nhưng sample VU tại T=20.500s không được ghi lại
      - Sample tại T=20.600s: 41 VU active (9 VU vừa xong event)
      - VUs max reported = 41

      Ngoài ra, VU sample là gauge, có thể bỏ lỡ peak ngắn.
      Drop xảy ra chứng minh rằng có những thời điểm 0 VU rảnh
      và maxVUs đã đạt đến, không spawn thêm được.

      -> Đừng dùng VUs max để kết luận "còn dư VU".
      -> Dùng dropped_iterations làm bằng chứng.
      -> Nếu drop > 0, chắc chắn có thời điểm thiếu VU.
```

### Anti-pattern 7: "Dùng constant-vus rồi tự tính throughput để kiểm tra"

```text
SAI: "Tôi dùng constant-vus với vus=20. Test xong tôi lấy iterations/45s
      để tính throughput. Nếu throughput < 6/s thì coi là fail."

ĐÚNG: Cách này VỀ LÝ THUYẾT có thể đúng, nhưng có 3 vấn đề:
      1. Dễ bỏ qua: người đọc output thường chỉ nhìn checks/http_req_failed
         -> không tự tính throughput -> kết luận sai "pass"
      2. Không chính xác: throughput trong constant-vus là HỆ QUẢ của
         VU count và event duration, không phải INDEPENDENT VARIABLE.
         Bạn không test "liệu hệ thống có chịu được 6/s không".
         Bạn test "20 VU tạo ra được throughput bao nhiêu".
      3. Không phát hiện được peak pressure: constant-vus không có cơ chế
         "cố gắng đạt rate" -> không tạo áp lực giống production.

      Với constant-arrival-rate:
        - K6 CHỦ ĐỘNG tạo 6 slots/s
        - Nếu không đủ VU -> DROP (tín hiệu rõ ràng)
        - Không cần tự tính throughput
        - Áp lực giống production (independent arrivals)

      -> Luôn dùng constant-arrival-rate để test ingress contract.
```

## Mapping business -> k6 config

Source script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js
```

Default config:

| Field | Value | Ý nghĩa |
| --- | ---: | --- |
| `rate` | `6` | 6 report arrivals mỗi giây |
| `timeUnit` | `1s` | target = 6 arrivals/s |
| `duration` | `45s` | giữ ingress trong 45 giây |
| `preAllocatedVUs` | `20` | nhiều worker vì có async/poll wait (dự phòng cho W_avg) |
| `maxVUs` | `50` | trần worker được mở thêm (dự phòng cho W_p95) |
| `readyAfterMs` | `120` | wait trước khi poll job status |
| `maxDroppedIterations` | `0` | không chấp nhận drop (contract nghiêm ngặt) |
| `userPool` | `250` | số lượng user identity xoay vòng |

Expected scheduled slots:

```text
scheduled_slots = 6 × 45 = 270 arrivals
```

Env override đầy đủ:

```powershell
$env:CAR_05_RATE = "6"
$env:CAR_05_TIME_UNIT = "1s"
$env:CAR_05_DURATION = "45s"
$env:CAR_05_PREALLOCATED_VUS = "20"
$env:CAR_05_MAX_VUS = "50"
$env:CAR_05_USER_POOL = "250"
$env:CAR_05_READY_AFTER_MS = "120"
$env:CAR_05_MAX_DROPPED = "0"
$env:CAR_05_BASE_URL = "http://localhost:8088"
```

## Code walkthrough

### Scenario definition

```js
export const options = {
  scenarios: {
    report_api_ingress: buildArrivalScenario(
      'reportApiIngress',    // export function name
      RATE,                  // 6
      TIME_UNIT,             // '1s'
      DURATION,              // '45s'
      PREALLOCATED_VUS,      // 20
      MAX_VUS,               // 50
      {
        case_id: CASE_ID,
        business_case: 'report_api_fixed_ingress_rate',
      },
    ),
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    dropped_iterations: [`count<=${MAX_DROPPED}`],  // count<=0
    constant_arrival_events_failed: ['count<5'],
  },
};
```

### buildArrivalScenario (từ common.js)

```js
export function buildArrivalScenario(en, r, tu, d, p, m, xt = {}) {
  return {
    executor: 'constant-arrival-rate',
    exec: en,
    rate: r,
    timeUnit: tu,
    duration: d,
    preAllocatedVUs: p,
    maxVUs: m,
    tags: {
      executor_family: 'constant_arrival_rate',
      workload_shape: 'fixed_ingress_rate',
      ...xt,
    },
  };
}
```

### Export function (reportApiIngress)

```js
export function reportApiIngress(data) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);  // 250 users

  // Weighted branch selection
  const choice = weightedPick(
    [
      { name: 'dashboard', weight: 70 },
      { name: 'async_job', weight: 30 },
    ],
    ctx.iter,
  );

  let ok = true;

  if (choice === 'async_job') {
    // ── Async branch: 2 API calls + wait ──
    const create = requestJson(
      'POST',
      `${TARGET_URL}/api/sim/report/jobs?cpu_ms=2&db_writes=1&external_ms=20&ready_after_ms=${READY_AFTER_MS}`,
      { report_type: 'sales-hourly', requested_by: ctx.userId },
      {
        caseId: CASE_ID,
        service: 'report-service',
        operation: 'report_arrival_create_job',
        endpoint: 'POST /api/sim/report/jobs',
        userId: ctx.userId,
      },
      202,  // expected status
    );
    ok = ok && create.ok;

    const jobId = create.ok
      ? responseJson(create.response, 'data.job_id', '')
      : '';

    if (jobId) {
      wait((READY_AFTER_MS + 20) / 1000);  // ← GIỮ VU!

      const status = requestJson(
        'GET',
        `${TARGET_URL}/api/sim/report/jobs/${jobId}?cpu_ms=0&db_rows=0`,
        null,
        {
          caseId: CASE_ID,
          service: 'report-service',
          operation: 'report_arrival_job_status',
          endpoint: 'GET /api/sim/report/jobs/:id',
          userId: ctx.userId,
        },
      );
      ok = ok && status.ok;
    } else {
      ok = false;  // job_id missing -> event fail
    }
  } else {
    // ── Dashboard branch: 1 API call ──
    const dashboard = requestJson(
      'GET',
      `${TARGET_URL}/api/sim/report?cpu_ms=0&db_rows=1&gzip_kb=0`,
      null,
      {
        caseId: CASE_ID,
        service: 'report-service',
        operation: 'report_arrival_dashboard',
        endpoint: 'GET /api/sim/report',
        userId: ctx.userId,
      },
    );
    ok = ok && dashboard.ok;
  }

  finishEvent(started, ok, {
    caseId: CASE_ID,
    service: 'report-service',
    operation: `report_${choice}_arrival`,
    userId: ctx.userId,
  });
}
```

### Điểm đặc biệt trong code

**1. `wait((READY_AFTER_MS + 20) / 1000)` — thủ phạm chính**

```text
Dòng này giữ VU trong 140ms (với READY_AFTER_MS=120).
Đây là "async wait" mô phỏng việc chờ job hoàn thành.
Trong thực tế, thay vì wait cố định, có thể poll với retry.

Tác động:
  - Mỗi async_job event giữ VU thêm 140ms so với dashboard event
  - Với 30% traffic là async_job, ảnh hưởng ~30% events
  - Với 270 slots, ~81 async_job events × 140ms = 11.3 giây VU-time "lãng phí"
  - 11.3 giây VU-time trong 45 giây test = ~25% capacity bị chiếm bởi wait
```

**2. `weightedPick` với modulo iteration**

```js
export function weightedPick(items, n) {
  const t = items.reduce((s, i) => s + i.weight, 0);  // t = 100
  const pk = n % t;  // pk = iter % 100
  let c = 0;
  for (const i of items) {
    c += i.weight;
    if (pk < c) return i.name;
  }
  return items[items.length - 1].name;
}
```

```text
Với iter từ 0 đến 269:
  iter=0:  pk=0,  c=70  -> 0<70  -> dashboard
  iter=1:  pk=1,  c=70  -> 1<70  -> dashboard
  ...
  iter=69: pk=69, c=70  -> 69<70 -> dashboard
  iter=70: pk=70, c=70  -> 70<70=false, c=100 -> 70<100 -> async_job
  iter=71: pk=71, c=70  -> 71<70=false, c=100 -> 71<100 -> async_job
  ...
  iter=99: pk=99, c=100 -> async_job
  iter=100: pk=0  -> dashboard (lặp lại)

Pattern: 70 dashboard, 30 async_job, lặp mỗi 100 iterations.
→ Phân phối TUYỆT ĐỐI chính xác 70/30 nếu iterations là bội của 100.
→ Với 270 iterations: 270/100 = 2.7 chu kỳ
  = 2 × (70+30) + 0.7 × 100 = 200 + 70 = 270
  Dashboard: 2×70 + 49 = 189
  Async: 2×30 + 21 = 81
  → Đúng 189/81 = 70/30.
```

**3. `userContext` với userPool=250**

```text
userId = arrival-user-${(iter % 250) + 1}
→ 250 user identity, xoay vòng theo iteration
→ Với 270 iterations: user-1 đến user-20 được dùng 2 lần,
  user-21 đến user-250 được dùng 1 lần
```

## Kết quả validation 2026-06-21

### Run 93 — Default config (FAIL)

```text
Run id: 93
Config: rate=6, timeUnit=1s, duration=45s, preAllocatedVUs=20, maxVUs=50
        readyAfterMs=120, maxDropped=0

Target slots: 270
Iterations: 249
HTTP requests: 309
Dropped iterations: 22
Checks: 100% (309/309)
HTTP failed: 0%
constant_arrival_events_failed: 0
constant_arrival_event_duration_ms p95: 7950.6 ms
Active VU max observed: 41

Result: FAIL — dropped_iterations=22 vượt threshold 0 (MAX_DROPPED=0)
```

### Run 96 — Tăng VU pool (STILL FAIL)

```text
Run id: 96
Config: preAllocatedVUs=60, maxVUs=100 (các tham số khác giữ nguyên)

Iterations: 265
HTTP requests: 325
Dropped iterations: 6
constant_arrival_event_duration_ms p95: 12785 ms

Result: FAIL — dropped_iterations=6 > 0
        Dù giảm 73% drop (22->6) nhưng vẫn chưa đạt contract
        p95 tăng 61% (7950->12785ms) do backend bão hòa nặng hơn
```

### So sánh 2 run

| Metric | Run 93 (pre=20, max=50) | Run 96 (pre=60, max=100) | Thay đổi | Đánh giá |
| --- | ---: | ---: | ---: | --- |
| Iterations | 249 | 265 | +6.4% | Cải thiện |
| Dropped | 22 | 6 | -72.7% | Cải thiện tốt |
| HTTP reqs | 309 | 325 | +5.2% | Cải thiện |
| p95 event duration | 7950.6ms | 12785ms | +60.8% | XẤU ĐI |
| Checks | 100% | 100% | 0 | Không đổi |
| HTTP failed | 0% | 0% | 0 | Không đổi |
| Result | FAIL | FAIL | — | Vẫn FAIL |

```text
Bài học từ 2 run:
  1. Tăng VU pool 3x giúp giảm 73% drop -> hiệu quả
  2. Nhưng p95 tăng 61% -> tác dụng phụ của việc thêm load lên backend
  3. Vẫn chưa đạt 0 drop -> cần thêm VU HOẶC optimize backend
  4. Đây là case dạy: thêm resource không phải lúc nào cũng giải quyết triệt để
```

## Reference

- Doc tham số constant-arrival-rate: `docs/20260515_01_shared-iterations-quick-index.md` (tham khảo cấu trúc)
- Doc executor từ đơn giản nhất: `docs/20260513_00_executor-from-simplest.md`
- Case 01 (per-vu-iterations): `docs/practice/per-vu-iterations/01_user-journey-replay.md` — gold reference về độ sâu
- Case 04 (constant-vus): `docs/practice/constant-vus/04_*.md` (nếu có)
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\car-05-report-api-ingress.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\constant-arrival-rate\common.js`
- Dashboard chart analysis: xem `08_validation-and-chart-analysis.md` (nếu có)

## Liên hệ với case khác

- **Case 01 (per-vu-iterations)**: identity bound vào VU; case 05 identity bound vào iteration
- **Case 02 (constant-vus)**: closed model — throughput tự điều chỉnh; case 05 open model — rate cố định
- **Case 03 (shared-iterations)**: count cố định, phân phối theo VU; case 05 count = rate × time, phân phối theo arrival schedule
- **Case 04 (ramping-vus)**: VU thay đổi theo thời gian; case 05 VU thay đổi theo nhu cầu (để giữ rate)
- **Case 06-08 (constant-arrival-rate khác)**: các biến thể của open model; case 05 là case "dạy" quan trọng nhất
