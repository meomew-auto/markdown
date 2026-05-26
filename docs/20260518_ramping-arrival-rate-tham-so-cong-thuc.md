# `ramping-arrival-rate`: tham số, ý nghĩa và công thức

File này là bản chi tiết cho executor:

```text
ramping-arrival-rate
```

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260518_ramping-arrival-rate-quick-index.md
```

Worked example:

```text
docs/20260518_ramping_arrival_rate_worked_example.md
```

## Mục lục nhanh

- [1. Ý tưởng chính](#1-ý-tưởng-chính)
  - [1.1. Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
  - [1.1.1. Nếu muốn tìm ngưỡng quá tải thì tăng gì?](#111-nếu-muốn-tìm-ngưỡng-quá-tải-thì-tăng-gì)
  - [1.2. Core chạy như nào](#12-core-chạy-như-nào)
  - [1.3. Open model gặp ramping rate: khác gì closed model ramping-vus?](#13-open-model-gặp-ramping-rate-khác-gì-closed-model-ramping-vus)
- [2. Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
  - [2.1. Biến phụ trong công thức](#21-biến-phụ-trong-công-thức)
- [3. Công thức nền](#3-công-thức-nền)
  - [3.1. Rate theo stage](#31-rate-theo-stage)
  - [3.2. Nhịp cao nhất và nhịp bình quân](#32-nhịp-cao-nhất-và-nhịp-bình-quân)
  - [3.3. Ước lượng VU](#33-ước-lượng-vu)
  - [3.4. Rate của summary](#34-rate-của-summary)
  - [3.5. dropped khác interrupted như nào?](#35-dropped-khác-interrupted-như-nào)
  - [3.6. Tổng thời gian timeline = sum(stage.duration)](#36-tổng-thời-gian-timeline--sumstageduration)
  - [3.7. Trần wall-clock = regular_duration + gracefulStop](#37-trần-wall-clock--regular_duration--gracefulstop)
  - [3.8. stage.target = rate target tại cuối stage](#38-stagetarget--rate-target-tại-cuối-stage)
  - [3.9. Checklist core đã lọc cho ramping-arrival-rate](#39-checklist-core-đã-lọc-cho-ramping-arrival-rate)
  - [3.10. Demo stage curve đủ VU](#310-demo-stage-curve-đủ-vu)
  - [3.11. Demo thiếu VU và dropped_iterations](#311-demo-thiếu-vu-và-dropped_iterations)
  - [3.12. Demo preAllocatedVUs vs maxVUs](#312-demo-preallocatedvus-vs-maxvus)
  - [3.13. Demo QuickPizza 2 requests / iteration](#313-demo-quickpizza-2-requests--iteration)
  - [3.14. Bước nhảy của rate trong 1 stage](#314-bước-nhảy-của-rate-trong-1-stage)
  - [3.15. Hai trục độc lập: stage timeline và VU iteration timeline](#315-hai-trục-độc-lập-stage-timeline-và-vu-iteration-timeline)
  - [3.16. Spawn timing của unplanned VU và dropped_iterations](#316-spawn-timing-của-unplanned-vu-và-dropped_iterations)
  - [3.17. preAllocatedVUs vs maxVUs: rate đạt đỉnh ở đâu?](#317-preallocatedvus-vs-maxvus-rate-đạt-đỉnh-ở-đâu)
  - [3.18. gracefulStop ở cuối scenario ramping-arrival-rate](#318-gracefulstop-ở-cuối-scenario-ramping-arrival-rate)
  - [3.19. Vì sao không spawn hết maxVUs ngay từ đầu?](#319-vì-sao-không-spawn-hết-maxvus-ngay-từ-đầu)
  - [3.20. Stages trùng target rate, duration=0s, rate=0](#320-stages-trùng-target-rate-duration0s-rate0)
- [4. Edge cases](#4-edge-cases)
  - [4.1. Stage rate ramp xuống 0 ở giữa](#41-stage-rate-ramp-xuống-0-ở-giữa)
  - [4.2. timeUnit lớn (phút) tương tác với stages](#42-timeunit-lớn-phút-tương-tác-với-stages)
  - [4.3. preAllocatedVUs quá thấp so với rate đỉnh](#43-preallocatedvus-quá-thấp-so-với-rate-đỉnh)
  - [4.4. Stages có duration=0s](#44-stages-có-duration0s)
- [5. So sánh với constant-arrival-rate](#5-so-sánh-với-constant-arrival-rate)
- [6. Cheat sheet](#6-cheat-sheet)

## 1. Ý tưởng chính

`ramping-arrival-rate` nghĩa là:

```text
k6 cố start iteration theo một rate thay đổi theo timeline
startRate = rate lúc bắt đầu
stages[].target = rate đích ở cuối mỗi stage
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      stages: [
        { duration: "2s", target: 4 },
        { duration: "2s", target: 1 },
        { duration: "2s", target: 3 },
      ],
      preAllocatedVUs: 4,
      maxVUs: 6,
    },
  },
};
```

Hiểu là:

```text
0-2s: rate ramp từ 2/s lên 4/s
2-4s: rate ramp từ 4/s xuống 1/s
4-6s: rate ramp từ 1/s lên 3/s
```

Điểm cốt lõi:

```text
ramping-arrival-rate = open model
rate là target start iteration theo lịch
VU chỉ là worker để giữ lịch đó
```

`open model` nghĩa là k6 bám theo lịch start, không đợi iteration trước chạy xong rồi mới tự lặp tiếp.

Nếu mới đọc, nhớ 5 câu này trước:

```text
slot = 1 mốc start mà executor muốn bắn đúng giờ
rate = nhịp start trong 1 giây
peak = chỗ nhịp cao nhất
VU = worker giữ iteration chạy
drop = đến giờ mà không có worker rảnh
```

Đọc bài theo thứ tự này sẽ dễ hơn:

```text
1. Ý tưởng chính
2. 5 câu nhớ nhanh
3. Ví dụ worked example
4. 3.2 và 3.3
5. 3.9 chỉ khi muốn đối chiếu code
```

`slot` ở đây là mốc start iteration theo lịch mà arrival-rate executor tự tính ra. Mỗi slot cần 1
VU rảnh.
Không có VU rảnh đúng mốc thì slot đó bị drop. k6 không chờ slot cũ rồi chạy bù.

### 1.1. Khi nào dùng thực tế?

Hợp khi muốn:

```text
giữ traffic vào hệ thống tăng/giảm theo timeline
đo vùng bắt đầu quá tải
kiểm tra hệ thống khi traffic có ramp-up/ramp-down
```

Không hợp khi muốn:

```text
N user đồng thời cố định
mỗi user chạy đúng M vòng
tổng work chia đều cho VU
```

### 1.1.1. Nếu muốn tìm ngưỡng quá tải thì tăng gì?

Tăng:

```text
stage target rate
```

Hoặc tăng `startRate` + target các stage sau để đẩy peak cao hơn.

Khi đó cần nhìn:

```text
lambda_peak
W_effective
dropped_iterations
latency/error
```

### 1.2. Core chạy như nào?

Phần này là để đối chiếu code thật. Nếu mới học, chỉ cần nhớ 4 ý:

```text
scheduler chuẩn bị trước VU và đợi `startTime`
cal() sinh lịch start
đến giờ thì TryRunIteration()
thiếu VU => slot đó mất
```

Tên hàm trong ngoặc chỉ để tra code, không cần nhớ thuộc lòng.

Core file:

```text
lib/executor/ramping_arrival_rate.go
```

`GetDescription()` của core mô tả theo:

```text
Up to X iterations/s for total_stage_duration over N stages (maxVUs: planned-max, gracefulStop: ...)
```

`GetExecutionRequirements()`:

```text
TimeOffset 0:
  PlannedVUs = preAllocatedVUs
  MaxUnplannedVUs = maxVUs - preAllocatedVUs

TimeOffset total_stage_duration + gracefulStop:
  PlannedVUs = 0
  MaxUnplannedVUs = 0
```

Luồng runtime:

```text
cal() sinh các mốc start theo diện tích dưới đường rate
đến mỗi mốc, Run() gọi TryRunIteration()
```

Nếu `TryRunIteration()` fail:

```text
dropped_iterations += 1
nếu còn quota unplanned -> tạo VU mới ở background
```

Điểm quan trọng:

```text
unplanned VU chỉ giúp các mốc sau
mốc hiện tại vẫn có thể đã bị drop
```

Scheduler metrics:

```text
vus = active VUs tại thời điểm sample
vus_max = initialized VUs tại thời điểm sample
```

`active VUs` ở đây nên đọc sát core là: VU đang thật sự bận chạy iteration.
Nếu VU đã nhận lệnh dừng nhưng vẫn chưa thoát khỏi iteration, nó vẫn còn được tính là đang bận.
VU đã init xong nhưng đang rảnh chờ slot mới thì chưa tính vào `vus`; nó thuộc initialized VUs.

`iterations` và `iteration_duration` vẫn được emit bởi JS runner sau full iteration.
Nếu có `minIterationDuration`, phần sleep bù không nằm trong `iteration_duration`
nhưng vẫn giữ VU bận.

### 1.3. Open model gặp ramping rate: khác gì closed model `ramping-vus`?

`ramping-arrival-rate` là cú lai giữa hai đặc tính:

```text
- open model:    rate điều khiển nhịp start, không phải VU active
- stages curve:  rate đó thay đổi theo timeline thay vì giữ một con số
```

**QUAN TRỌNG: `rate` ở đây nghĩa là gì?**

Câu hỏi hay gặp:

```text
"rate=10/s nghĩa là 10 iter HOÀN THÀNH mỗi giây à?
hay là active_vus / iter_time như ramping-vus?"
```

Trả lời: KHÔNG phải cả hai. `rate` ở đây là:

```text
rate = số iteration ĐƯỢC START /timeUnit (mục tiêu scheduler)
     = config target, CỐ ĐỊNH theo timeline
     = ĐỘC LẬP với iter_time của code
```

So sánh sát:

```text
ramping-vus (closed):
  throughput = sum(1/t_i) các VU active
             = active_vus / iter_time
             -> phụ thuộc iter_time
             -> nếu code chậm, throughput tự động giảm

ramping-arrival-rate (open):
  throughput target = rate config (vd 10/s)
                    -> KHÔNG phụ thuộc iter_time
                    -> code chậm thì k6 SPAWN thêm VU hoặc DROP iter
                       để cố giữ rate
```

Cụ thể với `rate: 10, timeUnit: 1s`:

```text
scheduler có nghĩa vụ FIRE 10 "slot" start iter mỗi giây
mỗi slot cách nhau 1/10 = 100ms
tại mỗi slot, scheduler tìm VU rảnh để giao iter:
- có VU rảnh → VU bắt đầu iter đó (start at t)
- không có VU rảnh & còn quota maxVUs → spawn unplanned VU (start trễ chút)
- không có VU rảnh & hết quota → drop iter (+1 dropped_iterations)

rate ở đây là MỤC TIÊU của scheduler, không phải kết quả tính từ VU
```

Ví dụ minh họa khác biệt:

```text
Cấu hình code: sleep(0.5)  -> iter_time = 0.5s

Open (ramping-arrival-rate, rate=10/s):
  10 slot/s start, mỗi slot tốn 1 VU 0.5s
  cần ≥ 5 VU để kịp (1 VU làm được 2 iter/s, 5 VU làm 10 iter/s)
  preAllocatedVUs >= 5 -> không drop
  preAllocatedVUs < 5 -> drop hoặc spawn unplanned

Closed (ramping-vus, vus=5):
  rate tự nhiên = 5 VU / 0.5s = 10 iter/s   <- TÌNH CỜ trùng

Nếu đổi code sang sleep(1):
  Open:   rate vẫn cố giữ 10/s -> CẦN 10 VU thay vì 5
                                  (preAllocated cũ 5 -> drop hoặc spawn unplanned)
  Closed: rate tự động giảm 5/1 = 5 iter/s
                                  (không drop, throughput đơn giản giảm)
```

Tóm gọn:

```text
Open model = "ép rate" (chủ động giữ throughput, có thể drop nếu quá tải)
Closed model = "rate tự sinh" (throughput phụ thuộc VU và iter_time)
```

Đây là lý do `ramping-arrival-rate` cần `preAllocatedVUs` và `maxVUs` —
hai field không tồn tại ở `ramping-vus`. Vì rate là mục tiêu, k6 phải biết
trước có bao nhiêu VU sẵn dùng (`preAllocatedVUs`) và được phép tạo thêm
tối đa bao nhiêu (`maxVUs`) khi rate vượt năng lực.

#### Không đủ VU thì slot xử lý ra sao? Có delay start time không?

Câu hỏi tiếp theo hay gặp:

```text
"slot 100ms mà không có VU rảnh, k6 sẽ ĐỢI VU rảnh rồi start trễ?
hay DROP luôn slot đó?"
"có metric nào ghi 'delay từ slot dự kiến tới lúc thật sự start' không?"
```

Trả lời ngắn:

```text
KHÔNG có delay. Slot HOẶC start ĐÚNG giờ HOẶC bị DROP.
Không có queue, không có retry, không có "bù slot" sau.
Không có metric "start_delay" / "scheduling_delay".
```

**Vì sao? Đọc core (`ramping_arrival_rate.go:473-486`)**:

```go
if vusPool.TryRunIteration() {
    continue   // có VU rảnh -> iter start NGAY tại slot này
}

// không có VU rảnh -> DROP iter, KHÔNG đợi
metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
    Metric: ...DroppedIterations,
    Time:   time.Now(),
    Value:  1,
})
```

Cụ thể `TryRunIteration` (`ramping_arrival_rate.go:527-534`):

```go
func (p *activeVUPool) TryRunIteration() bool {
    select {
    case p.iterations <- struct{}{}:
        return true   // non-blocking send THÀNH CÔNG -> có VU đang đọc kênh
    default:
        return false  // không VU nào đang đọc -> drop NGAY, KHÔNG đợi
    }
}
```

`select default` nghĩa là **non-blocking**: nếu không có VU nào đang chờ
ở `for range p.iterations` (line 552), send fail ngay lập tức và scheduler
move tới slot kế tiếp.

**Ví dụ minh họa với rate=10/s, preAllocated=2, code sleep(0.5)**:

```text
config: rate=10/s -> slot mỗi 100ms
        preAllocated=2 -> chỉ 2 VU sẵn dùng
        code sleep(0.5) -> mỗi VU bận 500ms
        năng lực: 2 VU x 2 iter/s = 4 iter/s (cần 10 iter/s -> thiếu 6/s)

Timeline (chưa spawn unplanned, hoặc maxVUs=preAllocated=2):

t=0ms    slot#0 fire -> VU=1 rảnh, iter#0 start ở VU=1 (sẽ kết thúc t=500ms)
                       -> __iterations__ +1 (sau khi VU=1 finish)

t=100ms  slot#1 fire -> VU=2 rảnh, iter#1 start ở VU=2 (sẽ kết thúc t=600ms)

t=200ms  slot#2 fire -> CẢ 2 VU đang bận
                       -> TryRunIteration trả false
                       -> dropped_iterations +1 (timestamp = 200ms)
                       -> KHÔNG đợi, không bù slot

t=300ms  slot#3 fire -> CẢ 2 VU vẫn bận
                       -> dropped_iterations +1
                       -> KHÔNG đợi

t=400ms  slot#4 fire -> tương tự, dropped +1

t=500ms  slot#5 fire -> VU=1 vừa finish iter#0, đang chờ ở channel
                       -> TryRunIteration trả true
                       -> iter#5 start ở VU=1 (KHÔNG phải iter#2 đã drop trước đó)
                       -> các slot bị drop trước đó VĨNH VIỄN MẤT
```

Quan sát quan trọng:

```text
1) iter#5 start ĐÚNG tại t=500ms (slot 5), KHÔNG phải bù cho slot 2 đã drop
2) k6 KHÔNG retry slot đã drop, không có queue chờ
3) summary cuối cùng:
   iterations         : 2 + 4 = 6 (slots 0,1,5,6,7,8 với rate 10/s trong 1s đầu)
   dropped_iterations : 4 (slots 2,3,4 và một số sau peak)
   start_delay        : KHÔNG TỒN TẠI metric này
```

**Nếu có quota unplanned (`maxVUs > preAllocated`)?**

```text
config: maxVUs=10, preAllocated=2, code sleep(0.5)

t=200ms  slot#2 fire -> 2 VU bận, drop ngay, dropped_iterations +1
                       -> background goroutine spawn unplanned VU
                          (init JS context, mất ~10-50ms)

t=300ms  slot#3 fire -> spawn vẫn đang chạy
                       -> 2 VU bận -> drop, dropped +1

t=~250ms VU#3 (unplanned) init xong, vào pool, sẵn sàng đọc channel

t=300-500ms các slot tiếp theo: VU=3 rảnh -> TryRunIteration succeed
                                -> các slot này KHÔNG bị drop
                                -> nhưng slots ĐÃ DROP ở 200, 300ms VẪN MẤT

Tóm gọn: unplanned VU CỨU các slot SẮP TỚI, không cứu slot ĐÃ DROP.
```

**Phân tích chi tiết 3 phase khi `preAllocated < ideal_vus` nhưng `maxVUs > preAllocated`**

Cùng config `rate=10/s, sleep(0.5), preAllocated=2, maxVUs=10` (`ideal_vus = 5`).

Phase 1 — Trước khi cần spawn (steady với preAllocated):

```text
t=0ms    slot#0 -> VU=1 nhận, iter#0 (xong t=500ms)
t=100ms  slot#1 -> VU=2 nhận, iter#1 (xong t=600ms)
t=200ms  slot#2 -> CẢ 2 VU bận
                  TryRunIteration() = false (ramping_arrival_rate.go:527-534)
                  -> dropped_iterations += 1
                  -> đẩy signal vào makeUnplannedVUCh
                     (ramping_arrival_rate.go:498-502)
                  -> background goroutine bắt đầu init VU=3
                  -> remainingUnplannedVUs--
```

Phase 2 — Đang spawn unplanned (window ~10-50ms cho init JS context):

```text
t=300ms  slot#3 -> 2 VU vẫn bận, VU=3 chưa ready
                  -> drop, dropped_iterations += 1
                  -> đẩy signal -> NHƯNG channel đã có item
                  -> default branch (line 501)
                  -> KHÔNG --remainingUnplannedVUs (idempotent)
t=400ms  slot#4 -> 2 VU bận, VU=3 vẫn chưa ready
                  -> drop, dropped += 1
                  -> trigger spawn VU=4
                  -> remainingUnplannedVUs--
t=~250ms VU=3 init xong, vào pool, chờ ở `for range p.iterations` (line 552)
```

→ Trong window spawn: slot bị drop, KHÔNG có delay.

Phase 3 — Sau khi unplanned ready:

```text
t=500ms  slot#5 -> VU=1 vừa finish + VU=3 đã ready
                  TryRunIteration() = true
                  -> race: VU=1 hoặc VU=3 đọc channel trước
                  -> 1 trong 2 nhận iter#5
                  -> iter#5 start ĐÚNG t=500ms, KHÔNG delay

t=~450ms VU=4 cũng ready (init từ slot#4)
t=500ms+ các slot tiếp theo đều có VU rảnh, không drop
```

**3 case kết luận user thấy được sau test**:

```text
Case A: preAllocatedVUs đủ (>= ideal_vus)
  dropped_iterations = 0
  vus_max = preAllocatedVUs (k6 không spawn thêm)
  vus đỉnh ≤ preAllocatedVUs
  -> setup tối ưu

Case B: preAllocated thiếu, maxVUs đủ
  dropped_iterations > 0 (vài slot đầu trong window spawn)
  vus_max tăng dần lên gần ideal_vus
  cuối cùng dropped ngừng tăng (đã catch up)
  -> hệ thống "chạy được" nhưng phí drop ban đầu

Case C: preAllocated thiếu, maxVUs cũng thiếu
  dropped_iterations tăng LIÊN TỤC suốt scenario
  vus_max bằng maxVUs (đã chạm trần)
  log warning: "Insufficient VUs, reached N active VUs and cannot initialize more"
                (ramping_arrival_rate.go:492)
  -> setup không đủ năng lực, hệ thống nghẽn nặng
```

**Lưu ý quan trọng về "delay"**:

```text
TRONG MỌI CASE: iter HOẶC start ĐÚNG slot_time HOẶC bị drop
KHÔNG có case "start delayed bằng X ms"

Vì TryRunIteration() là non-blocking (select default ở line 530-532):

  case p.iterations <- struct{}{}:
      return true   // có VU rảnh, send thành công NGAY
  default:
      return false  // không VU rảnh, return false NGAY (không đợi)

-> scheduler không bao giờ "đợi" -> không có delay
-> không có metric "start_delay" hoặc "scheduling_jitter"
```

**Vì sao thiết kế "hoặc start đúng giờ hoặc drop"?**

```text
Mục đích test arrival-rate là MÔ PHỎNG TRAFFIC THỰC.
Trong thực tế, nếu user gửi request mà server không xử lý kịp:
- option A (đúng): server từ chối/timeout -> drop
- option B (sai): xếp hàng và xử lý sau -> không phải đặc tính của open model

k6 chọn option A để giữ tính chất "open model":
- rate quyết định nhịp start
- không có buffer/queue ở phía k6
- nếu hệ thống không kịp -> tăng dropped_iterations
- người đọc test result thấy "10000 iter expected, 100 dropped" -> biết hệ thống bị nghẽn
```

**Metrics có sẵn để chẩn đoán:**

```text
iterations            : Counter, số iter HOÀN THÀNH (rate thực tế)
dropped_iterations    : Counter, số slot bị drop (chênh lệch so với target)
iteration_duration    : Trend, thời gian 1 iter
http_req_duration     : Trend, latency từng request

KHÔNG có:
- start_delay         : k6 không track delay vì delay = 0 hoặc drop
- scheduling_jitter   : tương tự
- queue_time          : không có queue ở k6 side
```

**So sánh với hệ thống có buffer (vd job queue Redis)**:

```text
k6 arrival-rate: open model, no buffer
  -> rate target = 10/s, năng lực 4/s -> 6/s drop, k6 không xếp hàng
  -> kết quả: "hệ thống nghẽn ngay 60% slot"

Job queue Redis: có buffer
  -> producer tạo 10 job/s, consumer xử lý 4 job/s
  -> queue dài ra liên tục, latency từng job tăng dần
  -> kết quả: "queue size = N, p99 delay = M"

Hai mô hình khác nhau, k6 cố tình KHÔNG mô phỏng buffer để giữ open model thuần.
```

#### Tính tổng VU cần khi iter_time > slot_interval

Đây là chỗ user hay nhầm. Khi:

```text
slot_interval = 1 / rate    (vd rate=10/s -> slot=100ms)
iter_time     = thời gian 1 VU bận cho 1 iter (vd sleep(0.5) = 500ms)
```

Nếu `iter_time > slot_interval`, thì **iter trước CHƯA xong khi slot kế tiếp đã fire**.
Nghĩa là tại 1 thời điểm có nhiều iter "overlap" — đang chạy đồng thời trên các VU khác nhau.

**Công thức (Little's Law)**:

```text
VUs_cần_đồng_thời = rate × iter_time
                  = iter_time / slot_interval
```

Đây là số iter ĐANG CHẠY song song tại 1 thời điểm khi rate đã ổn định (steady state).

**Ví dụ với rate=10/s, sleep(0.5)**:

```text
slot_interval = 1/10 = 100ms
iter_time     = 500ms

VUs_cần = 10 × 0.5 = 5 VU
        = 500ms / 100ms = 5 slot/iter

=> tại 1 thời điểm trong steady state có 5 iter đang chạy
=> cần preAllocatedVUs >= 5 để không drop
```

**Diễn giải timeline để thấy rõ overlap**:

```text
slot fire mỗi 100ms, mỗi iter chiếm 500ms

thời gian:  0ms  100  200  300  400  500  600  700  800  900  1000
slot fire:   0    1    2    3    4    5    6    7    8    9    10

VU=1:       [iter#0 ----------> 500ms][iter#5 ---------> 1000ms]
VU=2:           [iter#1 -----> 600ms][iter#6 ---------> ...
VU=3:                [iter#2 ---> 700ms][iter#7 ----> ...
VU=4:                     [iter#3 ----> 800ms][iter#8 ...
VU=5:                          [iter#4 ----> 900ms][iter#9 ...

Snapshot tại t=400ms: 5 iter đang overlap (iter#0,1,2,3,4 trên 5 VU)
```

**Vài tỉ lệ thực tế cho dễ nhớ**:

| rate | iter_time | VUs cần | Giải thích |
| --- | --- | --- | --- |
| 10/s | 0.1s | 1 | iter vừa hết thì slot kế đến → 1 VU đủ |
| 10/s | 0.5s | 5 | mỗi iter overlap 5 slot |
| 10/s | 1s | 10 | mỗi iter overlap 10 slot |
| 100/s | 0.5s | 50 | overlap 50 lần |
| 100/s | 0.1s | 10 | overlap vừa khít |
| 1/s | 5s | 5 | rate thấp nhưng iter lâu → vẫn overlap nhiều |

Quan sát quan trọng:

```text
- iter_time < slot_interval -> 1 VU thừa sức (vd rate=2/s, iter=0.1s -> 0.2 VU)
- iter_time = slot_interval -> đúng 1 VU vừa khít
- iter_time > slot_interval -> nhiều VU overlap, dùng Little's Law
- rate cao và iter chậm -> VU yêu cầu rất lớn
```

**Áp dụng vào setup `preAllocatedVUs`**:

```text
preAllocatedVUs nên >= ceil(rate × iter_time × 1.2)
                     (×1.2 = buffer 20% cho biến động iter_time)

vd rate=10/s, sleep(0.5):
  preAllocatedVUs >= ceil(10 × 0.5 × 1.2) = ceil(6) = 6

vd rate=100/s, http_req=200ms + sleep(0.3):
  iter_time ≈ 500ms
  preAllocatedVUs >= ceil(100 × 0.5 × 1.2) = 60
```

**Sai số phổ biến — đừng nhầm**:

```text
SAI : "rate=10/s thì cần 10 VU"
      -> SAI nếu iter_time != 1s
      -> rate là số slot/s, không phải số VU

SAI : "tăng VU làm iter_time giảm"
      -> SAI: VU thêm chỉ tăng năng lực song song
      -> iter_time vẫn = code time + server response time

SAI : "iter_time = 0.5s nghĩa là 1 VU làm 2 iter/s"
      -> ĐÚNG, nhưng đây là per-VU rate, không phải scenario rate
      -> scenario rate = config "rate" field, không tự suy ra từ VU
```

**Vì sao công thức này khác `ramping-vus`?**

```text
ramping-vus (closed):
  rate_thực = active_vus / iter_time
  -> CÓ iter_time -> KÉO theo rate giảm
  -> thay đổi iter_time là tự nhiên, không cần can thiệp

ramping-arrival-rate (open):
  rate_target = config (cố định)
  VU_cần = rate × iter_time
  -> CÓ iter_time -> KÉO theo VU cần TĂNG
  -> nếu preAllocated cố định -> drop hoặc spawn unplanned
```

Đây là điểm khác fundamental: closed model "iter_time tăng → throughput giảm",
open model "iter_time tăng → cần thêm VU (hoặc drop)".

Cách dễ hiểu:

```text
constant-arrival-rate = open model + 1 rate cố định
ramping-vus           = closed model + stages curve VU
ramping-arrival-rate  = open model + stages curve RATE
```

Tách ý so sánh `ramping-arrival-rate` với `ramping-vus`:

| Điểm so sánh | `ramping-vus` (closed) | `ramping-arrival-rate` (open) |
| --- | --- | --- |
| Ý nghĩa stages | thay đổi số VU active theo thời gian | thay đổi nhịp start iteration theo thời gian |
| `stage.target` | số VU active ở cuối stage | rate (iter/timeUnit) ở cuối stage |
| Số VU runtime | bằng đúng `stage.target` đang nội suy | thay đổi theo nhu cầu, trần là `maxVUs` |
| Quan hệ với `iter_time` | rate phụ thuộc iter_time | rate độc lập iter_time |
| Tổng iter biết trước? | không | không, nhưng `scheduled_iterations_total` biết trước |
| `dropped_iterations` | không có path emit bình thường | có, đếm khi không có VU rảnh đúng giờ |
| Unplanned VU | không có khái niệm | có, sinh khi rate vượt năng lực `preAllocatedVUs` |

Đặc thù khi rate ramp lên cao mà VU bận:

```text
1) preAllocatedVUs đủ -> tất cả slot start đúng giờ
2) preAllocatedVUs thiếu nhưng còn quota unplanned (maxVUs > preAllocatedVUs)
   -> slot hiện tại có thể bị drop
   -> background tạo VU mới, các slot SAU đó được dùng VU mới
3) preAllocatedVUs thiếu và hết quota unplanned (maxVUs = preAllocatedVUs)
   -> slot quá tải bị drop, không có cứu cánh
   -> log warning "Insufficient VUs, reached N active VUs and cannot initialize more"
```

Đọc rất ngắn nhưng dễ nhớ:

```text
ramping-arrival-rate hỏi: "rate có giữ được không?"
ramping-vus           hỏi: "concurrency thay đổi thế nào?"
```

Khi rate ramp lên rất cao trong thời gian rất ngắn (ví dụ ramp 0 -> 1000 trong 1s),
unplanned spawn không kịp catch up vì init VU mới tốn thời gian (parse module, tạo
JS sandbox). Nếu quan tâm tới tail latency của hệ thống, phải set `preAllocatedVUs`
đủ cao từ đầu để pool sẵn sàng trước peak.

## 2. Bảng tham số tiếng Việt

| Ký hiệu | Nghĩa | Đơn vị | Đọc từ đâu | Ghi chú |
| --- | --- | --- | --- | --- |
| `startRate` | rate lúc bắt đầu scenario | iterations/timeUnit | code/header | Nếu không set thì core dùng 0. |
| `timeUnit` | đơn vị của rate | duration | code/header | Default `1s`. Ví dụ `rate: 4, timeUnit: 1s` = 4 lần start mỗi giây. |
| `stages` | các stage đổi rate | list stage | code/header | Bắt buộc, mỗi stage có `duration` + `target`. |
| `stage.duration` | thời lượng stage | duration | code/header | Ví dụ `2s` nghĩa là stage đó kéo dài 2 giây. Tổng các stage = `total_regular_duration`. |
| `stage.target` | nhịp đích ở cuối stage | iterations/timeUnit | code/header | Đây là nhịp start, không phải VU. |
| `preAllocatedVUs` | VU chuẩn bị sẵn | VUs | code/header | Số worker có sẵn từ đầu để đỡ phải tạo gấp. |
| `maxVUs` | trần VU tối đa | VUs | code/header | Giới hạn cao nhất của worker; nếu bỏ qua thì bằng `preAllocatedVUs`. |
| `startTime` | delay trước khi cả đường ramp bắt đầu | duration | code/header | Dời toàn bộ đường ramp trên timeline tổng; không đổi toán bên trong từng stage. |
| `gracefulStop` | thời gian cho iteration đã start được finish sau `total_regular_duration` | duration | code/header | Sau mốc này iteration đang dở có thể bị interrupt. |
| `total_regular_duration` | tổng thời gian của các stage | duration | tự tính | `sum(stage.duration)`, chưa tính `gracefulStop`. |
| `lambda_start` | nhịp start lúc mở màn | iterations/s | tự tính | `startRate / timeUnit`. |
| `lambda_peak` | nhịp cao nhất trong cả timeline | iterations/s | tự tính | max của `startRate` và mọi `stage.target`. |
| `W_effective` | thời gian 1 VU bị bận cho 1 iteration | seconds/iteration | summary + core caveat | Dùng để ước lượng số VU cần. |

### 2.1. Biến phụ trong công thức

| Biến / biểu thức | Nghĩa | Ghi chú |
| --- | --- | --- |
| `lambda_prev` | rate ở đầu stage đang xét | Stage 1 thì = `lambda_start`; các stage sau thì = rate đích stage trước. |
| `lambda_next` | rate ở cuối stage đang xét | Bằng `stage.target / timeUnit_seconds`. |
| `lambda_current` | rate đang xét tại một thời điểm cụ thể | Dùng trong `drop_rate ~= max(0, lambda_current - capacity_with_M_vus)`. |
| `d_i` | duration của stage thứ i | Đơn vị seconds. |
| `scheduled_iterations_i` | số mốc start được schedule trong stage i | Với ramp tuyến tính: `d_i * (lambda_prev + lambda_next) / 2`. |
| `scheduled_iterations_total` | tổng số mốc start theo lịch cho toàn timeline | `sum(scheduled_iterations_i)`. |
| `average_target_rate` | nhịp start trung bình của cả timeline | `scheduled_iterations_total / total_regular_duration`. |
| `actual_summary_iterations_rate` | tốc độ completed iteration thật sự của summary | `completed_iterations / summary_runtime_base`. |
| `drop_rate` | số slot bị drop ước lượng theo giây | Chỉ là ước lượng, không phải metric core. |
| `W_effective_p95` | p95 của effective busy time | dùng khi sizing theo tail. |
| `safety_factor` | hệ số an toàn | margin > 1 để bù jitter/dao động. |
| `summary_runtime_base` | mẫu số mà Counter summary dùng cho cột `/s` | trong demo 1 scenario sạch, thường gần runtime của scenario. |

## 3. Công thức nền

> **Ngôn ngữ thống nhất với 1.3**: section này dùng các thuật ngữ
> đã thống nhất ở `1.3`:
>
> ```text
> rate          = số iter ĐƯỢC START /timeUnit (mục tiêu scheduler)
> slot          = 1 mốc fire của scheduler để start 1 iter
> slot_interval = 1 / rate
> iter_time     = thời gian 1 VU bận cho 1 iter (do code điều khiển)
> ```
>
> Cấu trúc mỗi mục: **ví dụ cụ thể → phân tích từng biến**.

### 3.1. Tổng số slot trong 1 stage

#### Config demo

```js
export const options = {
  scenarios: {
    demo_3_1: {
      executor: "ramping-arrival-rate",
      startRate: 2,
      timeUnit: "1s",
      preAllocatedVUs: 4,
      maxVUs: 10,
      stages: [
        { duration: "2s", target: 4 },   // ramp 2 → 4 iter/s
      ],
    },
  },
};

export default function () {
  // code chạy trong mỗi iter
}
```

#### Đọc config

Stage 0: `ramp 2 → 4 iter/s trong 2s`:

```text
đầu stage  (t=0s):  rate = 2/s   -> slot_interval = 500ms
giữa stage (t=1s):  rate = 3/s   -> slot_interval ≈ 333ms
cuối stage (t=2s):  rate = 4/s   -> slot_interval = 250ms

Câu hỏi: tổng có bao nhiêu slot fire trong stage này?
```

Suy nghĩ trực giác:

```text
nếu rate cố định 2/s suốt 2s -> 2 × 2 = 4 slot
nếu rate cố định 4/s suốt 2s -> 4 × 2 = 8 slot
rate ramp tuyến tính 2 → 4   -> rate trung bình = 3/s
                              -> tổng = 3 × 2 = 6 slot
```

Áp công thức:

```text
scheduled_slots = duration × (rate_đầu + rate_cuối) / 2
                = 2s × (2 + 4) / 2
                = 6 slot
```

#### Phân tích công thức

```text
scheduled_iterations_i = d_i × (lambda_prev + lambda_next) / 2
```

| Biến | Ý nghĩa | Đơn vị |
| --- | --- | --- |
| `d_i` | duration stage i | seconds |
| `lambda_prev` | rate ở **đầu** stage (= rate cuối stage trước) | iter/s |
| `lambda_next` | rate ở **cuối** stage (= `stage.target / timeUnit_seconds`) | iter/s |
| `(lambda_prev + lambda_next) / 2` | rate **trung bình** của stage | iter/s |
| `scheduled_iterations_i` | tổng slot fire trong stage này | slot |

`lambda` = "nhịp start" = bao nhiêu iter cần START mỗi giây. Đây là **mục
tiêu scheduler** (đã thống nhất ở `1.3`), không liên quan iter_time hay VU.

Vì sao là trung bình? Vì rate ramp tuyến tính. Trên đồ thị `rate(t)`:

```text
rate
4 |           /|
3 |          / |    <- diện tích dưới đường = tổng slot
2 |_________/  |
0 +---0s-------2s

= hình thang:
  đáy nhỏ = lambda_prev = 2
  đáy lớn = lambda_next = 4
  chiều cao = duration = 2s

Diện tích = (đáy nhỏ + đáy lớn) / 2 × chiều cao
          = (2 + 4) / 2 × 2 = 6
```

#### Vì sao rate giữa stage = 3/s? Cách tính rate(t) ở mọi thời điểm

k6 ramp rate **tuyến tính** từ `lambda_prev` đến `lambda_next` trong
`duration` (đường thẳng nối 2 điểm).

Công thức đường thẳng đi qua 2 điểm `(t1, y1)` và `(t2, y2)`:

```text
y(t) = y1 + (y2 - y1) × (t - t1) / (t2 - t1)
```

Áp vào rate trong stage (gọn hơn dạng `y = mx + b`):

```text
slope    = (lambda_next - lambda_prev) / duration
rate(t)  = lambda_prev + slope × (t - stageStart)
```

Áp vào ví dụ `ramp 2 → 4 trong 2s`:

```text
lambda_prev = 2 iter/s   (tại t=0s)
lambda_next = 4 iter/s   (tại t=2s)
duration    = 2s

slope = (4 - 2) / 2 = 1   (mỗi giây rate tăng 1)
rate(t) = 2 + 1 × t = 2 + t
```

Tính rate ở từng mốc:

| t (s) | rate(t) = 2 + t | rate |
| --- | --- | --- |
| 0.0 | 2 + 0 | 2/s |
| 0.5 | 2 + 0.5 | 2.5/s |
| 1.0 | 2 + 1 | **3/s** |
| 1.5 | 2 + 1.5 | 3.5/s |
| 2.0 | 2 + 2 | 4/s |

→ Tại `t=1s` (giữa stage) rate đúng bằng `3/s` vì là **trung điểm** của
đường thẳng nối `(0, 2)` đến `(2, 4)`.

Trên đồ thị:

```text
rate
4 |              ●  (t=2, rate=4)
3 |       ●        (t=1, rate=3) - giữa stage
2 |●               (t=0, rate=2)
0 +---------+---------+----► t
  0        1s       2s

đường thẳng (0, 2) → (2, 4), slope = 1
```

**Vì sao là đường thẳng, không phải curve?**

Công thức diện tích `(lambda_prev + lambda_next) / 2 × duration` ở trên
chính là **diện tích hình thang** — chỉ đúng với đường thẳng. Nếu k6 ramp
cong (parabol, exponential), công thức tích phân sẽ khác hoàn toàn.

k6 chọn tuyến tính vì:

```text
- đơn giản, dễ tính (chỉ cần 2 điểm đầu/cuối)
- trực giác: user nghĩ "ramp đều" = tuyến tính
- đủ cho mọi load test thực tế
```

Code ref: `cal()` trong `ramping_arrival_rate.go:234-282` dùng công thức
nghiệm bậc 2 từ tích phân của hàm tuyến tính `rate(t) = a + bt` để tìm
mốc fire của slot thứ n.

**Ramp xuống cũng vẫn tuyến tính** — slope âm:

```text
ramp 4 → 1 trong 2s:
  slope = (1 - 4) / 2 = -1.5   (âm vì giảm)
  rate(t) = 4 - 1.5t

t=0   : rate = 4/s
t=0.5 : rate = 3.25/s
t=1   : rate = 2.5/s   <- giữa stage = (4+1)/2 = 2.5
t=1.5 : rate = 1.75/s
t=2   : rate = 1/s
```

**Tóm gọn 4 công thức nhớ nhanh**:

```text
slope            = (lambda_next - lambda_prev) / duration
rate(t)          = lambda_prev + slope × (t - stageStart)
rate giữa stage  = (lambda_prev + lambda_next) / 2  (trung bình cộng)
scheduled_slots  = duration × (lambda_prev + lambda_next) / 2
                 = duration × rate giữa stage
                 = diện tích hình thang
```

#### Các biến thể stage

**Ramp xuống** — cùng công thức:

```text
ramp 4 → 1 iter/s trong 2s
slot = 2 × (4 + 1) / 2 = 5 slot

rate
4 |--------\   |
3 |         \  |
2 |          \ |
1 |           \|
0 +---0s-------2s

5 slot rải dưới đường, slot đầu dày, slot cuối thưa.
```

**Hold (rate cố định)** — `lambda_prev = lambda_next`:

```text
hold 4 iter/s trong 3s
slot = 3 × (4 + 4) / 2 = 12

(hoặc đơn giản: slot = duration × rate = 3 × 4 = 12)
slot_interval = 1/4 = 250ms, đều suốt stage.
```

**Tổng cả timeline**:

```text
scheduled_iterations_total = sum(scheduled_iterations_i)
```

Ví dụ scenario 3 stage (`startRate=0`):

```text
stage 0: ramp 0 → 4/s trong 2s   -> 2 × (0+4)/2 = 4 slot
stage 1: hold 4/s trong 3s        -> 3 × 4       = 12 slot
stage 2: ramp 4 → 0/s trong 2s   -> 2 × (4+0)/2 = 4 slot
                                   -----------------
                                   scheduled_total = 20 slot
```

Đây là số slot k6 **DỰ TÍNH** fire (mục tiêu scheduler), khác số iter
HOÀN THÀNH (= `iterations` trong summary). Quan hệ:

```text
iterations_completed + dropped_iterations + interrupted_iterations
  ≈ scheduled_iterations_total   (xấp xỉ ±1 do biên slot)
```

#### 3 caveat từ core

**Caveat 1: slot có thể ra số lẻ**

`scheduled_iterations_i` không nhất thiết nguyên (vd 5.7 slot). Core
giữ phần lẻ trong `doneSoFar` rồi mang sang stage sau.

```text
stage 0: 2.5 slot -> fire 2 slot, dư 0.5 mang sang
stage 1: 3.7 slot -> fire 4 slot (3.7 + 0.5 = 4.2 -> 4), dư 0.2
stage 2: ...
```

Code ref: `cal()` ở `ramping_arrival_rate.go:234-282`, biến `doneSoFar`.

**Caveat 2: slot đầu KHÔNG mặc định ở t=0**

```text
k6 KHÔNG tự fire slot tại t=0
k6 CHỜ đến lúc tích lũy đủ 1 event nguyên đầu tiên
```

Mini ví dụ với `startRate=0, stage 1 ramp 0 → 4/s trong 2s`:

```text
t=0s   : tích lũy = 0           -> chưa fire
t=0.5s : tích lũy = 0.25        -> chưa đủ 1
t=1.0s : tích lũy = 1.0         -> fire slot đầu tại t=1.0s
t=1.5s : tích lũy = 2.25        -> fire slot 2
t=2.0s : tích lũy = 4.0         -> fire các slot còn lại
```

→ slot đầu lệch khỏi `t=0` khi `startRate < target stage 1`. So
`scheduled_total` với completed lệch 1 slot ở biên là bình thường,
chưa chắc do drop/interrupt.

**Caveat 3: không có `ticker_period` cố định**

Khác `constant-arrival-rate` (slot đều), `ramping-arrival-rate` có
`slot_interval` thay đổi:

```text
giữa stage ramp lên : slot_interval THU HẸP (rate tăng -> slot dày)
giữa stage hold     : slot_interval ĐỀU
giữa stage ramp xuống: slot_interval DÃN RA (rate giảm -> slot thưa)
```

`tickerPeriod` trong `Run()` chỉ là khoảng cách hiện tại giữa 2 slot
liên tiếp để update progress UI, không phải hằng số toàn run.

### 3.2. Nhịp cao nhất và nhịp bình quân

#### Config demo

```js
export const options = {
  scenarios: {
    demo_3_2: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 4,
      maxVUs: 10,
      stages: [
        { duration: "2s", target: 4 },   // ramp 0 → 4/s
        { duration: "3s", target: 4 },   // hold 4/s
        { duration: "2s", target: 0 },   // ramp 4 → 0/s
      ],
    },
  },
};
```

#### Đọc config

```text
startRate = 0/s
stages:
  stage 0: ramp 0 → 4/s trong 2s
  stage 1: hold 4/s trong 3s
  stage 2: ramp 4 → 0/s trong 2s

scheduled_total = 4 + 12 + 4 = 20 slot   (theo công thức 3.1)
total_regular_duration = 2 + 3 + 2 = 7s
```

Hỏi:

```text
1) rate cao nhất scenario phải chịu là bao nhiêu?
2) rate trung bình của cả timeline là bao nhiêu?
```

Trả lời:

```text
1) lambda_peak = max(0, 4, 4, 0) = 4/s
   (max trong: startRate, mọi stage.target)

2) average_target_rate = 20 / 7 ≈ 2.86/s
```

#### Phân tích công thức

```text
lambda_peak = max(lambda_start, mọi lambda_i_end)
average_target_rate = scheduled_iterations_total / total_regular_duration
```

| Biến | Ý nghĩa | Vì sao max chỉ ở "đầu/cuối stage"? |
| --- | --- | --- |
| `lambda_peak` | rate cao nhất scenario phải fire | rate ramp tuyến tính → cực trị nằm ở 2 đầu stage, không nằm giữa |
| `average_target_rate` | rate trung bình của cả timeline | dùng đánh giá chung, không dùng để sizing VU |

#### Ví dụ áp dụng sizing

```text
scenario lên 8/s rồi xuống 2/s:

nếu sizing theo average:  (8+2)/2 = 5/s -> chỉ đủ VU cho rate trung bình
                          -> đoạn 8/s sẽ DROP nhiều
nếu sizing theo peak:     8/s        -> đủ VU cho rate cao nhất
                          -> không drop
```

→ luôn dùng `lambda_peak` cho sizing, không dùng `average_target_rate`.

#### Quan hệ với `drop_rate`

```text
drop_rate ≈ max(0, lambda_current - capacity_with_M_vus)
```

| Biến | Ý nghĩa |
| --- | --- |
| `lambda_current` | rate đang xảy ra **tại 1 thời điểm cụ thể** (đầu stage thấp, giữa stage cao hơn) |
| `capacity_with_M_vus` | năng lực M VU = `M / iter_time` (xem `3.3`) |
| `drop_rate` | rate slot bị drop tại thời điểm đó |

Ý chính: nhìn `lambda_current` chứ không phải `average_target_rate`. Đoạn
giữa stage có `lambda_current` cao hơn trung bình → đó là chỗ dễ drop.

### 3.3. Ước lượng VU cần chuẩn bị

#### Config demo

```js
export const options = {
  scenarios: {
    demo_3_3: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 5,    // sẽ tính lại dựa vào lambda_peak × iter_time
      maxVUs: 10,
      stages: [
        { duration: "2s", target: 8 },   // ramp 0 → 8/s (peak)
        { duration: "3s", target: 8 },   // hold 8/s
      ],
    },
  },
};

import { sleep } from "k6";
export default function () {
  // giả lập: 1 http request 100ms + sleep 0.3s
  sleep(0.4);   // -> iter_time ≈ 0.4s
}
```

#### Đọc config

```text
lambda_peak = 8 iter/s   (rate cao nhất, từ stage.target)
iter_time   = 0.4s       (do code: sleep(0.4))
```

Hỏi: cần chuẩn bị bao nhiêu VU để không drop?

Trả lời theo Little's Law:

```text
required_vus = ceil(lambda_peak × iter_time)
             = ceil(8 × 0.4)
             = ceil(3.2)
             = 4 VU
```

→ `preAllocatedVUs >= 4` (nên cộng buffer 20% → 5).

#### Phân tích công thức

```text
required_vus_min_peak ≈ ceil(lambda_peak × W_effective)
capacity_with_M_vus   ≈ M / W_effective
drop_rate             ≈ max(0, lambda_current - capacity_with_M_vus)
```

| Biến | Ý nghĩa | Đơn vị |
| --- | --- | --- |
| `lambda_peak` | rate cao nhất scenario phải chịu (xem `3.2`) | iter/s |
| `W_effective` | iter_time hiệu dụng = `max(iter_duration, minIterationDuration)` | s/iter |
| `lambda_peak × W_effective` | số VU **đồng thời bận** tại đỉnh rate | VU |
| `ceil(...)` | làm tròn lên (không có nửa VU) | VU |
| `M` | số VU thực tế trong pool | VU |
| `M / W_effective` | năng lực pool M VU = bao nhiêu iter/s | iter/s |
| `lambda_current - capacity` | phần dư khi rate vượt năng lực | iter/s |

**Đây chính là Little's Law** đã thấy ở `1.3`:

```text
VUs_đồng_thời = rate × iter_time
              = mục tiêu_rate × thời gian giữ VU mỗi iter
```

#### Kiểm tra đơn vị

```text
lambda_peak [iter/s] × W_effective [s/iter] = [VU]    ✓
M [VU] / W_effective [s/iter]                = [iter/s] ✓
```

#### Ví dụ ngược lại: capacity hiện có chịu được rate nào?

Có sẵn `M = 6 VU`, `iter_time = 0.5s`:

```text
capacity = 6 / 0.5 = 12 iter/s
```

→ scenario có `lambda_peak ≤ 12` → không drop.
→ scenario có `lambda_peak = 15` → drop 3/s tại đỉnh.

#### `W_effective` là gì?

```text
W_effective = iter_duration                              nếu KHÔNG set minIterationDuration
            = max(iter_duration, minIterationDuration)   nếu CÓ set minIterationDuration
```

`minIterationDuration` là sàn: nếu code chạy nhanh hơn `min`, k6 sleep bù
sau function. VU bị giữ trong toàn bộ `min` đó → ảnh hưởng sizing.

Ví dụ:

```text
code mất 0.2s, minIterationDuration = 1s
=> W_effective = max(0.2, 1) = 1s
=> rate=10/s cần ceil(10 × 1) = 10 VU (không phải 2 VU)
```

### 3.4. Rate của summary thực tế

#### Config demo

```js
export const options = {
  scenarios: {
    demo_3_4: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 3,    // ÍT hơn ideal -> sẽ có 1-2 drop để minh họa
      maxVUs: 3,             // không cho spawn unplanned
      stages: [
        { duration: "2s", target: 4 },
        { duration: "3s", target: 4 },
        { duration: "2s", target: 0 },
      ],
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(0.5); }
```

#### Đọc summary thật

Sau khi chạy xong scenario, summary in:

```text
iterations.........: 18    2.571428/s
http_reqs..........: 36    5.142857/s
checks_total.......: 36    5.142857/s
```

Hỏi: rate `2.57/s` này nghĩa là gì? So với `lambda_peak=4/s` và
`average_target_rate=2.86/s` ở trên, vì sao khác?

Trả lời:

```text
2.571428/s = completed_iterations / summary_runtime_base
           = 18 / 7s ≈ 2.57/s
           = rate THỰC TẾ k6 đã hoàn thành (sau khi trừ drop/interrupt)
```

Trong ví dụ này:

```text
scheduled_total          = 20 slot (theo công thức 3.1)
completed_iterations     = 18      (trong summary)
=> dropped/interrupted   = 20 - 18 = 2

actual_rate (2.57/s) < average_target_rate (2.86/s) vì có 2 slot không hoàn thành
```

#### Phân tích công thức

```text
actual_summary_iterations_rate = completed_iterations / summary_runtime_base
http_reqs_rate                 = total_http_requests / summary_runtime_base
checks_total_rate              = total_checks / summary_runtime_base
```

| Biến | Ý nghĩa | Nguồn |
| --- | --- | --- |
| `completed_iterations` | số iter HOÀN THÀNH (không drop, không interrupt) | summary `iterations` |
| `total_http_requests` | tổng HTTP request đã gửi | summary `http_reqs` |
| `summary_runtime_base` | mẫu số core dùng cho cột `/s` | xem dưới |

#### `summary_runtime_base` là gì?

Mẫu số core dùng cho cột `/s` của Counter. Trong demo 1 scenario, không
`setup()/teardown()`, `startTime=0`:

```text
summary_runtime_base ≈ thời gian scenario thật sự chạy (regular_duration + grace nếu có dùng)
```

Nhưng KHÔNG NÊN đồng nhất với `total_regular_duration`:

```text
total_regular_duration  = sum(stage.duration) = lý thuyết
summary_runtime_base    = thực tế khi chạy, có thể chênh ±1s
```

#### 3 rate phân biệt

```text
1) lambda_peak                       [iter/s, mục tiêu cao nhất]
2) average_target_rate               [iter/s, trung bình lịch start]
3) actual_summary_iterations_rate    [iter/s, completed thực tế]
```

Ý nghĩa khác nhau:

```text
- (1) dùng SIZING VU (preAllocatedVUs >= ceil(lambda_peak × iter_time))
- (2) dùng đối chiếu sau test (xem có drop/interrupt nhiều không)
- (3) dùng làm KPI cuối cùng (rate thực hệ thống chịu được)
```

#### Verify quan hệ

```text
(1) lambda_peak   >= (2) average_target_rate   (peak luôn >= average)
(2) average_target_rate >= (3) actual_rate     (target >= thực, do drop/interrupt)
```

Nếu thấy `(3) > (2)` → nhiều khả năng đo lệch, cần kiểm tra lại
`summary_runtime_base` có đúng không.

### 3.5. `dropped` khác `interrupted` như nào?

#### Config demo

```js
export const options = {
  scenarios: {
    demo_3_5: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 2,    // CỐ TÌNH thiếu để có drop
      maxVUs: 2,             // không cho spawn unplanned
      gracefulStop: "1s",    // grace ngắn để có interrupted ở cuối
      stages: [
        { duration: "3s", target: 4 },
        { duration: "2s", target: 4 },
      ],
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(2); }   // iter dài hơn grace -> interrupt cuối
```

#### Đọc summary thật

Sau test, summary cho:

```text
iterations.................: 18    completed
dropped_iterations.........: 5     metric Counter riêng
running (...), 2 interrupted iterations  <- progress/footer
```

Hỏi: 5 dropped vs 2 interrupted khác nhau ở đâu?

Trả lời:

```text
5 dropped     = 5 slot ĐÃ ĐẾN GIỜ start nhưng không tìm được VU rảnh
                -> CHƯA TỪNG vào iter
                -> không tốn thời gian VU nào

2 interrupted = 2 iter ĐÃ START rồi nhưng bị cancel giữa chừng
                -> ĐÃ vào iter, đang chạy thì context bị hủy
                -> đã tốn thời gian VU + tài nguyên
```

#### Phân tích phân biệt

| | `dropped` | `interrupted` |
| --- | --- | --- |
| Định nghĩa | slot không start được iter | iter đã start nhưng không finish |
| Khi nào xảy ra? | tại lúc slot fire mà `TryRunIteration()` fail | khi iter đang chạy thì context cancel (hết grace, abort, ...) |
| Đã tốn VU? | KHÔNG | CÓ (VU đã đang chạy iter) |
| Nguyên nhân thường gặp | preAllocated thiếu, code chậm hơn dự kiến | hết `gracefulStop`, scenario bị abort, error fatal |
| Vị trí trong output | metric Counter `dropped_iterations` | số ở progress/footer cuối run, không có Counter riêng |
| Code emit | `ramping_arrival_rate.go:479-486` | `helpers.go:80-113` (context cancel ở giữa iter) |

#### Tổng quan timeline minh họa

```text
slot fire  ▼     ▼     ▼     ▼     ▼     ▼
trục thời gian  ──────────────────────────────────────►

VU=1: [iter#0 ──── done]   [iter#3 ──── done]
VU=2:   [iter#1 ──── done]   [iter#4 ── X cancel]   <- INTERRUPTED
                  ▲                            ▲
                  │                            └─ iter đã chạy giữa chừng
                  └─ slot fire mà cả 2 VU bận
                     -> dropped_iterations +1
                     (không tốn VU nào)
```

#### Khi nào xảy ra `dropped`?

```text
1) preAllocated < ideal_vus, không có quota unplanned
   -> slot fire mà không có VU rảnh -> drop

2) preAllocated thiếu, đang chờ unplanned spawn
   -> trong window spawn (~10-50ms), slot vẫn fire -> drop
   (xem 3.16, phase 2)

3) iter_time đột nhiên dài hơn dự kiến (server chậm)
   -> năng lực VU tụt xuống dưới rate -> drop
```

#### Khi nào xảy ra `interrupted`?

```text
1) Iter đang chạy tại t = regular_duration + gracefulStop
   -> grace hết, hardStop -> interrupted

2) User Ctrl+C / scenario bị abort
   -> tất cả iter đang chạy bị cancel

3) Error fatal trong VU (vd OOM, panic)
   -> iter đang chạy không hoàn thành
```

#### Tóm gọn nhớ nhanh

```text
dropped      = chưa start được          (lúc slot fire)
interrupted  = đã start nhưng không finish (lúc context cancel)

dropped không tốn VU
interrupted đã tốn VU, không gặt được data
```

Vì vậy khi đọc summary:

```text
- dropped cao -> sizing VU thiếu -> tăng preAllocatedVUs/maxVUs
- interrupted cao -> code chậm hơn duration -> tăng gracefulStop hoặc giảm rate
```

Nếu 1 completed iteration chạy đủ N request:

```text
estimated_http_reqs_rate_if_no_branch = N * actual_summary_iterations_rate
```

Chỉ dùng khi code path sạch và không có interrupt/branch làm thiếu request.

### 3.6. Tổng thời gian timeline = `sum(stage.duration)`

```text
total_regular_duration = sum(stage.duration)
```

Đọc từ core: `helpers.go:19-24`:

```go
func sumStagesDuration(stages []Stage) (result time.Duration) {
    for _, s := range stages {
        result += s.Duration.TimeDuration()
    }
    return result
}
```

`Run()` trong `ramping_arrival_rate.go:317` gọi đúng `sumStagesDuration(varr.config.Stages)`
để lấy `regular_duration`. Không có chỗ nào trong executor cộng thêm offset cho stages.

Ví dụ:

```text
stages:
  duration=2s, target=4
  duration=2s, target=1
  duration=2s, target=3

total_regular_duration = 2+2+2 = 6s
```

Header k6 in:

```text
* demo: Up to 4.00 iterations/s for 6s over 3 stages (...)
```

Trong đó:

```text
"Up to 4.00 iterations/s" = peak rate (max startRate hoặc max stage.target / timeUnit)
"6s"                      = total_regular_duration = sum(stage.duration)
"3 stages"                = số phần tử trong array stages
```

Nhớ: `total_regular_duration` chỉ tính phần config stages, **chưa cộng** `gracefulStop`.
Nó cũng chưa cộng `startTime` của scenario. Mục 3.7 dưới đây nói rõ hơn về trần wall-clock.

### 3.7. Trần wall-clock = `regular_duration + gracefulStop`

```text
executor_wall_time_after_start_max = regular_duration + gracefulStop
```

Đọc từ `ramping_arrival_rate.go:121-134`:

```go
func (varc RampingArrivalRateConfig) GetExecutionRequirements(
    et *lib.ExecutionTuple,
) []lib.ExecutionStep {
    return []lib.ExecutionStep{
        { TimeOffset: 0, PlannedVUs: ..., MaxUnplannedVUs: ... },
        {
            TimeOffset: sumStagesDuration(varc.Stages) + varc.GracefulStop.TimeDuration(),
            PlannedVUs: 0, MaxUnplannedVUs: 0,
        },
    }
}
```

`Run()` (`ramping_arrival_rate.go:338`) gọi `getDurationContexts(parentCtx, duration, gracefulStop)`,
trong đó `helpers.go:141-153`:

```go
maxEndTime := startTime.Add(regularDuration + gracefulStop)
maxDurationCtx, ... = context.WithDeadline(parentCtx, maxEndTime)
regDurationCtx, _ = context.WithDeadline(maxDurationCtx, startTime.Add(regularDuration))
```

Nghĩa là:

```text
regDurationCtx hết -> không còn slot start mới
maxDurationCtx hết -> hard-stop iteration đang dở (cancel context)
```

Trong khoảng `[regular_duration, regular_duration + gracefulStop]`:

```text
- cal() đã sinh xong các slot trong stages, không còn slot mới
- iteration nào đã start từ trước được phép finish
- TryRunIteration() vẫn trả true nếu có VU rảnh, NHƯNG ch của cal() đã đóng
  -> không có slot nào để fire nữa, hiệu quả là chỉ chờ iteration đang chạy
```

Ví dụ:

```text
total_regular_duration = 6s
gracefulStop = 2s

executor_wall_time_after_start_max = 8s
```

Header k6 in:

```text
1 scenario, 6 max VUs, 8s max duration (incl. graceful stop)
```

Khác `ramping-vus`:

```text
ramping-vus có thêm gracefulRampDown cho mỗi lần giảm VU giữa timeline
ramping-arrival-rate KHÔNG có gracefulRampDown
  vì rate giảm không yêu cầu "trả VU" - VU đã active vẫn ngồi đợi slot kế tiếp
```

Tức là cả `regular_duration` và `gracefulStop` ở đây dùng đúng theo `BaseConfig`:

```text
gracefulStop = default 30s nếu không set
```

### 3.8. `stage.target` = rate target tại CUỐI stage

Đây là điểm dễ nhầm nhất khi mới đọc. Quy tắc:

```text
stage.target NGHĨA là rate (iterations/timeUnit) MUỐN ĐẠT tại CUỐI stage đó
không phải rate trung bình của stage
không phải rate cộng thêm
không phải số iteration của stage
```

Đọc từ `cal()` (`ramping_arrival_rate.go:253-282`):

```go
for _, stage := range varc.Stages {
    to = float64(stage.Target.ValueOrZero()) / timeUnit
    dur = float64(stage.Duration.Duration)
    if from != to { // ramp up/down
        endCount += dur * ((to-from)/2 + from)  // diện tích hình thang
        ...
    } else {
        endCount += dur * to                     // diện tích chữ nhật
        ...
    }
    doneSoFar = endCount
    from = to                                     // QUAN TRỌNG: from kế tiếp = to hiện tại
    stageStart += stage.Duration.TimeDuration()
}
```

Ý nghĩa của `from`:

```text
stage 1: from = startRate / timeUnit_seconds   (rate lúc t=0)
stage 2: from = stage[0].target / timeUnit     (rate lúc cuối stage 1 = đầu stage 2)
stage 3: from = stage[1].target / timeUnit     (rate lúc cuối stage 2 = đầu stage 3)
...
```

Dòng `from = to` ở cuối loop là chìa khóa: rate đầu stage i+1 chính là `to` của stage i,
tức là `stage[i].target / timeUnit`.

Rate được rải đều tuyến tính giữa các stage giống `ramping-vus` rải VU đều giữa các stage:

```text
ramping-vus     : VU rải đều giữa fromVUs -> stage.target trong stage.duration
ramping-arrival : rate rải đều giữa fromRate -> stage.target/timeUnit trong stage.duration
```

Ví dụ:

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 4 },  // stage 1
  { duration: "2s", target: 1 },  // stage 2
  { duration: "2s", target: 3 },  // stage 3
]
```

Đường rate(t):

```text
t=0s : rate = 2/s         (= startRate)
t=2s : rate = 4/s         (= stage[0].target, cuối stage 1)
t=4s : rate = 1/s         (= stage[1].target, cuối stage 2)
t=6s : rate = 3/s         (= stage[2].target, cuối stage 3)

trong stage 1 (t=0..2): rate đi tuyến tính 2 -> 4
trong stage 2 (t=2..4): rate đi tuyến tính 4 -> 1
trong stage 3 (t=4..6): rate đi tuyến tính 1 -> 3
```

Hình mô tả nhanh:

```text
rate
4 |     x
3 |    / \           x
2 | x    \         /
1 |       x       /
0 +-------+-------+-------+----> t
  0       2       4       6
       stage1  stage2  stage3
```

Đừng đọc nhầm:

```text
SAI : "stage.target = 4 nghĩa là stage chạy ở rate 4/s từ đầu"
ĐÚNG: "stage.target = 4 nghĩa là rate đạt 4/s ở CUỐI stage, đi từ rate trước đó"

SAI : "startRate là rate trung bình ban đầu"
ĐÚNG: "startRate là rate tại đúng t=0"
```

Edge case `from == to` (rate giữ nguyên):

```text
nhánh else trong cal(): endCount += dur * to (không phải hình thang)
=> stage giữ rate cố định trong toàn bộ stage.duration
```

Đây là cách hợp lệ để tạo "plateau" trong giữa timeline ramping.

## 3.9. Checklist core đã lọc cho `ramping-arrival-rate`

Phần này là phụ lục đối chiếu code thật. Nếu mới học, đọc cột `Hành vi thật` trước; cột `Core`
chỉ để biết chỗ đó nằm ở file nào.

| Core | Hành vi thật | Ý nghĩa khi đọc bài |
| --- | --- | --- |
| `ramping_arrival_rate.go:Validate()` | kiểm tra `startRate`, `timeUnit`, `stages`, `preAllocatedVUs`, `maxVUs` | `stages` bắt buộc; `maxVUs` nếu bỏ qua thì core dùng bằng `preAllocatedVUs`. |
| `ramping_arrival_rate.go:GetDescription()` | mô tả theo max stage rate và tổng stage duration | `Up to X iterations/s for Y over N stages ...` là peak stage rate, không phải rate cố định. |
| `ramping_arrival_rate.go:GetExecutionRequirements()` | reserve `preAllocatedVUs` và `maxVUs - preAllocatedVUs`; end offset = `sumStagesDuration + gracefulStop` | Planned VUs có sẵn từ đầu; unplanned quota chỉ là phần thêm. |
| `ramping_arrival_rate.go:cal()` | sinh mốc start theo diện tích dưới đường rate | Ramping stage không có `ticker_period` cố định toàn run; slot cách nhau thay đổi theo rate. |
| `ramping_arrival_rate.go:Run()` | tới mốc thì `TryRunIteration()`; fail thì drop; còn quota thì start unplanned VU ở background | Drop là theo slot hiện tại, không retry slot cũ. |
| `activeVUPool.TryRunIteration()` | non-blocking | Không có VU rảnh là false ngay. |
| `activeVUPool.AddVU()` | 1 VU có thể xử lý nhiều iteration nối tiếp khi pool nhận request mới | VU chỉ là worker, không phải quota. |
| `internal/execution/scheduler.go:emitVUsAndVUsMax()` | `vus`/`vus_max` sample mỗi giây | `vus_max` là initialized VUs tại thời điểm sample, không phải configured `maxVUs`. |
| `internal/js/runner.go:RunOnce()` + `iterationSamples()` | `iterations` và `iteration_duration` emit sau full iteration | `iteration_duration` không bao gồm sleep bù `minIterationDuration`. |
| `helpers.go:getDurationContexts()` | `regDurationCtx` chặn start mới; `maxDurationCtx` là regular + gracefulStop | Hết stage timeline thì không start mốc mới nữa; chỉ chờ finish trong grace. |

## 3.10. Demo stage curve đủ VU

Ví dụ schedule:

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 4 },
  { duration: "2s", target: 1 },
  { duration: "2s", target: 3 },
]
```

Rate theo stage:

```text
0-2s: 2 -> 4 iterations/s
2-4s: 4 -> 1 iterations/s
4-6s: 1 -> 3 iterations/s
```

Số scheduled starts theo diện tích:

```text
stage 1: 2s * (2 + 4)/2 = 6
stage 2: 2s * (4 + 1)/2 = 5
stage 3: 2s * (1 + 3)/2 = 4
total = 15 scheduled iterations
```

Peak rate:

```text
lambda_peak = 4 iterations/s
```

S sizing:

```text
required_vus_min_peak ~= ceil(4 * W_effective)
```

Nếu `W_effective = 0.4s` (ví dụ workload kiểu `sleep(0.4)`):

```text
required_vus_min_peak ~= 2 VUs
```

Nếu `W_effective = 1.76s`:

```text
required_vus_min_peak ~= 8 VUs
```

### 3.11. Demo thiếu VU và dropped_iterations

Ví dụ peak lên cao hơn capacity:

```js
startRate: 4,
timeUnit: "1s",
stages: [
  { duration: "3s", target: 10 },
]
```

Nếu workload có:

```text
W_effective = 0.6s
```

thì peak cần:

```text
required_vus_min_peak ~= ceil(10 * 0.6) = 6 VUs
```

Nếu chỉ có:

```text
preAllocatedVUs: 2,
maxVUs: 4,
```

thì peak stage có thể rơi vào `dropped_iterations`. Core sẽ:

```text
push dropped_iterations
và nếu còn quota unplanned thì bắt đầu tạo VU mới ở background
```

Mốc hiện tại vẫn có thể đã drop xong trước khi VU mới sẵn sàng.

### 3.12. Demo preAllocatedVUs vs maxVUs

```text
preAllocatedVUs = VU chuẩn bị sẵn từ đầu
maxVUs = trần tổng VU, bao gồm unplanned quota
```

Nếu:

```text
maxVUs = preAllocatedVUs
```

thì không còn đường tạo thêm VU runtime.

Nếu:

```text
maxVUs > preAllocatedVUs
```

thì còn `maxVUs - preAllocatedVUs` VU có thể sinh thêm khi thiếu worker.

Kết luận:

```text
preAllocatedVUs là sizing để giảm drop
maxVUs là ceiling để tránh vượt trần
```

### 3.13. Demo QuickPizza `2 requests / iteration`

Nếu iteration là QuickPizza kiểu:

```text
2 HTTP requests
2 checks
sleep(1)
```

thì:

```text
W_effective thường lấy gần đúng từ iteration_duration.avg của một run sạch
```

Sau đó:

```text
estimated_http_reqs_rate_if_no_branch = 2 * actual_summary_iterations_rate
estimated_checks_total_rate_if_no_branch = 2 * actual_summary_iterations_rate
```

Nếu peak rate cao hơn `ceil(lambda_peak * W_effective)`, test sẽ cần nhiều VU hơn.
Nếu preAllocatedVUs thấp hơn peak demand, có thể xuất hiện unplanned VU hoặc drop.

### 3.14. Bước nhảy của rate trong 1 stage

Câu hỏi: trong 1 stage `ramp 2/s -> 4/s trong 2s`, các slot start xuất hiện ở đâu?
Có phải đều cách nhau 0.25s như `constant-arrival-rate` không?

Trả lời ngắn:

```text
KHÔNG. Khoảng cách giữa các slot thay đổi theo curve của rate(t):
  - rate cao  -> slot dày hơn (gap nhỏ)
  - rate thấp -> slot thưa hơn (gap lớn)

Slot KHÔNG được tính bằng "rate trung bình rồi chia đều"
Slot được tính bằng "lúc nào diện tích tích lũy = i"
```

#### 3.14.1. Công thức từ core

Đọc `cal()` (`ramping_arrival_rate.go:253-282`):

```go
if from != to {  // ramp up/down
    endCount += dur * ((to-from)/2 + from)
    for ; i <= endCount; i += float64(next()) {
        x := (from*dur - noNegativeSqrt(dur*(from*from*dur+2*(i-doneSoFar)*(to-from)))) / (from - to)
        ...
        ch <- time.Duration(x) + stageStart
    }
} else {
    endCount += dur * to
    for ; i <= endCount; i += float64(next()) {
        ch <- time.Duration((i-doneSoFar)/to) + stageStart
    }
}
```

Hai nhánh:

**Nhánh `from == to` (rate cố định trong stage):**

```text
x = (i - doneSoFar) / to
slot thứ k cách t=stageStart đúng (k - doneSoFar) / to giây
gap đều: 1 / to giây giữa hai slot liên tiếp
```

Đây giống `constant-arrival-rate`: rate đều thì gap đều.

**Nhánh `from != to` (rate ramp tuyến tính):**

```text
diện tích từ stageStart đến điểm x bằng:
  area(x) = from * x + (to - from) / (2 * dur) * x^2

slot thứ k xảy ra khi area(x_k) = k - doneSoFar (chuẩn hóa lại từ đầu stage):
  từ phương trình bậc 2 -> giải được x_k

công thức code:
  x = (from*dur - sqrt(dur*(from^2*dur + 2*(i - doneSoFar)*(to - from)))) / (from - to)
```

Cách hiểu: gap giữa hai slot liên tiếp tỉ lệ nghịch với rate(t) tại đúng thời điểm đó.

```text
gap_k ~= 1 / rate(t_k)

rate(t) = from + (to - from) * (t / dur) trong stage
=> nếu rate cao gấp đôi tại t này, gap chỉ còn nửa
```

#### 3.14.2. Ví dụ: stage `ramp 2 -> 4 trong 2s`

```text
from = 2/s, to = 4/s, dur = 2s
endCount = 2 * ((4-2)/2 + 2) = 2 * 3 = 6 slots trong stage này

doneSoFar = 0 (giả sử stage 1)

slot 1 (i=1): x = (2*2 - sqrt(2*(2*2*2 + 2*1*2))) / (2-4)
            = (4 - sqrt(2*12)) / -2
            = (4 - sqrt(24)) / -2
            ≈ (4 - 4.899) / -2
            ≈ 0.449s    (gap_0_1 ≈ 0.449)

slot 2 (i=2): x ≈ 0.828s   (gap_1_2 ≈ 0.379)
slot 3 (i=3): x ≈ 1.162s   (gap_2_3 ≈ 0.334)
slot 4 (i=4): x ≈ 1.464s   (gap_3_4 ≈ 0.302)
slot 5 (i=5): x ≈ 1.742s   (gap_4_5 ≈ 0.278)
slot 6 (i=6): x = 2.000s   (gap_5_6 ≈ 0.258)
```

So với "đều trung bình":

```text
nếu chia đều 6 slot trong 2s -> mỗi slot 0.333s
NHƯNG cal() rải theo curve:
  đầu stage rate=2/s -> gap đầu ~0.5s
  cuối stage rate=4/s -> gap cuối ~0.25s
```

Verify đơn vị:

```text
rate(0) = 2/s -> gap ~ 1/2 = 0.5s ✓ (slot 1 ở 0.449s)
rate(2) = 4/s -> gap ~ 1/4 = 0.25s ✓ (gap cuối ≈ 0.258s)
```

#### 3.14.3. Hai trường hợp đặc biệt

```text
1) rate giảm về 0 trong stage (to = 0)
   nhánh from != to vẫn áp dụng
   slot ngày càng thưa, vì rate giảm
   nếu endCount < i, stage này không tạo slot nào nữa

2) rate ramp lên TỪ 0 (from = 0)
   tại t=0 rate=0 -> không có slot ở t=0
   slot đầu tiên xuất hiện khi diện tích đủ >= 1

3) rate hold (from = to)
   nhánh else, gap đều = 1/rate
```

#### 3.14.4. So sánh nhịp `cal()` của 3 executor

| Executor | Cách tạo slot | Gap |
| --- | --- | --- |
| `constant-arrival-rate` | rate cố định toàn run | đều: `1/rate` |
| `ramping-arrival-rate` (stage hold) | rate = stage.target, `from == to` | đều: `1/rate` |
| `ramping-arrival-rate` (stage ramp) | rate(t) tuyến tính | thay đổi theo `1/rate(t)` |

#### 3.14.5. Hệ quả khi sizing

Vì gap không đều, nhìn `lambda_peak` mới đúng cho sizing:

```text
required_vus_min_peak = ceil(lambda_peak * W_effective)
```

Không nên lấy `average_target_rate` để sizing. Lấy nhịp đỉnh.

### 3.15. Hai trục độc lập: stage timeline và VU iteration timeline

Đây là đặc thù của open model: phải tách rất rõ 2 trục thời gian khác nhau.
Trong `ramping-vus` (closed) đã có 2 trục `stage timeline` và `VU iteration timeline`.
`ramping-arrival-rate` cũng có 2 trục đó, nhưng vai trò của VU khác hẳn.

#### 3.15.1. Định nghĩa 2 trục

```text
Trục 1 — STAGE timeline (do CONFIG quyết định):
  rate(t) thay đổi theo stages
  stage 1: t=0..2s, rate ramp 2 -> 4
  stage 2: t=2..4s, rate ramp 4 -> 1
  stage 3: t=4..6s, rate ramp 1 -> 3
  cal() sinh ra danh sách slot dựa trên rate(t)

Trục 2 — VU iter timeline (do CODE và POOL quyết định):
  mỗi VU có dòng đời riêng:
    - rảnh -> nhận slot từ pool -> chạy iter -> rảnh lại
  iter_duration = thời gian default function chạy
  số VU active = số VU đang bận xử lý iter (từ activeVUPool)
```

Trong `ramping-vus`:

```text
VU = active VU theo plannedVUs từ stages (trùng với "đang loop iter")
1 VU loop iter của RIÊNG nó
=> stage.target trực tiếp quyết định bao nhiêu VU đang chạy iter
```

Trong `ramping-arrival-rate`:

```text
VU = worker được activate, đang chờ slot hoặc đang chạy iter
Slot từ cal() được "giao" cho VU rảnh qua kênh p.iterations
1 VU không loop iter của riêng nó - nó chỉ chờ slot mới
=> stage.target quyết định nhịp slot, không quyết định số VU active
=> số VU active = số iter đang chạy đồng thời tại thời điểm sample
```

#### 3.15.2. Slot fire trên trục 1, VU bận trên trục 2

Đọc `ramping_arrival_rate.go:455-503` (vòng `for nextTime := range ch`):

```go
for nextTime := range ch {                  // trục 1: nhận slot từ cal()
    ...
    if vusPool.TryRunIteration() {          // gửi slot vào kênh -> VU rảnh nhận
        continue
    }
    // không có VU rảnh -> drop
    metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
        TimeSeries: ... DroppedIterations ...,
        Value: 1,
    })
    ...
}
```

`activeVUPool.TryRunIteration()` (`ramping_arrival_rate.go:527-534`):

```go
func (p *activeVUPool) TryRunIteration() bool {
    select {
    case p.iterations <- struct{}{}:        // có VU rảnh nhận -> true
        return true
    default:                                  // không có VU rảnh -> false
        return false
    }
}
```

`activeVUPool.AddVU()` (`ramping_arrival_rate.go:545-561`) là worker loop của 1 VU:

```go
go func() {
    ...
    for range p.iterations {
        atomic.AddUint64(&p.running, uint64(1))
        p.execState.ModCurrentlyActiveVUsCount(+1)
        runfn(ctx, avu)                      // chạy 1 iter
        p.execState.ModCurrentlyActiveVUsCount(-1)
        atomic.AddUint64(&p.running, ^uint64(0))
    }
}()
```

Tách vai trò:

```text
- Slot đến giờ trên trục 1 -> bằng cách push vào p.iterations
- VU rảnh trên trục 2 đang chờ ở `for range p.iterations`
- Match được -> VU chạy iter
- Không match -> drop_iterations += 1
```

Đây giống một mô hình producer-consumer:

```text
Producer: cal() + Run() loop    -> sinh slot tại đúng giờ
Consumer: pool worker per VU    -> tiêu thụ slot khi rảnh
```

#### 3.15.3. Khi rate cao mà VU bận

Đây là tình huống tiêu biểu. Giả sử:

```text
stage: rate ramp 2 -> 10 trong 5s
preAllocatedVUs = 4
maxVUs = 4 (không có quota unplanned)
W_effective = 0.6s

required_vus_min_peak = ceil(10 * 0.6) = 6 VUs
```

Tại đỉnh stage, rate = 10/s nhưng pool chỉ có 4 VU:

```text
Trục 1 (slots) : đang fire ~10 slot/s (gap ~0.1s)
Trục 2 (VUs)   : 4 VU đều bận chạy iter (mỗi iter ~0.6s)

mỗi 0.1s có 1 slot -> push vào kênh
mỗi 0.6s có 1 VU rảnh

=> trong 0.6s, fire 6 slot, chỉ 1 VU rảnh nhận -> 5 slot drop
=> 1 - 4/(10*0.6) = 1 - 0.667 = 33% drop ngay tại pool
```

`drop_rate` ước lượng:

```text
drop_rate(t) = max(0, lambda_current - capacity_with_M_vus)
             = max(0, 10 - 4/0.6)
             = max(0, 10 - 6.67)
             ≈ 3.33 drops/s
```

#### 3.15.4. Khi rate thấp xen rate cao

`ramping-arrival-rate` có thể có cả đoạn nhanh và đoạn chậm trong 1 run:

```text
stage 1: rate ramp 2 -> 10 trong 5s     (peak)
stage 2: rate hold 2 trong 5s            (rest)
stage 3: rate ramp 2 -> 10 trong 5s     (peak lần 2)
```

Trên trục 1, slots fire dày hơn ở stage 1 và 3, thưa hơn ở stage 2:

```text
slots/s trung bình:
  stage 1 ramp:  6/s    (avg)
  stage 2 hold:  2/s
  stage 3 ramp:  6/s    (avg)
```

Trên trục 2, VU active sẽ:

```text
- spike lên gần maxVUs ở các đỉnh stage 1 và 3
- xuống còn 1-2 VU bận ở stage 2
- nhưng pool VẪN giữ đủ preAllocatedVUs sẵn sàng
  (không "trả về pool" theo timeline, vì closed model logic không áp dụng)
```

Đây là khác biệt căn bản với `ramping-vus`:

```text
ramping-vus           : VU active đi xuống đúng theo stage.target (closed model)
ramping-arrival-rate  : VU active đi theo nhu cầu rate, vẫn giữ ≥ preAllocated trong pool
```

#### 3.15.5. Hệ quả thực tế

```text
1) Đừng đo "số VU sample" của arrival-rate như đo concurrency cố định
   nó dao động theo rate(t) và iter_duration

2) Sizing phải nhìn lambda_peak, không phải average_target_rate
   peak có thể ngắn nhưng đủ để bùng dropped_iterations

3) Đừng kỳ vọng "rate xuống thì VU active xuống ngay"
   VU đang chạy iter còn lâu mới xong, vẫn được tính active đến lúc finish

4) preAllocatedVUs đủ ở t=0 không có nghĩa là đủ ở peak
   nếu peak ở giữa scenario, phải tính dùng W_effective của lúc đó
```

### 3.16. Spawn timing của unplanned VU và `dropped_iterations`

Mục 3.15 đã giới thiệu pool VU. Mục này nói chi tiết hơn về timing:
khi nào core spawn unplanned VU, dropped_iterations đếm vào lúc nào,
và tại sao 1 slot đến giờ có thể vừa drop vừa kích hoạt spawn.

#### 3.16.1. Đọc rất chậm đoạn `Run()` xử lý slot

Đọc `ramping_arrival_rate.go:455-503`:

```go
for nextTime := range ch {                       // (A) nhận slot từ cal()
    select {
    case <-regDurationDone:
        return nil                                // hết regular_duration -> stop
    default:
    }
    atomic.StoreInt64(&tickerPeriod, int64(nextTime-prevTime))
    prevTime = nextTime
    b := time.Until(start.Add(nextTime))
    if b > 0 {                                    // (B) chờ đến mốc nextTime
        timer.Reset(b)
        select {
        case <-timer.C:
        case <-regDurationDone:
            return nil
        }
    }

    if vusPool.TryRunIteration() {               // (C) thử match VU rảnh
        continue                                   // có VU -> chạy iter, qua slot kế
    }

    // (D) không có VU rảnh
    metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
        TimeSeries: metrics.TimeSeries{
            Metric: varr.executionState.Test.BuiltinMetrics.DroppedIterations,
            Tags:   metricTags,
        },
        Time:  time.Now(),
        Value: 1,                                  // dropped_iterations += 1
    })

    // (E) thử trigger background spawn unplanned VU
    if remainingUnplannedVUs == 0 {
        if !shownWarning {
            varr.logger.Warningf("Insufficient VUs, reached %d active VUs and cannot initialize more", maxVUs)
            shownWarning = true
        }
        continue
    }

    select {
    case makeUnplannedVUCh <- struct{}{}:
        remainingUnplannedVUs--
    default:                                       // đã có signal trong queue rồi
    }
}
```

5 bước:

```text
A. nhận slot kế tiếp từ kênh do cal() đẩy vào
B. chờ wall-clock đến mốc của slot
C. thử push vào pool: có VU rảnh không?
D. nếu không có -> emit dropped_iterations metric
E. nếu còn quota unplanned -> báo background goroutine init thêm VU
```

#### 3.16.2. Background spawner

Đọc `ramping_arrival_rate.go:419-436`:

```go
remainingUnplannedVUs := maxVUs - preAllocatedVUs
makeUnplannedVUCh := make(chan struct{})
defer close(makeUnplannedVUCh)
go func() {
    defer close(returnedVUs)

    for range makeUnplannedVUCh {
        varr.logger.Debug("Starting initialization of an unplanned VU...")
        initVU, err := varr.executionState.GetUnplannedVU(maxDurationCtx, varr.logger)
        if err != nil {
            varr.logger.WithError(err).Error("Error while allocating unplanned VU")
        } else {
            varr.logger.Debug("The unplanned VU finished initializing successfully!")
            activateVU(initVU)                     // VU mới active, vào pool
        }
    }
}()
```

Spawner là goroutine riêng. Timing thực tế:

```text
1) Slot fire ở t1, pool đầy   -> drop_iterations++ và signal background
2) Background goroutine bắt signal, gọi GetUnplannedVU()
3) GetUnplannedVU() init JS context: parse module, tạo runtime, tạo VU instance
   thời gian này tốn vài ms tới vài chục ms tùy kích thước module
4) activateVU() đẩy VU vào pool, kèm worker loop riêng
5) Slot fire ở t2 > t1 -> pool có thêm VU mới -> không drop (nếu chưa quá tải)
```

Tóm gọn:

```text
unplanned VU chỉ giúp các slot SAU nó sẵn sàng
slot lúc trigger spawn vẫn bị drop
```

#### 3.16.3. Quota unplanned

Quota tính một lần khi `Run()` start:

```text
remainingUnplannedVUs = maxVUs - preAllocatedVUs (tại t=0 của scenario)
```

Mỗi lần fire signal vào `makeUnplannedVUCh`:

```text
remainingUnplannedVUs--
```

Khi cạn:

```text
remainingUnplannedVUs == 0
=> không signal nữa, log "Insufficient VUs, reached N active VUs and cannot initialize more" 1 lần
=> các slot drop tiếp theo chỉ tăng dropped_iterations, không trigger gì
```

Quota KHÔNG hồi phục:

```text
- VU đã unplanned spawn không "trả lại quota" khi finish iter
- VU đó tiếp tục là worker trong pool đến hết scenario
- pool max size = preAllocatedVUs + (số đã spawn) <= maxVUs
```

#### 3.16.4. Race condition của signal

Đọc lại bước (E):

```go
select {
case makeUnplannedVUCh <- struct{}{}:
    remainingUnplannedVUs--
default:                                  // already a pending signal
}
```

`makeUnplannedVUCh` là unbuffered channel. Nếu background goroutine
đang init VU mới, signal kế tiếp sẽ rơi vào nhánh `default` và bỏ qua:

```text
- không tăng counter remainingUnplannedVUs (vẫn đếm như cũ)
- không trigger spawn thêm (vì đã có 1 spawn đang in-flight)
- mục đích: tránh spam spawn 100 VU cùng lúc khi 100 slot drop liên tiếp
```

Hệ quả thực tế:

```text
nếu rate đột ngột spike và pool thiếu nhiều VU:
  - slot 1 drop, signal spawn VU#1 (background goroutine bắt đầu init)
  - slot 2 drop, signal vào nhánh default (đã có spawn pending)
  - slot 3 drop, signal vào nhánh default
  - ...
  - sau khi VU#1 init xong và vào pool, vòng lặp sẵn sàng nhận signal mới
  - slot N drop tiếp theo signal vào kênh, spawn VU#2

=> spawn rate giới hạn bởi tốc độ init JS context, không phải tốc độ drop
=> đây là lý do khi peak quá đột ngột, drop vẫn xảy ra dù còn quota unplanned
```

#### 3.16.5. Đếm `dropped_iterations`

Metric đếm:

```text
- mỗi slot không match được VU rảnh tại thời điểm nó fire = +1
- không retry slot cũ
- không đếm lùi
```

Đọc summary:

```text
dropped_iterations....: N  X/s
```

`X/s` là tốc độ drop trung bình tính trên `summary_runtime_base`.
Nó là **rate trung bình của cả run**, không phải tại 1 thời điểm cụ thể.

Để biết drop tập trung ở đoạn nào, cần dùng:

```text
- output xuất ra time series (csv, prometheus, ...)
- xem dropped_iterations tích lũy theo thời gian
- so với rate(t) của stages để định vị đoạn quá tải
```

#### 3.16.6. Tổng hợp 4 case khi 1 slot fire

| Case | Pool có VU rảnh? | Còn quota unplanned? | Kết quả |
| --- | --- | --- | --- |
| 1 | có | (không quan trọng) | iter chạy, không drop |
| 2 | không | có | drop +1, signal spawn unplanned (nếu chưa pending) |
| 3 | không | không | drop +1, log warning 1 lần |
| 4 | không | có, nhưng spawn pending | drop +1, không signal mới |

### 3.17. `preAllocatedVUs` vs `maxVUs`: rate đạt đỉnh ở đâu?

`constant-arrival-rate` chỉ có 1 con số rate. Còn `ramping-arrival-rate`
có rate(t) thay đổi, nên câu hỏi sizing phức tạp hơn.

#### 3.17.1. Quy tắc nhanh

```text
preAllocatedVUs >= ceil(lambda_peak * W_effective)
  => mọi slot ở peak đều có VU rảnh (no drop)

preAllocatedVUs < ceil(lambda_peak * W_effective)
  nhưng maxVUs >= ceil(lambda_peak * W_effective)
  => slot ban đầu ở peak có thể drop, sau đó unplanned VU spawn dần
  => có drop tạm thời, ổn định lại sau

maxVUs < ceil(lambda_peak * W_effective)
  => peak luôn drop, không cứu được
```

Trong đó:

```text
lambda_peak = max(startRate, mọi stage.target) / timeUnit_seconds
W_effective ~= iteration_duration của 1 iter điển hình
```

#### 3.17.2. Rate đạt đỉnh ở đâu trong stages?

Vì rate ramp tuyến tính giữa các stage (mục 3.8), rate cao nhất chỉ có thể
xuất hiện tại các "khớp nối" giữa stage:

```text
lambda_peak = max(
  startRate,                  (đầu stage 1)
  stage[0].target,            (cuối stage 1 = đầu stage 2)
  stage[1].target,            (cuối stage 2 = đầu stage 3)
  ...
  stage[N-1].target           (cuối stage N)
) / timeUnit_seconds
```

Đọc từ `ramping_arrival_rate.go:76-79`:

```go
maxUnscaledRate := getStagesUnscaledMaxTarget(varc.StartRate.Int64, varc.Stages)
maxArrRatePerSec, _ := getArrivalRatePerSec(
    getScaledArrivalRate(et.Segment, maxUnscaledRate, varc.TimeUnit.TimeDuration()),
).Float64()
```

Và `helpers.go:26-34`:

```go
func getStagesUnscaledMaxTarget(unscaledStartValue int64, stages []Stage) int64 {
    result := unscaledStartValue
    for _, s := range stages {
        if s.Target.Int64 > result {
            result = s.Target.Int64
        }
    }
    return result
}
```

Function này lấy `max(startRate, mọi stage.target)`. Đây chính là `lambda_peak`
(trước khi chia cho `timeUnit`).

#### 3.17.3. Ví dụ sizing

Config 1: peak ở giữa, đủ VU

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 8 },   // peak = 8/s ở t=2s
  { duration: "2s", target: 8 },   // hold 8/s
  { duration: "2s", target: 0 },   // ramp xuống
],
preAllocatedVUs: 6,
maxVUs: 6,
```

Với `W_effective = 0.5s`:

```text
required_vus_min_peak = ceil(8 * 0.5) = 4 VUs
preAllocatedVUs = 6 >= 4 -> đủ, không drop
```

Config 2: peak ngắn, dùng unplanned

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "1s", target: 20 },  // peak ngắn 20/s ở t=1s
  { duration: "5s", target: 4 },   // ramp xuống ổn định 4/s
],
preAllocatedVUs: 4,
maxVUs: 12,
```

Với `W_effective = 0.5s`:

```text
required_vus_min_peak = ceil(20 * 0.5) = 10 VUs
preAllocatedVUs = 4 < 10 -> drop ban đầu
maxVUs = 12 >= 10 -> sau khi spawn 6+ VU sẽ ổn

NHƯNG: spike 1s là rất ngắn, init unplanned VU mất ~50ms-200ms
=> drop rate ban đầu cao, đến khi pool đủ VU thì spike đã qua
=> dropped_iterations sẽ thấy số đáng kể
```

Config 3: maxVUs không đủ

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "5s", target: 50 },  // peak 50/s
],
preAllocatedVUs: 4,
maxVUs: 8,
```

Với `W_effective = 0.5s`:

```text
required_vus_min_peak = ceil(50 * 0.5) = 25 VUs
maxVUs = 8 << 25 -> peak luôn drop nhiều
log: "Insufficient VUs, reached 8 active VUs and cannot initialize more"
```

#### 3.17.4. Khi nào dùng unplanned an toàn?

```text
- peak duration đủ DÀI để spawner kịp tạo VU mới
  ví dụ peak hold > 1s và rate ramp lên dần dần
- W_effective không quá ngắn
  iter rất ngắn -> rate cần rất nhiều VU -> spawner không kịp
- không cần baseline drop = 0
  chấp nhận một ít drop ban đầu, ổn định sau
```

Khi nào nên ép `preAllocatedVUs = maxVUs` từ đầu:

```text
- peak ngắn (vài giây trở xuống)
- không chịu được drop tại peak
- W_effective biến động lớn (DB chậm bất chợt) -> sizing tail không spawner
```

#### 3.17.5. Hệ quả cho test report

```text
- maxVUs trong header = "trần planned + unplanned" của executor
  k6 init đủ maxVUs instance ngay từ init phase (giống ramping-vus)
- vus_max trong summary = số VU đã initialized lúc sample
  ban đầu = preAllocatedVUs, có thể tăng lên đến maxVUs khi unplanned spawn
- vus trong summary = số VU đang chạy iter (active)
  dao động theo rate(t) và iter_duration
```

Đừng đọc nhầm `vus_max` thành `maxVUs`. Chúng có thể trùng lúc kết thúc nếu
đã spawn hết quota, nhưng `vus_max` là Gauge sample, có thể nhỏ hơn nếu chưa
spawn hết.

### 3.18. `gracefulStop` ở cuối scenario `ramping-arrival-rate`

`ramping-arrival-rate` có `gracefulStop` (default 30s) nhưng KHÔNG có
`gracefulRampDown` như `ramping-vus`. Lý do là rate giảm không yêu cầu
"trả VU" trong runtime - VU đang active vẫn ngồi đợi slot kế tiếp.

#### 3.18.1. Đọc rất chậm 2 context

`Run()` (`ramping_arrival_rate.go:338`):

```go
startTime, maxDurationCtx, regDurationCtx, cancel := getDurationContexts(
    parentCtx, duration, gracefulStop,
)
```

Trong đó `duration = sumStagesDuration(varr.config.Stages)` (`ramping_arrival_rate.go:317`).

Đọc `helpers.go:141-153`:

```text
maxEndTime = startTime + regular_duration + gracefulStop
maxDurationCtx hết tại maxEndTime          (cancel mọi iter đang chạy)
regDurationCtx hết tại startTime + regular_duration  (chặn slot mới)
```

Hai context này dùng ở các nơi khác nhau:

```text
regDurationCtx -> chặn loop trong Run() đẩy slot mới vào pool
                 (ramping_arrival_rate.go:447, 456-460, 468-470)
maxDurationCtx -> truyền cho activate VU làm context của iter
                 (ramping_arrival_rate.go:411)
                 hết -> iter đang chạy bị cancel -> interrupted
```

#### 3.18.2. Chuỗi sự kiện cuối scenario

Giả sử:

```text
total_regular_duration = 6s
gracefulStop = 2s
W_effective = 0.5s

stages cuối: duration=2s, target=0 (ramp xuống 0/s)
```

Timeline:

```text
t=4s    stage cuối bắt đầu, rate ramp từ X xuống 0
t=5s    rate đang ở giữa giai đoạn ramp, slot vẫn fire
t=5.9s  slot cuối có thể fire (rate gần 0 nhưng diện tích vẫn tích lũy)
t=6.0s  regular_duration hết
        -> regDurationCtx cancel
        -> Run() loop "for nextTime := range ch" thoát qua case <-regDurationDone
        -> không nhận slot mới
        -> không emit dropped_iterations cho slot bị bỏ qua
t=6.0s  trackProgress() phát hiện regDurationCtx done
        -> log "Regular duration is done, waiting for iterations to gracefully finish"
        -> progress bar status = pb.Stopping
t=6.0s..t=8.0s
        iter đang chạy được phép finish
        VU rảnh sau khi finish vẫn còn chờ, nhưng kênh p.iterations
        không có ai push vào nữa (Run() loop đã thoát)
t=8.0s  maxDurationCtx hết
        cancel iter đang dở -> +1 interrupted iteration cho mỗi iter chưa xong
        defer trong Run() chạy:
          1) <-returnedVUs   (background spawner đã đóng channel)
          2) vusPool.Close() (đóng kênh p.iterations, worker thoát loop)
          3) cancel()
          4) activeVUsWg.Wait()
```

#### 3.18.3. So với `ramping-vus`

`ramping-vus` có 2 grace:

```text
gracefulRampDown : grace giữa timeline khi giảm VU
                   (mỗi lần stage giảm số VU active)
gracefulStop     : grace cuối scenario
```

`ramping-arrival-rate` chỉ có 1 grace:

```text
gracefulStop     : grace cuối scenario
                   không có gracefulRampDown vì rate ramp xuống không tạo
                   "scale-down VU active" theo timeline
```

Điều này hợp lý vì:

```text
- rate xuống 0 không có nghĩa là VU phải được scale down
- VU đã active vẫn đang chạy iter cuối, sẽ tự rảnh khi xong
- pool không "trả về quota" trong runtime
- chỉ end-of-scenario grace mới tồn tại
```

#### 3.18.4. Tác động của `gracefulStop` lên header

Header k6 in:

```text
1 scenario, M max VUs, X max duration (incl. graceful stop)
```

Trong đó `X = total_regular_duration + gracefulStop`. Nếu set `gracefulStop=0`:

```text
X = total_regular_duration
=> mọi iter đang dở tại t=regular_duration sẽ bị cancel ngay
=> interrupted iterations có thể tăng đột biến
```

Default `30s` thường thừa so với 1 iter điển hình, nên trong môi trường demo:

```text
- iter ngắn (vài trăm ms): không bao giờ bind grace, scenario kết thúc đúng giờ
- iter dài (>30s): cần tăng gracefulStop hoặc chấp nhận interrupted
```

### 3.19. Vì sao không spawn hết `maxVUs` ngay từ đầu?

Tương tự câu hỏi trong `ramping-vus`: init phase đã init đủ `maxVUs` instance
vào pool rồi. Vậy sao không activate hết tại t=0 cho gọn?

Trả lời ngắn:

```text
init phase init đủ maxVUs instance VÀO POOL
nhưng "sẵn sàng dùng" không có nghĩa là "phải dùng ngay"

ramping-arrival-rate là open model: rate(t) điều khiển nhịp start
không phải concurrency cố định
=> chỉ activate đúng số VU = preAllocatedVUs ở t=0
=> phần còn lại ngồi sẵn trong pool, được kéo ra khi unplanned cần
```

#### 3.19.1. Đọc từ core

`Run()` chỉ activate `preAllocatedVUs` ở t=0 (`ramping_arrival_rate.go:438-445`):

```go
// Get the pre-allocated VUs in the local buffer
for range preAllocatedVUs {
    initVU, err := varr.executionState.GetPlannedVU(varr.logger, false)
    if err != nil {
        return err
    }
    activateVU(initVU)
}
```

Background spawner activate thêm khi cần (`ramping_arrival_rate.go:422-436`):

```go
go func() {
    defer close(returnedVUs)

    for range makeUnplannedVUCh {
        ...
        initVU, err := varr.executionState.GetUnplannedVU(maxDurationCtx, varr.logger)
        ...
        activateVU(initVU)
    }
}()
```

Tức là core có 2 đường activate:

```text
1) Đường preallocated: activate đủ preAllocatedVUs ngay t=0
2) Đường unplanned   : activate thêm khi slot drop và còn quota
```

#### 3.19.2. Vì sao tách 2 đường?

Lý do tương tự `ramping-vus`:

```text
- init JS context tốn (parse module, tạo runtime, sandbox, biến module-scope)
- nếu activate hết maxVUs ngay từ t=0, mọi VU đều có context runtime,
  tốn RAM mà không dùng (rate thấp ban đầu chỉ cần ít VU)
- preAllocatedVUs là số VU "chắc chắn cần" -> activate ngay để không lỡ slot
- unplanned = "chỉ activate khi thiếu" -> tiết kiệm RAM khi rate thấp
```

So với `constant-arrival-rate`:

```text
constant-arrival-rate cũng cùng pattern này:
  - activate đúng preAllocatedVUs ở t=0
  - unplanned khi cần
```

Nên không phải đặc thù riêng của `ramping-arrival-rate`. Đặc thù của
`ramping-arrival-rate` chỉ là rate(t) thay đổi, dẫn đến nhu cầu VU active
cũng thay đổi theo:

```text
- đoạn rate thấp: ít VU active đang chạy iter
- đoạn rate cao: nhiều VU active đang chạy iter
- pool vẫn giữ ≥ preAllocatedVUs sẵn sàng, không trả về
```

#### 3.19.3. Khác `ramping-vus` về timing

`ramping-vus` activate VU theo `step_interval = stageDuration / |target - fromVUs|`:

```text
ramp 1 -> 4 trong 4s -> step_interval = 4/3 ≈ 1.33s
=> VU thứ 2 activate ở t=1.33s, VU thứ 3 ở t=2.67s, VU thứ 4 ở t=4s
```

`ramping-arrival-rate` không activate theo timeline. Activate xảy ra:

```text
- preAllocatedVUs: tất cả tại t=0
- unplanned: chỉ khi slot drop và còn quota
  -> timing không đoán trước được, phụ thuộc vào sự kiện thực tế
```

Hệ quả:

```text
- với ramping-vus, biết chính xác lúc nào VU thứ N được activate
- với ramping-arrival-rate, không biết, vì phụ thuộc vào W_effective thực tế
  và rate(t) tại lúc đó
```

#### 3.19.4. Kết luận

```text
"đã có sẵn VU trong pool" != "phải activate hết ngay"

init phase   -> chuẩn bị instance JS context
preAllocated -> activate ngay từ t=0 (số VU "chắc chắn cần")
unplanned    -> activate theo nhu cầu thực tế (số VU "có thể cần")
```

Nếu muốn ép tất cả VU active từ đầu:

```text
- set preAllocatedVUs = maxVUs
- không có unplanned, mọi slot drop = "thật sự không đủ VU"
- dùng cho test cần baseline ổn định, không spike RAM
```

### 3.20. Stages trùng target rate, duration=0s, rate=0

Tương tự `ramping-vus`, các edge case stages cũng tồn tại trong `ramping-arrival-rate`,
nhưng tác động lên RATE thay vì lên VU.

#### 3.20.1. Stages trùng target rate (hold)

Khi `from == to` trong `cal()`, code rơi vào nhánh `else` (`ramping_arrival_rate.go:269-278`):

```go
} else {
    endCount += dur * to
    for ; i <= endCount; i += float64(next()) {
        select {
        case <-done:
            return
        case ch <- time.Duration((i-doneSoFar)/to) + stageStart:
        }
    }
}
```

Đây là plateau: rate giữ nguyên trong toàn bộ stage.

Ví dụ:

```js
startRate: 4,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 4 },   // hold 4/s vì from(4) == to(4)
  { duration: "2s", target: 4 },   // hold 4/s tiếp (target trùng stage trước)
  { duration: "2s", target: 8 },   // ramp 4 -> 8
]
```

Trong stage 1 và 2, gap đều = `1/4 = 0.25s`. Slot phân bố đều trong tổng 4s đầu.
Stage 1 và stage 2 chạy giống hệt nhau về behavior, chỉ khác ở `stageStart`.

Đây là cách hợp lệ để diễn tả:

```text
"giữ rate X/s trong N giây"
```

mà không cần đổi sang `constant-arrival-rate`.

#### 3.20.2. Stage `duration: 0s` (instant jump rate)

Đọc `cal()` (`ramping_arrival_rate.go:253-282`):

```go
for _, stage := range varc.Stages {
    to = float64(stage.Target.ValueOrZero()) / timeUnit
    dur = float64(stage.Duration.Duration)        // = 0 nếu duration=0s
    if from != to {
        endCount += dur * ((to-from)/2 + from)    // = 0 vì dur=0
        for ; i <= endCount; ... { ... }          // không vào loop vì endCount không tăng
    } else {
        endCount += dur * to                       // = 0
        for ; i <= endCount; ... { ... }
    }
    doneSoFar = endCount
    from = to                                      // QUAN TRỌNG: from nhảy ngay sang to
    stageStart += stage.Duration.TimeDuration()   // += 0
}
```

Hai chuyện xảy ra cùng lúc:

```text
1) `from = to` -> rate đầu stage kế tiếp nhảy sang giá trị target của stage 0s
2) stageStart không thay đổi -> stage kế tiếp bắt đầu đúng tại cùng mốc thời gian
3) endCount không tăng -> không có slot nào trong stage 0s
```

Hệ quả: stage `duration: 0s` "instant jump" rate.

Ví dụ:

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 2 },   // hold 2/s
  { duration: "0s", target: 10 },  // instant jump rate 2 -> 10
  { duration: "3s", target: 10 },  // hold 10/s
]
```

Đường rate(t):

```text
t=0..2s : rate = 2/s (hold)
t=2s    : rate đột ngột nhảy lên 10/s
t=2..5s : rate = 10/s (hold)
```

Trong khi đó stage không 0s sẽ ramp tuyến tính 2 -> 10:

```text
t=0..2s : rate = 2/s
t=2..5s : rate ramp 2 -> 10 trong 3s (gap dần nhỏ lại)
```

Bảng so sánh:

| Form | Tổng thời gian | Pattern rate |
| --- | --- | --- |
| `[{2s,2}, {0s,10}, {3s,10}]` | 5s | 2/s trong 2s rồi 10/s trong 3s |
| `[{2s,2}, {3s,10}]` | 5s | 2/s trong 2s rồi ramp 2 -> 10 trong 3s |

Khi nào dùng form 0s?

```text
- muốn diễn tả "rate spike đột ngột" thay vì ramp dần
- muốn pattern bậc thang rõ ràng
- không phải simulate organic growth
```

#### 3.20.3. Stage `target: 0` (rate giảm về 0)

Khi rate ramp xuống 0:

```text
to = 0
nhánh from != to: endCount += dur * ((0 - from)/2 + from) = dur * from / 2
=> stage này chỉ tạo dur * from / 2 slots
```

Ví dụ:

```text
from = 4/s, to = 0/s, dur = 2s
endCount += 2 * (4/2) = 4 slots
```

So với hold ở rate trung bình:

```text
nếu hold ở 2/s (avg) trong 2s -> cũng 4 slots
nhưng phân bố khác:
  hold: gap đều 0.5s
  ramp xuống 0: gap dần lớn (vì rate giảm)
```

Edge case: nếu stage tiếp theo cũng có target=0 (rate giữ 0):

```text
from = 0, to = 0
nhánh else: endCount += dur * 0 = 0 -> không slot nào
=> stage hold rate 0 nghĩa là KHÔNG CÓ SLOT trong toàn bộ stage
```

Đọc thêm tại 4.1 (edge case rate ramp xuống 0 ở giữa).

#### 3.20.4. Stage `target` âm (Validate reject)

Đọc `helpers.go:51-55`:

```go
if !s.Target.Valid {
    errors = append(errors, fmt.Errorf("stage %d doesn't have a target", stageNum))
} else if s.Target.Int64 < 0 {
    errors = append(errors, fmt.Errorf("the target for stage %d can't be negative", stageNum))
}
```

`startRate` âm cũng bị reject (`ramping_arrival_rate.go:90-92`):

```go
if varc.StartRate.Int64 < 0 {
    errors = append(errors, fmt.Errorf("the startRate value can't be negative"))
}
```

Nên không có chuyện rate âm trong runtime.

#### 3.20.5. Tổng kết

```text
- target trùng (từ stage này sang stage khác cùng giá trị) -> hold rate
- duration: 0s + target khác -> instant jump rate
- target: 0 (ramp xuống) -> stage có ít slot, gap dần lớn
- target: 0 (sau khi đã ở 0) -> stage không có slot
- target âm hoặc startRate âm -> Validate reject
```

## 4. Edge cases

### 4.1. Stage rate ramp xuống 0 ở giữa

Đây là kịch bản hay gặp khi muốn mô phỏng "tải xuống đáy rồi lại lên":

```js
startRate: 5,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 10 },  // ramp 5 -> 10
  { duration: "2s", target: 0 },   // ramp 10 -> 0 (xuống đáy)
  { duration: "2s", target: 8 },   // ramp 0 -> 8 (lên lại)
],
preAllocatedVUs: 4,
maxVUs: 8,
```

#### 4.1.1. Số slot từng stage

```text
stage 1 (5 -> 10, dur=2s): endCount += 2 * (5+10)/2 = 15 slots
stage 2 (10 -> 0, dur=2s): endCount += 2 * (10+0)/2 = 10 slots
stage 3 (0 -> 8, dur=2s):  endCount += 2 * (0+8)/2 = 8 slots

scheduled_iterations_total = 15 + 10 + 8 = 33 slots
```

#### 4.1.2. Khi rate đi qua 0 thì sao?

Trong stage 2, rate giảm từ 10 xuống 0:

```text
t=2s    rate=10/s
t=2.5s  rate=7.5/s
t=3s    rate=5/s
t=3.5s  rate=2.5/s
t=4s    rate=0/s (đáy)
```

Ở gần `t=4s`, rate gần 0 nhưng vẫn đếm diện tích tích lũy. Slot cuối stage 2
xuất hiện gần `t=4s` (chưa hẳn đúng `t=4s` vì có thể "phần lẻ" carry sang stage 3
qua `doneSoFar`).

#### 4.1.3. Rate "qua đáy" rồi lên lại

Đọc `cal()` xử lý chuyển stage 2 -> stage 3:

```text
Sau stage 2:
  doneSoFar = 25  (15 + 10)
  from = 0  (vì stage 2 to = 0)

Stage 3:
  to = 8/s
  dur = 2s
  endCount += 2 * (0+8)/2 = 8 -> endCount = 33

Vì from=0, to=8, công thức:
  x = (0*2 - sqrt(2*(0 + 2*(i-25)*8))) / (0-8)
    = -sqrt(16*(i-25)) / -8
    = sqrt(16*(i-25)) / 8
    = sqrt(i-25) / 2
```

Slot đầu tiên của stage 3 (i=26):

```text
x = sqrt(1) / 2 = 0.5s từ đầu stage 3
=> wall-clock = stageStart_stage3 + 0.5 = 4 + 0.5 = 4.5s
```

Slot thứ 2 (i=27):

```text
x = sqrt(2) / 2 ≈ 0.707s
=> wall-clock ≈ 4.707s
```

Slot tiếp theo (i=28):

```text
x = sqrt(3) / 2 ≈ 0.866s
```

Khoảng cách giảm dần (vì rate đang tăng):

```text
gap_26_27 ≈ 0.207s
gap_27_28 ≈ 0.159s
gap_28_29 ≈ 0.135s
...
gap cuối ≈ 1/8 = 0.125s
```

Đúng với rate(t):

```text
rate(t=4.5s in stage3) ≈ 0 + 8*(0.5/2) = 2/s -> gap ~ 0.5s? thực tế đo 0.207s
```

Sai số bởi vì gap không hoàn toàn = `1/rate(t_k)` mà là tích phân của rate.
Nhưng đại khái:

```text
- đầu stage 3 rate tăng từ 0 -> gap rất lớn ban đầu (slot 26 cách t=4s tới 0.5s)
- càng về cuối stage 3 rate càng cao -> gap nhỏ
```

#### 4.1.4. Hệ quả với pool VU

Trong khoảng rate xuống đáy:

```text
- ít slot fire -> ít iter mới chạy
- VU đang chạy iter cũ vẫn bận đến khi finish
- nếu W_effective lớn, pool vẫn nhiều VU bận trong vài giây sau khi rate giảm
```

Khi rate lên lại:

```text
- slot bắt đầu fire
- pool có thể đã có VU rảnh (do rate trước đó thấp)
- nhưng cũng có thể VU mới rảnh chưa kịp pickup, phụ thuộc timing
```

Quan sát: nếu rate spike lên ngay sau đáy, nguy cơ drop có thể tăng vì
VU không còn được "tách quota" theo timeline.

#### 4.1.5. Trường hợp `target: 0` ở stage cuối

Stage cuối có thể là ramp xuống 0:

```js
stages: [
  { duration: "2s", target: 10 },
  { duration: "2s", target: 0 },   // stage cuối ramp xuống 0
]
```

Khi rate xuống 0 cuối scenario:

```text
- slot cuối fire trước t=regular_duration
- regDurationCtx hết tại t=regular_duration -> Run() loop thoát
- iter đang chạy được phép finish trong gracefulStop
```

Pattern này hợp lý cho "soft landing" thay vì cắt đột ngột.

### 4.2. `timeUnit` lớn (phút) tương tác với stages

Default `timeUnit = "1s"`. Có thể đổi sang phút, giờ:

```js
startRate: 60,
timeUnit: "1m",     // 60 iter/min = 1 iter/s
stages: [
  { duration: "30s", target: 120 },   // ramp lên 120/min = 2/s
  { duration: "60s", target: 60 },    // ramp xuống 60/min = 1/s
]
```

#### 4.2.1. Cách core scale

Đọc `cal()` (`ramping_arrival_rate.go:245-247`):

```go
timeUnit = float64(varc.TimeUnit.Duration)         // nanoseconds của timeUnit
from = float64(varc.StartRate.ValueOrZero()) / timeUnit
```

Đọc kỹ:

```text
timeUnit = 1m = 60_000_000_000 nanoseconds
startRate = 60
from = 60 / 60_000_000_000 = 1e-9 (iter per nanosecond)

trong stage 1:
  to = 120 / 60_000_000_000 = 2e-9
  dur = 30s = 30_000_000_000 ns
  endCount += dur * (from+to)/2
           = 30_000_000_000 * 1.5e-9
           = 45 slots

stage 2:
  to = 60 / 60_000_000_000 = 1e-9
  dur = 60s = 60_000_000_000 ns
  endCount += 60_000_000_000 * 1.5e-9 = 90 slots

scheduled_iterations_total = 45 + 90 = 135 slots
```

Tương đương rate per second:

```text
stage 1: ramp 1/s -> 2/s trong 30s -> avg 1.5/s -> 45 slots ✓
stage 2: ramp 2/s -> 1/s trong 60s -> avg 1.5/s -> 90 slots ✓
```

#### 4.2.2. timeUnit lớn khi rate nhỏ

Nếu rate < 1 mỗi giây, `timeUnit` lớn rất hữu ích:

```js
startRate: 1,
timeUnit: "10s",    // 1 iter / 10s = 0.1/s
stages: [
  { duration: "60s", target: 6 },     // ramp 0.1/s -> 0.6/s
]
```

Ngược lại, nếu set `timeUnit: "1s"` với rate phân số:

```js
rate: 0.6,         // KHÔNG hợp lệ - rate là null.Int (số nguyên)
timeUnit: "1s",
```

Đọc `ramping_arrival_rate.go:37`:

```go
StartRate null.Int           `json:"startRate"`
```

`StartRate` là `null.Int`, không nhận float. Nên muốn rate phân số phải scale
qua `timeUnit`:

```text
1 iter / 10s = 0.1 iter/s -> dùng startRate=1, timeUnit="10s"
6 iter / 10s = 0.6 iter/s -> dùng startRate=6, timeUnit="10s"
```

#### 4.2.3. Tương tác stages

Stage duration luôn theo wall-clock thật, không scale theo `timeUnit`:

```text
stage.duration = 30s nghĩa là 30 giây thật, không phải 30 đơn vị timeUnit
stage.target  = rate đích, đo theo timeUnit
```

Nên với `timeUnit: "1m"`:

```text
stages: [{ duration: "30s", target: 120 }]
=> 30 giây, ramp tới 120 iter/phút (= 2/s)
=> KHÔNG phải 30 phút
```

#### 4.2.4. Khi nào dùng timeUnit khác 1s?

```text
- rate dạng X/phút, X/giờ (ngữ cảnh nghiệp vụ)
  ví dụ: 1000 transaction/phút
- rate < 1/s (cần phân số)
  ví dụ: 1 báo cáo / 10s = startRate=1, timeUnit="10s"
- consistency với SLO/contract dùng đơn vị phút/giờ
```

Tránh dùng `timeUnit` quá lớn (vài giờ trở lên) trong demo:

```text
- đơn vị quá lớn so với scenario duration -> rate có thể quá thấp, ít slot
- dễ nhầm khi đọc lại config
```

### 4.3. preAllocatedVUs quá thấp so với rate đỉnh

Đây là tình huống điển hình khi sizing sai. Phân tích chi tiết.

#### 4.3.1. Config minh họa

```js
startRate: 5,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 30 },   // ramp tới 30/s
  { duration: "3s", target: 30 },   // hold 30/s
  { duration: "2s", target: 0 },
],
preAllocatedVUs: 4,
maxVUs: 6,
```

Với `W_effective = 0.5s`:

```text
required_vus_min_peak = ceil(30 * 0.5) = 15 VUs
preAllocatedVUs = 4 << 15
maxVUs = 6 << 15
```

#### 4.3.2. Diễn biến khi chạy

Stage 1 (`t=0..2s`, ramp 5 -> 30):

```text
t=0s    rate=5/s, có 4 VU rảnh -> match
t=0.2s  slot 2: nếu VU 1 chưa xong (mất 0.5s), pool còn 3
t=0.5s  iter 1 xong (VU 1 rảnh), slot 3 fire (rate ~7.5/s)
...
khi rate lên 15/s vẫn chấp nhận được với 4 VU đang loop nhanh
khi rate lên 25/s -> bắt đầu drop
```

Khi drop bắt đầu:

```text
t=t1    slot fire không match -> dropped++ + signal spawn
t=t1+0.1s   spawner đang init VU#5
t=t1+0.05s   slot tiếp theo drop, signal vào default (đã pending)
t=t1+0.1s   VU#5 vào pool, có thể bắt slot kế tiếp
t=t1+0.2s   slot fire không match, signal spawn VU#6
t=t1+0.3s   VU#6 vào pool
=> sau ~0.3s pool đã full max=6, nhưng vẫn không đủ cho rate 30/s
```

Stage 2 (`t=2..5s`, hold 30/s):

```text
- pool max=6, capacity = 6/0.5 = 12 iter/s
- rate target = 30/s
- drop_rate ~= 30 - 12 = 18/s
=> 3s * 18 = 54 dropped iterations trong stage hold
```

Stage 3 (`t=5..7s`, ramp 30 -> 0):

```text
- rate giảm dần xuống 0
- drop giảm tương ứng
- gần cuối stage 3 sẽ không còn drop
```

#### 4.3.3. Summary kỳ vọng

```text
scheduled_iterations_total ≈ stages diện tích
  stage 1: 2 * (5+30)/2 = 35 slots
  stage 2: 3 * 30 = 90 slots
  stage 3: 2 * (30+0)/2 = 30 slots
  total ≈ 155 slots

completed_iterations ≈ capacity_avg * 7s = 12 * 7 ≈ 84 iter (chỉ ước lượng)
dropped_iterations ≈ 155 - 84 ≈ 71 (rough)
```

Trong run thực tế con số có thể chệch do init time, jitter, v.v.

#### 4.3.4. Cách phát hiện

Log warning là dấu hiệu sớm:

```text
WARN [Insufficient VUs, reached 6 active VUs and cannot initialize more]
```

Dấu hiệu trong summary:

```text
dropped_iterations....: 71  10.14/s
iterations............: 84  12.00/s
```

`dropped_iterations.rate` cao tương đương `iterations.rate` -> chắc chắn thiếu VU.

#### 4.3.5. Cách fix

```text
1) Tăng preAllocatedVUs lên >= ceil(lambda_peak * W_effective)
   => baseline đủ, không drop ở peak
2) Tăng maxVUs lên đủ và để preAllocatedVUs thấp hơn
   => chấp nhận drop ban đầu, ổn định sau
3) Giảm rate target nếu test mục tiêu là "X iter/s sustainable"
4) Tối ưu code iter để giảm W_effective
   => mỗi VU chạy iter nhanh hơn -> 1 VU đáp ứng nhiều slot hơn
```

Quy tắc thực tế cho QuickPizza demo (`W_effective ~ 1.7s`):

```text
30 iter/s -> required_vus = ceil(30 * 1.7) = 51 VUs
=> phải set preAllocatedVUs >= 51 hoặc maxVUs >> 51
```

### 4.4. Stages có `duration: 0s`

Mục 3.20.2 đã giới thiệu. Mục này đi sâu vào behavior thực tế.

#### 4.4.1. Use case: rate spike đột ngột

```js
startRate: 2,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 2 },    // baseline 2/s
  { duration: "0s", target: 20 },   // spike 2 -> 20 INSTANT
  { duration: "1s", target: 20 },   // hold 20/s trong 1s
  { duration: "0s", target: 2 },    // drop 20 -> 2 INSTANT
  { duration: "2s", target: 2 },    // tiếp tục 2/s
]
```

Đường rate(t):

```text
t=0..2s : rate = 2/s
t=2s    : rate đột ngột 20/s
t=2..3s : rate = 20/s
t=3s    : rate đột ngột 2/s
t=3..5s : rate = 2/s
```

Tổng thời gian:

```text
total_regular_duration = 2 + 0 + 1 + 0 + 2 = 5s
```

Stage 0s không cộng thêm thời gian.

#### 4.4.2. Slot trong stage 0s

Stage 0s **không có slot riêng**. Đọc `cal()` (mục 3.20.2):

```text
dur=0 -> endCount không tăng -> không vào loop sinh slot
```

Slot xảy ra ở các stage khác:

```text
stage 1 (2s @ 2/s): 4 slots
stage 2 (0s @ 20/s): 0 slots (instant transition)
stage 3 (1s @ 20/s): 20 slots (vì from=20, to=20, hold)
stage 4 (0s @ 2/s): 0 slots (instant transition)
stage 5 (2s @ 2/s): 4 slots

scheduled_iterations_total = 28
```

Nhưng cẩn thận: stage 5 thật ra là `from=2, to=2`, nhánh `else`, dur*to = 4 slot.
stage 1 cũng vậy: 4 slot. Stage 3 với from=20, to=20: dur*to = 20 slot. Tổng 28
khớp.

#### 4.4.3. Spawn unplanned VU không kịp

Khi spike từ 2/s lên 20/s instant, pool VU thường không kịp catch up:

```text
trước spike: rate 2/s, pool chỉ cần 2*W VUs = 1-2 VU bận
spike: rate 20/s, cần 20*W VUs = 10+ VU bận

nếu preAllocatedVUs=4, maxVUs=15:
  - tại t=2s, slot fire ở rate ~20/s
  - pool có 4 VU đã rảnh (vì rate thấp trước đó)
  - 4 slot đầu match nhanh, 4 VU bận
  - các slot tiếp theo (0.05s/slot ở 20/s) DROP vì pool full bận
  - signal spawn unplanned, init mất ~50-100ms
  - đến khi VU#5 vào pool thì đã drop ~1-2 slot
=> stage hold 1s ở 20/s sẽ có drop liên tục cho tới khi pool đủ ~10 VU
```

#### 4.4.4. So sánh với ramping dần

```js
// Form A: instant jump
{ duration: "2s", target: 2 },
{ duration: "0s", target: 20 },
{ duration: "1s", target: 20 },

// Form B: ramp dần
{ duration: "2s", target: 2 },
{ duration: "1s", target: 20 },
```

Slot khác nhau:

```text
Form A: 4 + 0 + 20 = 24 slots
Form B: 4 + 1*(2+20)/2 = 4 + 11 = 15 slots
```

VU sizing khác nhau:

```text
Form A: required_vus_peak = 20 * W ngay tại t=2s
Form B: required_vus_peak = 20 * W tại t=3s (cuối ramp)
       ramp 1s đủ thời gian cho unplanned spawner kịp catch up
```

Form A test "spike đột ngột", Form B test "tăng dần". Mỗi form mô phỏng tình
huống khác nhau.

#### 4.4.5. Stage 0s liên tiếp

Có thể có nhiều stage 0s liên tiếp:

```js
stages: [
  { duration: "1s", target: 5 },
  { duration: "0s", target: 10 },
  { duration: "0s", target: 15 },   // jump tiếp lên 15
  { duration: "0s", target: 8 },    // jump xuống 8
  { duration: "1s", target: 8 },
]
```

Mỗi stage 0s:

```text
- không tạo slot
- chỉ update from = to ngay tại cùng mốc thời gian
```

Hệ quả: `from` đi qua chuỗi 5 -> 10 -> 15 -> 8 trong cùng 1 thời điểm wall-clock,
sau đó stage cuối hold 8/s.

Trên đường rate(t), điều này nhìn như "bậc thang đổi nhiều bước":

```text
t=0..1s : rate=5/s
t=1s    : 5 -> 10 -> 15 -> 8 (3 nhảy bậc tức thì)
t=1..2s : rate=8/s
```

Tuy nhiên các nhảy bậc trung gian không có slot riêng, nên nhìn từ output thì
chỉ thấy "rate=5/s rồi đột ngột 8/s".

#### 4.4.6. Khi nào dùng?

```text
- mô phỏng "đổi rate đột ngột" (sự kiện, deploy, switch traffic)
- pattern bậc thang rõ ràng cho test
- không phải simulate organic growth (lúc đó nên dùng ramp)
```

Tránh:

```text
- duration="0s" với target trùng startRate -> no-op (không nhảy bậc)
  ví dụ startRate: 5, stages: [{ duration: "0s", target: 5 }] -> không thay đổi
```

## 5. So sánh với constant-arrival-rate

```text
constant-arrival-rate = 1 rate cố định
ramping-arrival-rate = rate đổi theo stage curve
```

Giống nhau:

```text
open model
preAllocatedVUs/maxVUs
TryRunIteration() non-blocking
dropped_iterations khi không có VU rảnh
vus/vus_max là scheduler samples
```

Khác nhau:

```text
constant-arrival-rate có 1 lambda
ramping-arrival-rate có lambda(t) theo stage
```

Nên với ramping-arrival-rate, sizing nên nhìn:

```text
lambda_peak
W_effective
```

không chỉ nhìn rate trung bình của cả timeline.

## 6. Cheat sheet

```text
startRate = rate lúc bắt đầu
stage.target = rate đích ở cuối stage
stage.duration = thời lượng stage
total_regular_duration = sum(stage.duration)
lambda_peak = max(startRate, mọi stage.target) / timeUnit
```

```text
scheduled_iterations_stage = d * (lambda_prev + lambda_next) / 2
scheduled_iterations_total = sum(scheduled_iterations_stage)
```

```text
required_vus_min_peak ~= ceil(lambda_peak * W_effective)
capacity_with_M_vus ~= M / W_effective
```

```text
W_effective ~= iteration_duration nếu không có minIterationDuration
W_effective ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

```text
actual_summary_iterations_rate = completed_iterations / summary_runtime_base
```
