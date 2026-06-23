# `ramping-arrival-rate`: tham số, ý nghĩa và công thức

File này là bản chi tiết cho executor:

```text
ramping-arrival-rate
```

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260518_01_ramping-arrival-rate-quick-index.md
```

Worked example:

```text
docs/20260518_03_ramping-arrival-rate-worked-example.md
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
  - [3.1. Đếm slot: tổng slot trong stage và rate(t)](#31-đếm-slot-tổng-số-slot-trong-1-stage-và-ratet-tại-mọi-thời-điểm)
  - [3.2. Đỉnh rate cho sizing](#32-đỉnh-rate-dùng-cho-sizing-vu-lambda_peak-vs-average_target_rate)
  - [3.3. Đếm VU cần (Little's Law)](#33-đếm-vu-cần-bao-nhiêu-vu-để-không-drop-littles-law)
  - [3.4. Rate thực tế sau test](#34-rate-thực-tế-sau-test-vs-rate-target-trong-config)
  - [3.5. dropped vs interrupted](#35-phân-biệt-dropped-vs-interrupted-chưa-start-vs-đã-start-nhưng-không-finish)
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

Cụ thể với `rate: 10, timeUnit: 1s` **(rate cố định trong 1 stage hold)**:

```text
scheduler có nghĩa vụ FIRE 10 "slot" start iter mỗi giây
slot_interval = 1/10 = 100ms (đều, vì rate không đổi)

tại mỗi slot, scheduler tìm VU rảnh để giao iter:
- có VU rảnh → VU bắt đầu iter đó (start at t)
- không có VU rảnh & còn quota maxVUs → spawn unplanned VU (start trễ chút)
- không có VU rảnh & hết quota → drop iter (+1 dropped_iterations)

rate ở đây là MỤC TIÊU của scheduler, không phải kết quả tính từ VU
```

> **Lưu ý quan trọng**: ví dụ dưới minh họa với rate **CỐ ĐỊNH** trong 1
> stage hold cho dễ hiểu (slot_interval đều 100ms). Trong
> `ramping-arrival-rate` thật sự, rate **THAY ĐỔI** theo timeline (ramp lên/xuống),
> nên `slot_interval` thay đổi theo. Section `3.1` tính tổng slot bằng
> công thức diện tích hình thang vì rate ramp tuyến tính, không phải
> đơn giản `rate × duration` như ở đây.

Ví dụ minh họa khác biệt:

> **Lưu ý**: ví dụ dưới dùng rate **CỐ ĐỊNH 10/s** cho gọn (tương đương
> stage hold hoặc `constant-arrival-rate`). Đây KHÔNG phải timeline
> thực của `ramping-arrival-rate`. Khi rate thay đổi (ramp lên/xuống),
> phải áp dụng riêng cho từng đoạn — xem `3.1` và `3.3`.

```text
Cấu hình code: sleep(0.5)  -> iter_time = 0.5s

Open (ramping-arrival-rate trong stage hold 10/s, hoặc constant-arrival-rate rate=10/s):
  10 slot/s start, mỗi slot tốn 1 VU 0.5s
  cần ≥ 5 VU để kịp (1 VU làm được 2 iter/s, 5 VU làm 10 iter/s)
  preAllocatedVUs >= 5 -> không drop
  preAllocatedVUs < 5 -> drop hoặc spawn unplanned

Closed (ramping-vus trong stage hold vus=5, hoặc constant-vus vus=5):
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

> **Lưu ý quan trọng**: phần này tính với rate **CỐ ĐỊNH** (như stage hold,
> hoặc constant-arrival-rate). Trong `ramping-arrival-rate` thật, rate
> thay đổi theo timeline → `slot_interval` cũng thay đổi → công thức
> Little's Law dưới đây chỉ áp được cho từng đoạn rate ổn định
> (ví dụ stage hold). Đối với stage ramp, dùng `lambda_peak` (xem `3.2`)
> để sizing theo mức rate cao nhất.

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

> **Little's Law là công thức steady-state**: nó giả định `λ` (rate)
> và `W` (iter_time) ổn định, hệ thống đã cân bằng. Trong
> `ramping-arrival-rate` thật, `λ(t)` biến thiên theo timeline nên áp
> dụng phải cẩn thận:
>
> ```text
> Cách ĐÚNG để sizing trong ramping:
>   1) Lấy λ_peak = max rate trong cả timeline (xem 3.2)
>   2) required_vus = ceil(λ_peak × iter_time)
>   3) preAllocatedVUs >= required_vus (cộng buffer 20%)
>
> Cách SAI thường gặp:
>   - dùng λ_average -> thiếu VU ở giữa stage đỉnh -> drop
>   - giả định L(t) cố định -> sai vì L(t) = λ(t) × W biến thiên theo λ(t)
>
> Tại 1 thời điểm trong steady đoạn, có ~L(t) = λ(t) × W VU đang bận
> (không phải max VU). Pool VU thực dùng dao động theo timeline.
> ```
>
> Steady-state vẫn đúng LOCAL nếu:
>
> ```text
> 1) ramp đủ chậm để hệ thống bắt kịp (rate ổn định trong vài iter_time)
> 2) iter_time không biến thiên quá lớn
> 3) lưu ý caveat ở 3.1 (slot lẻ, slot đầu lệch t=0)
> ```
>
> Nếu ramp quá nhanh (vd 0 → 1000/s trong 1s), VU spawn không kịp,
> hệ thống chưa ổn định → Little's Law cho kết quả không chính xác,
> phải set `preAllocatedVUs` cao từ đầu hoặc làm soft warm-up.

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

> **Bảng ký hiệu thống nhất** dùng xuyên suốt 3.1-3.5 (mọi section
> giới thiệu biến mới phải tham chiếu bảng này):
>
> | Ký hiệu | Ý nghĩa | Đơn vị |
> | --- | --- | --- |
> | `λ(t)` | rate scheduler tại thời điểm t (hàm theo t) | iter/s |
> | `λ_prev` | rate ở **đầu** stage (= rate cuối stage trước, hoặc `startRate`) | iter/s |
> | `λ_next` | rate ở **cuối** stage (= `stage.target / timeUnit_seconds`) | iter/s |
> | `λ_peak` | rate cao nhất toàn timeline = `max(λ_start, mọi λ_i_end)` | iter/s |
> | `λ_avg` | rate trung bình toàn timeline = `N_sched / T` | iter/s |
> | `λ_current` | rate hiện tại tại t (đồng nghĩa `λ(t)`, dùng khi nói về 1 thời điểm) | iter/s |
> | `slope` | độ dốc rate trong stage = `(λ_next − λ_prev) / d_i` | iter/s² |
> | `W` | iter_time hiệu dụng = `max(iter_duration, minIterationDuration)` | s/iter |
> | `d_i` | duration stage i | s |
> | `T` | tổng thời gian timeline = `sum(d_i)` (regular_duration) | s |
> | `T_run` | runtime thực tế khi summary tính rate (mẫu số cột `/s`) | s |
> | `N_sched` | tổng slot dự kiến cả timeline (= `scheduled_iterations_total`) | slot |
> | `N_done` | số iter HOÀN THÀNH (= `iterations` trong summary) | iter |
> | `N_drop` | số slot bị drop (= `dropped_iterations` metric) | slot |
> | `N_int` | số iter đã start nhưng bị cancel (= `interrupted iterations`) | iter |
> | `M` | tổng số VU thực tế = `preAllocatedVUs + spawned_unplanned` | VU |
> | `L(t)` | số VU đang bận tại t (Little's Law) | VU |
> | `C` | capacity của pool M VU = `M / W` | iter/s |
>
> **Quan hệ chính** (giải thích chi tiết ở 3.2-3.5):
>
> ```text
> λ(t)    = λ_prev + slope × (t − stageStart)         (3.1, đường thẳng)
> N_sched = Σ d_i × (λ_prev + λ_next) / 2             (3.1, cộng diện tích hình thang)
> λ_avg   = N_sched / T                               (3.2, rate trung bình)
> L(t)    = λ(t) × W                                  (3.3, Little's Law)
> C       = M / W                                     (3.3, capacity của M VU)
> drop(t) = max(0, λ(t) − C)                          (3.3, rate vượt năng lực)
> N_done ≈ N_sched − N_drop − N_int                   (3.4-3.5, xấp xỉ ±1)
> λ_peak ≥ λ_avg ≥ N_done / T_run = actual_rate       (3.4, thứ tự 3 rate)
> ```

### 3.1. Đếm slot: tổng số slot trong 1 stage và rate(t) tại mọi thời điểm

#### Bức tranh tổng quan: 3 đại lượng liên hệ với nhau

Cốt lõi của ramping-arrival-rate là **3 đại lượng** luôn đi cùng nhau.
Hiểu được mối liên hệ giữa chúng thì mọi công thức còn lại là hệ quả.

**── 3 đại lượng ──**

```text
Đại lượng 1: rate(t) — "nhịp fire slot tại thời điểm t"
  Đơn vị: iterations/s (hay slot/s)
  Ý nghĩa: tại thời điểm t, k6 muốn fire NHANH BAO NHIÊU slot mỗi giây
  VD: rate(1s) = 3/s → tại t=1s, nhịp là 3 slot mỗi giây

Đại lượng 2: slot_interval(t) — "khoảng cách thời gian giữa 2 slot gần t"
  Đơn vị: s (hay ms)
  Ý nghĩa: nếu rate giữ nguyên như lúc t, thì 2 slot liên tiếp cách nhau bao lâu
  Quan hệ: slot_interval(t) = 1 / rate(t)
  VD: rate=3/s → interval = 1/3 ≈ 0.333s = 333ms

Đại lượng 3: S(t) — "diện tích tích lũy dưới đường rate từ 0 đến t"
  Đơn vị: slot (số thực, không làm tròn)
  Ý nghĩa: tổng số slot LÝ THUYẾT đáng lẽ đã fire từ lúc bắt đầu đến thời điểm t
  Quan hệ: S(t) = ∫₀ᵗ rate(τ) dτ   (tích phân của rate theo thời gian)
  VD: nếu rate=3/s đều suốt 2s → S(2) = 3×2 = 6 slot
```

**── Mối liên hệ mấu chốt giữa 3 đại lượng ──**

```text
                    rate(t)
                       │
                       │  slot_interval = 1/rate
                       ↓
               slot_interval(t)          ← "slot gần t cách nhau bao xa"
                       │
                       │  S(t) = ∫ rate dt
                       ↓
                    S(t)                  ← "đáng lẽ đã fire bao nhiêu slot đến lúc t"
                       │
                       │  fire khi S(t) chạm số nguyên
                       ↓
               slot thứ k fire tại tₖ
               với S(tₖ) = k            ← "slot #k ra đời lúc nào"
```

Nói cách khác:

```text
rate(t) là TỐC ĐỘ (km/h)
  → slot_interval là THỜI GIAN ĐI 1 KM (h/km) = 1/tốc_độ
  → S(t) là QUÃNG ĐƯỜNG ĐÃ ĐI (km) = ∫ tốc_độ × dt
  → fire slot khi quãng đường chạm mốc số nguyên (1km, 2km, 3km...)
```

**── Bức tranh minh họa: ramp 2→4/s trong 2s ──**

Dùng 1 ví dụ xuyên suốt để thấy 3 đại lượng trên cùng 1 hình:

```text
ĐỒ THỊ TRÊN: rate(t) = 2 + t  (đường thẳng dốc lên)
ĐỒ THỊ DƯỚI: S(t) = 2t + t²/2  (đường cong, càng lúc càng dốc)

rate(t)
  4 |           /|              ← cuối stage: rate=4/s
  3 |          / |                  interval=250ms (ngắn nhất)
  2 |_________/  |              ← đầu stage: rate=2/s
    |         |                   interval=500ms (dài nhất)
  0 +----+----+----+----► t
    0   0.5   1.0  1.5  2.0

S(t)
  6 |                  ●        ← S=6 → fire slot #6 tại t=2.0
  5 |              ●            ← S=5 → fire slot #5 tại t≈1.74
  4 |          ●                ← S=4 → fire slot #4 tại t≈1.46
  3 |      ●                    ← S=3 → fire slot #3 tại t≈1.16
  2 |  ●                        ← S=2 → fire slot #2 tại t≈0.83
  1 |●                          ← S=1 → fire slot #1 tại t≈0.45
  0 +----+----+----+----► t
    0   0.5   1.0  1.5  2.0

NHẬN XÉT TỪ HÌNH:
  - rate tăng → interval giảm → S(t) dốc dần → slot DÀY dần
  - Đầu stage (gần t=0): S(t) thoải → mất ~0.45s mới đủ 1 slot
  - Cuối stage (gần t=2): S(t) dốc → chỉ ~0.26s đã đủ 1 slot
  - Tổng 6 slot trong 2s — nhưng PHÂN BỐ KHÔNG ĐỀU
```

**── Công thức tổng kết ──**

```text
┌─────────────────────────────────────────────────────────────────┐
│ slot_interval(t) = 1 / rate(t)                                  │
│                                                                 │
│ S(t) = ∫₀ᵗ rate(τ) dτ                                          │
│                                                                 │
│ slot thứ k fire tại tₖ, với S(tₖ) = k                           │
│                                                                 │
│ Tổng slot 1 stage = S(stageEnd) - S(stageStart)                 │
│                   = d × (rate_đầu + rate_cuối) / 2              │
│                   = diện tích hình thang                         │
└─────────────────────────────────────────────────────────────────┘
```

Phân biệt 2 chế độ:

```text
CONSTANT (rate cố định):                    RAMPING (rate thay đổi):
  rate(t) = const                            rate(t) = λ_prev + slope×t
  → interval CỐ ĐỊNH                        → interval THAY ĐỔI
  → S(t) = rate × t (đường thẳng)            → S(t) = ∫ rate dt (đường cong)
  → ticker bắn đều                           → giải S(t)=k tìm từng tₖ
  → slot cách đều                             → slot lúc thưa lúc dày
```

Với bức tranh này, mọi công thức phía dưới là hệ quả tự nhiên:
- `N_sched = d × (λ_prev + λ_next)/2` ← diện tích hình thang của rate(t)
- `slot_interval = 1/rate(t)` ← nghịch đảo của rate tại thời điểm t
- `S(tₖ) = k` ← slot fire khi tích lũy chạm số nguyên

#### Trace từng bước: tích lũy S(t) và slot fire như thế nào

Vẫn ví dụ trên: `startRate=2, ramp 2→4/s trong 2s`.
Đầu vào: `λ_prev=2, λ_next=4, d=2s`.

```text
Bước 0 — Xác định 2 hàm gốc:
  rate(t) = 2 + t           (đường thẳng, slope=1)
  S(t)    = 2t + t²/2       (tích phân của rate, đường cong)

  Mọi con số phía dưới đều từ 2 hàm này mà ra.
```

**── Bảng trace: từng bước thời gian, S(t) tích lũy ra sao ──**

```text
  t(s)   rate(t)   ΔS trong    S(t)    S(t) đã   slot_interval   GHI CHÚ
          (slot/s)  bước này   (t.lũy)  chạm      tại t
                                        số nguyên?  (=1/rate)
 ──────  ────────  ─────────  ───────  ─────────  ─────────────  ────────────────
 0.000   2.000/s      0        0.000     chưa        500ms       BẮT ĐẦU stage
                                                                 rate=2/s, S=0

 0.100   2.100/s   +0.205      0.205     chưa        476ms       S mới = 0 + 0.205
                                                                 S tăng CHẬM vì rate thấp

 0.200   2.200/s   +0.215      0.420     chưa        455ms       S=0.420, còn xa 1

 0.300   2.300/s   +0.225      0.645     chưa        435ms       S=0.645

 0.400   2.400/s   +0.235      0.880     chưa        417ms       S=0.880, gần 1

 0.449   2.449/s   +0.120      1.000     CHẠM 1 ✓    408ms       ──► FIRE SLOT #1
                                                                 S vừa chạm 1.000
                                                                 slot #1 ra đời tại t=0.449s
                                                                 Khoảng cách từ t=0: 0.449s

 0.500   2.500/s   +0.063      1.128     —           400ms       sau slot #1, S tiếp tục tăng

 0.600   2.600/s   +0.255      1.383     —           385ms

 0.700   2.700/s   +0.265      1.648     —           370ms

 0.800   2.800/s   +0.275      1.923     —           357ms       S=1.923, gần 2

 0.828   2.828/s   +0.077      2.000     CHẠM 2 ✓    354ms       ──► FIRE SLOT #2
                                                                 slot #2 ra đời tại t=0.828s
                                                                 Gap slot#1→#2 = 0.828-0.449 = 0.379s

 0.900   2.900/s   +0.104      2.209     —           345ms

 1.000   3.000/s   +0.295      2.500     —           333ms       GIỮA STAGE (t=1s)
                                                                 rate=3/s, S=2.5

 1.100   3.100/s   +0.305      2.805     —           323ms

 1.162   3.162/s   +0.195      3.000     CHẠM 3 ✓    316ms       ──► FIRE SLOT #3
                                                                 Gap slot#2→#3 = 1.162-0.828 = 0.334s

 1.200   3.200/s   +0.061      3.121     —           313ms

 1.300   3.300/s   +0.325      3.446     —           303ms

 1.400   3.400/s   +0.335      3.781     —           294ms

 1.464   3.464/s   +0.219      4.000     CHẠM 4 ✓    289ms       ──► FIRE SLOT #4
                                                                 Gap slot#3→#4 = 1.464-1.162 = 0.302s

 1.500   3.500/s   +0.063      4.125     —           286ms

 1.600   3.600/s   +0.355      4.480     —           278ms

 1.700   3.700/s   +0.365      4.845     —           270ms

 1.742   3.742/s   +0.155      5.000     CHẠM 5 ✓    267ms       ──► FIRE SLOT #5
                                                                 Gap slot#4→#5 = 1.742-1.464 = 0.278s

 1.800   3.800/s   +0.109      5.218     —           263ms

 1.900   3.900/s   +0.385      5.603     —           256ms

 2.000   4.000/s   +0.397      6.000     CHẠM 6 ✓    250ms       ──► FIRE SLOT #6
                                                                 Gap slot#5→#6 = 2.000-1.742 = 0.258s
                                                                 KẾT THÚC STAGE. S=6.000 = 6 slot
```

**── Đọc bảng trace: 4 điều rút ra ──**

```text
1. S(t) tăng LIÊN TỤC, không nhảy bậc:
   Mỗi bước thời gian nhỏ, ΔS = rate(t) × Δt được cộng dồn vào S.
   S là số THỰC (có phần thập phân), không phải số nguyên.
   VD: t=0.4 → S=0.880, t=0.449 → S=1.000 → fire slot #1.

2. Slot fire ĐÚNG lúc S(t) chạm số nguyên:
   S từ 0.880 → 1.000 → fire slot #1 tại t=0.449s
   S từ 1.923 → 2.000 → fire slot #2 tại t=0.828s
   ...
   Không fire trước, không fire sau — fire CHÍNH XÁC khi S chạm k.

3. Gap giữa 2 slot NGÀY CÀNG THU HẸP:
   Gap #1→#2: 0.379s  (379ms)
   Gap #2→#3: 0.334s  (334ms)
   Gap #3→#4: 0.302s  (302ms)
   Gap #4→#5: 0.278s  (278ms)
   Gap #5→#6: 0.258s  (258ms)
   → Gap GIẢM vì rate TĂNG: đầu stage rate=2/s → gap rộng ~500ms,
     cuối stage rate=4/s → gap hẹp ~250ms.
   → Các gap này khớp với slot_interval tại thời điểm fire.

4. slot_interval(t) = 1/rate(t) là GIÁ TRỊ TỨC THỜI:
   Tại t=0.449 (fire slot #1): rate≈2.45/s → interval≈408ms
     → Gap thực tế #1→#2 = 379ms (gần 408ms, không bằng chính xác vì
       rate tiếp tục tăng trong lúc chờ slot #2)
   Tại t=1.742 (fire slot #5): rate≈3.74/s → interval≈267ms
     → Gap thực tế #5→#6 = 258ms (gần 267ms)
   → interval là ẢNH CHỤP TỨC THỜI — nếu rate giữ nguyên thì gap sẽ
     đúng bằng interval. Nhưng vì rate luôn tăng, gap luôn NHỎ HƠN
     interval tại thời điểm slot trước (vì rate đã tăng lên rồi).
```

**── Công thức tính ΔS trong 1 bước nhỏ ──**

```text
ΔS = rate(t) × Δt   (với Δt rất nhỏ)

Đây chính là ĐỊNH NGHĨA của tích phân:
  S(t) = lim(Δt→0) Σ rate(t) × Δt = ∫₀ᵗ rate(τ) dτ

Trong bảng trace, mỗi bước ~0.1s:
  t=0.1: ΔS ≈ 2.1 × 0.1 = 0.21  → S mới = 0 + 0.21 = 0.21
  t=0.2: ΔS ≈ 2.2 × 0.1 = 0.22  → S mới = 0.21 + 0.22 = 0.43
  ...
→ Càng nhiều bước nhỏ, S càng tiến gần số nguyên tiếp theo → fire slot
```

**── Tóm tắt: 1 slot ra đời như thế nào ──**

```text
Cho trước: rate(t) từ config (hàm tuyến tính theo t)

1. S(t) = ∫₀ᵗ rate(τ) dτ — tích phân, ra số THỰC
2. S(t) tăng liên tục theo thời gian
3. Mỗi khi S(t) đi qua 1 số nguyên → scheduler fire 1 slot
4. Khoảng cách giữa 2 slot = thời gian để S(t) tăng thêm đúng 1 đơn vị
   = thời gian để rate(t) "góp" đủ 1 slot vào quỹ tích lũy

Tất cả chỉ là 1 cơ chế: TÍCH LŨY DIỆN TÍCH → CHẠM SỐ NGUYÊN → FIRE.
```

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
```

**── Cách tính slot_interval tại từng thời điểm trong ramp ──**

Công thức gốc `slot_interval = 1/rate` vẫn đúng, nhưng vì rate **thay đổi
liên tục** trong ramp nên interval cũng thay đổi liên tục theo:

```text
slot_interval(t) = 1 / rate(t)

Với rate(t) = lambda_prev + slope × (t - stageStart)
    slope    = (lambda_next - lambda_prev) / duration
```

Đây chính là điểm khác biệt CỐT LÕI giữa constant và ramping:

```text
Constant (rate cố định):
  rate = 4/s (không đổi)
  → slot_interval = 1/4 = 250ms (KHÔNG ĐỔI suốt run)
  → k6 dùng ticker cố định 250ms, mỗi tick fire 1 slot

Ramping (rate thay đổi):
  rate đi từ 2/s lên 4/s trong 2 giây
  → slot_interval đi từ 500ms XUỐNG 250ms (THAY ĐỔI liên tục)
  → k6 KHÔNG THỂ dùng ticker cố định được
  → Phải dùng thuật toán khác: "diện tích tích lũy" (cal())
```

Tính cụ thể slot_interval ở 3 mốc trong ví dụ:

```text
Bước 1 — Xác định công thức rate(t):
  lambda_prev = 2/s, lambda_next = 4/s, duration = 2s
  slope = (4 - 2) / 2 = 1  (mỗi giây rate tăng thêm 1)
  rate(t) = 2 + 1 × t = 2 + t

Bước 2 — Tính slot_interval tại từng thời điểm:

  Tại t=0s (đầu stage):
    rate(0) = 2 + 0 = 2/s
    slot_interval = 1 / 2 = 0.5s = 500ms
    → "lúc đầu thưa", 500ms mới fire 1 slot

  Tại t=1s (giữa stage):
    rate(1) = 2 + 1 = 3/s
    slot_interval = 1 / 3 ≈ 0.333s = 333ms
    → "nhanh dần", 333ms fire 1 slot

  Tại t=2s (cuối stage):
    rate(2) = 2 + 2 = 4/s
    slot_interval = 1 / 4 = 0.25s = 250ms
    → "dày nhất", 250ms fire 1 slot (nhanh gấp đôi lúc đầu)
```

Bảng mở rộng — slot_interval ở nhiều mốc thời gian hơn:

```text
t (s) | rate(t) = 2 + t | slot_interval = 1/rate(t) | Nhận xét
──────┼─────────────────┼────────────────────────────┼──────────
0.0   | 2.0/s           | 1/2.0 = 500ms             | thưa nhất
0.2   | 2.2/s           | 1/2.2 ≈ 455ms             |
0.4   | 2.4/s           | 1/2.4 ≈ 417ms             |
0.6   | 2.6/s           | 1/2.6 ≈ 385ms             |
0.8   | 2.8/s           | 1/2.8 ≈ 357ms             |
1.0   | 3.0/s           | 1/3.0 ≈ 333ms             | trung bình
1.2   | 3.2/s           | 1/3.2 ≈ 313ms             |
1.4   | 3.4/s           | 1/3.4 ≈ 294ms             |
1.6   | 3.6/s           | 1/3.6 ≈ 278ms             |
1.8   | 3.8/s           | 1/3.8 ≈ 263ms             |
2.0   | 4.0/s           | 1/4.0 = 250ms             | dày nhất
```

Nhìn bảng trên thấy rõ: interval GIẢM DẦN theo thời gian (500ms → 250ms),
slot càng về cuối stage càng dày. Đây là hệ quả trực tiếp của rate tăng
tuyến tính: rate tăng → 1/rate giảm → interval thu hẹp.

**── Từ slot_interval thay đổi đến thuật toán cal() ──**

Vì interval thay đổi liên tục, k6 không thể dùng ticker cố định như bên
constant-arrival-rate. Thay vào đó, k6 dùng phương pháp **tích lũy diện tích**:

```text
1. Khi rate thay đổi, không có "1 ticker period" cho cả stage
2. Thay vào đó, k6 tính: "cần bao nhiêu diện tích dưới đường rate(t)
   để tích lũy được 1 slot?"
3. Mỗi khi diện tích tích lũy chạm số nguyên tiếp theo → fire 1 slot
4. Code ref: cal() trong ramping_arrival_rate.go:234-282
```

Cảm nhận trực quan:

```text
Interval GIẢM vì rate TĂNG:
  rate ↑ → 1/rate ↓ → interval ↓ → slot MAU hơn

  t=0.0s: interval=500ms → slot thưa (như rate 2/s)
  t=1.0s: interval=333ms → slot vừa  (như rate 3/s)
  t=2.0s: interval=250ms → slot dày  (như rate 4/s)

  Trong cùng 1 giây:
    Đầu stage (gần t=0): fire được ~2 slot (vì interval ~500ms)
    Cuối stage (gần t=2): fire được ~4 slot (vì interval ~250ms)
```

Ngược lại với ramp xuống:

```text
Ramp 4 → 2/s trong 2s: slope = (2-4)/2 = -1, rate(t) = 4 - t

  t=0s: rate=4/s → interval=250ms (dày lúc đầu)
  t=1s: rate=3/s → interval=333ms (thưa dần)
  t=2s: rate=2/s → interval=500ms (thưa nhất)

  Interval TĂNG vì rate GIẢM: slot càng về cuối càng thưa
```

Câu hỏi: tổng có bao nhiêu slot fire trong stage này?

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
cong (parabol, exponential), công thức tính sẽ phức tạp hơn nhiều.

k6 chọn tuyến tính vì:

```text
- đơn giản, dễ tính (chỉ cần 2 điểm đầu/cuối)
- trực giác: user nghĩ "ramp đều" = tuyến tính
- đủ cho mọi load test thực tế
```

Code ref: `cal()` trong `ramping_arrival_rate.go:234-282` dùng công thức
nghiệm bậc 2 (toán học của hình thang) để tìm mốc fire của slot thứ n.

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

**── Tổng cả timeline: đếm slot qua nhiều stage ──**

Công thức tổng quát:

```text
N_sched = Σ scheduled_iterations_i = Σ d_i × (λ_prev + λ_next) / 2

Với:
  d_i        = duration stage i (giây)
  λ_prev     = rate ở đầu stage i (= rate cuối stage i-1, hoặc startRate nếu i=0)
  λ_next     = rate ở cuối stage i (= stage[i].target / timeUnit_seconds)
```

**Ví dụ 1: Scenario 3 stage cơ bản (ramp-up → steady → ramp-down)**

Config:
```js
startRate: 0,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 4 },   // stage 0: ramp 0 → 4/s
  { duration: "3s", target: 4 },   // stage 1: hold 4/s
  { duration: "2s", target: 0 },   // stage 2: ramp 4 → 0/s
]
```

```text
Bước 1 — Vẽ timeline rate(t):
  rate
  4 |          ┌─────────────────┐
    |         /︙                 ︙\
  3 |        / ︙      stage 1    ︙ \
    |       /   ︙    (hold 4/s)  ︙  \
  2 |      /    ︙                ︙   \
    |     /     ︙                ︙    \
  1 |    /      ︙                ︙     \
    |   /       ︙                ︙      \
  0 |──┴────────┴────────────────┴───────┴──► t
    0s   stage 0    2s   stage 1   5s  stage 2  7s
         (ramp up)        (hold)         (ramp down)

Bước 2 — Tính từng stage:

  Stage 0 (ramp 0 → 4/s, d=2s):
    λ_prev = 0 (startRate)
    λ_next = 4/1 = 4
    N₀ = 2 × (0 + 4) / 2 = 4.0 slot

  Stage 1 (hold 4/s, d=3s):
    λ_prev = 4 (rate cuối stage 0)
    λ_next = 4/1 = 4
    N₁ = 3 × (4 + 4) / 2 = 12.0 slot
    (vì λ_prev = λ_next nên công thức rút gọn: N = d × rate = 3 × 4 = 12)

  Stage 2 (ramp 4 → 0/s, d=2s):
    λ_prev = 4 (rate cuối stage 1)
    λ_next = 0/1 = 0
    N₂ = 2 × (4 + 0) / 2 = 4.0 slot

Bước 3 — Cộng dồn:
  N_sched = N₀ + N₁ + N₂ = 4 + 12 + 4 = 20 slot

Bước 4 — Phân bổ slot theo stage:
  Stage 0: slot #1  → #4   (4 slot, ramp lên)
  Stage 1: slot #5  → #16  (12 slot, đều)
  Stage 2: slot #17 → #20  (4 slot, ramp xuống)
```

**── doneSoFar: cơ chế mang phần lẻ qua stage ──**

Mỗi stage, `N_i = d_i × (λ_prev + λ_next) / 2` có thể ra số LẺ (vd 2.5, 3.7).
k6 dùng biến `doneSoFar` để giữ phần thập phân và cộng dồn qua stage sau:

```text
Nguyên tắc:
  stage i có N_i slot lý thuyết (có thể lẻ)
  fire được floor(N_i + doneSoFar_cũ) slot nguyên
  doneSoFar_mới = (N_i + doneSoFar_cũ) - floor(N_i + doneSoFar_cũ)
                = phần thập phân còn dư
```

Ví dụ với số lẻ:
```text
startRate: 0, stages: [
  { duration: "1.5s", target: 3 },   // ramp 0 → 3/s
  { duration: "2s",   target: 5 },   // ramp 3 → 5/s
  { duration: "1s",   target: 0 },   // ramp 5 → 0/s
]

Tính N_i từng stage:
  Stage 0: N₀ = 1.5 × (0+3)/2 = 2.25 slot
  Stage 1: N₁ = 2   × (3+5)/2 = 8.0 slot
  Stage 2: N₂ = 1   × (5+0)/2 = 2.5 slot

Tổng lý thuyết: 2.25 + 8.0 + 2.5 = 12.75 slot (≠ số nguyên)

Áp doneSoFar:
  Đầu stage 0: doneSoFar = 0
    N₀ = 2.25, fire = floor(2.25 + 0) = 2 slot
    doneSoFar = 2.25 - 2 = 0.25 (dư sang stage 1)

  Đầu stage 1: doneSoFar = 0.25
    N₁ = 8.0, fire = floor(8.0 + 0.25) = 8 slot
    doneSoFar = 8.25 - 8 = 0.25

  Đầu stage 2: doneSoFar = 0.25
    N₂ = 2.5, fire = floor(2.5 + 0.25) = 2 slot
    doneSoFar = 2.75 - 2 = 0.75

  Tổng fire thực tế = 2 + 8 + 2 = 12 slot
  (so với 12.75 lý thuyết → lệch 0.75, phần dư cuối cùng không fire)
```

**── Ví dụ 2: Scenario nhiều stage phức tạp ──**

Config:
```js
startRate: 5,
timeUnit: "1s",
stages: [
  { duration: "3s", target: 10 },  // stage 0: ramp 5 → 10/s
  { duration: "2s", target: 10 },  // stage 1: hold 10/s
  { duration: "4s", target: 2 },   // stage 2: ramp 10 → 2/s
  { duration: "3s", target: 2 },   // stage 3: hold 2/s
]
```

```text
Bước 1 — Vẽ timeline:
  rate
  10 |          ┌──────┐
     |         /︙       ︙\
   8 |        / ︙        ︙ \
     |       /   ︙        ︙  \
   6 |      /    ︙        ︙   \
     |     /     ︙        ︙    \
   4 |    /      ︙        ︙     ┌────────┐
     |   /       ︙        ︙    /︙         ︙
   2 |  /        ︙        ︙───/ ︙         ︙
     | /         ︙           /   ︙         ︙
   0 +──┴────────┴───────────┴────┴─────────┴──► t
    0s   stage 0  3s  stage 1 5s  stage 2   9s  stage 3  12s

Bước 2 — Tính từng stage:

  Stage 0 (ramp 5 → 10/s, d=3s):
    λ_prev = 5, λ_next = 10
    N₀ = 3 × (5 + 10) / 2 = 3 × 7.5 = 22.5 slot

  Stage 1 (hold 10/s, d=2s):
    λ_prev = 10, λ_next = 10
    N₁ = 2 × (10 + 10) / 2 = 2 × 10 = 20.0 slot

  Stage 2 (ramp 10 → 2/s, d=4s):
    λ_prev = 10, λ_next = 2
    N₂ = 4 × (10 + 2) / 2 = 4 × 6 = 24.0 slot

  Stage 3 (hold 2/s, d=3s):
    λ_prev = 2, λ_next = 2
    N₃ = 3 × (2 + 2) / 2 = 3 × 2 = 6.0 slot

Bước 3 — Cộng dồn:
  N_sched = 22.5 + 20 + 24 + 6 = 72.5 slot

Bước 4 — Thực tế fire (với doneSoFar):
  Stage 0: N₀=22.5  → fire 22 slot, doneSoFar=0.5
  Stage 1: N₁=20.0  → fire 20 slot (20.0+0.5=20.5), doneSoFar=0.5
  Stage 2: N₂=24.0  → fire 24 slot (24.0+0.5=24.5), doneSoFar=0.5
  Stage 3: N₃=6.0   → fire 6 slot (6.0+0.5=6.5), doneSoFar=0.5
  Tổng fire = 22 + 20 + 24 + 6 = 72 slot

Bước 5 — Phân bổ slot theo stage:
  Stage 0: slot #1  → #22  (22 slot, ramp lên: thưa → dày)
  Stage 1: slot #23 → #42  (20 slot, đều 100ms)
  Stage 2: slot #43 → #66  (24 slot, ramp xuống: dày → thưa)
  Stage 3: slot #67 → #72  (6 slot, đều 500ms)
```

**── Bảng tổng hợp công thức theo loại stage ──**

| Loại stage | Điều kiện | Công thức rút gọn | Ví dụ |
|---|---|---|---|
| Ramp lên | λ_next > λ_prev | d × (λ_prev + λ_next)/2 | 2s × (2+4)/2 = 6 |
| Ramp xuống | λ_next < λ_prev | d × (λ_prev + λ_next)/2 | 2s × (4+1)/2 = 5 |
| Hold | λ_next = λ_prev | d × λ (hình chữ nhật) | 3s × 4 = 12 |
| Từ 0 | λ_prev = 0 | d × λ_next/2 (tam giác) | 2s × 4/2 = 4 |
| Về 0 | λ_next = 0 | d × λ_prev/2 (tam giác) | 2s × 4/2 = 4 |

Tất cả đều là **cùng 1 công thức hình thang** — các dòng "rút gọn" chỉ là
trường hợp đặc biệt khi 1 trong 2 đáy = 0 hoặc 2 đáy bằng nhau.

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

**── Quy tắc fire slot: "chạm số nguyên thì fire" ──**

Đây là nguyên lý gốc trong `cal()` (`ramping_arrival_rate.go:234-282`):

```text
Gọi S(t) = diện tích dưới đường rate(τ) từ τ=0 đến τ=t
         = ∫₀ᵗ rate(τ) dτ

S(t) là "số slot lý thuyết đáng lẽ đã fire đến thời điểm t"
  → KHÔNG làm tròn, giữ phần thập phân

Quy tắc fire:
  slot thứ k fire tại thời điểm tₖ thỏa mãn: S(tₖ) = k
  (k = 1, 2, 3, ...)

Nói cách khác:
  Mỗi khi S(t) CHẠM 1 số nguyên tiếp theo → fire 1 slot
  S(t) từ 0 → 1  → fire slot #1
  S(t) từ 1 → 2  → fire slot #2
  S(t) từ 2 → 3  → fire slot #3
  ...
```

Minh họa trực quan:

```text
S(t)
4 |                  ●  (t=2.0, S=4) → fire slot #4
3 |              ●      (t≈1.732, S=3) → fire slot #3
2 |          ●          (t≈1.414, S=2) → fire slot #2
1 |      ●              (t=1.0, S=1) → fire slot #1
0 +------+------+------+------+------► t
  0     0.5    1.0    1.5    2.0

Mỗi khi đường S(t) cắt 1 đường ngang số nguyên → 1 slot ra đời
```

Vì sao cần S(t) = k (số nguyên) chứ không phải cứ sau interval cố định?

```text
Constant-arrival-rate: rate không đổi → S(t) = rate × t (đường thẳng)
  → S(t) tăng đều → interval đều → DÙNG ĐƯỢC ticker cố định

Ramping-arrival-rate: rate thay đổi → S(t) = ∫ rate(t) dt (đường cong)
  → S(t) tăng không đều → interval thay đổi → KHÔNG dùng được ticker
  → Phải giải phương trình S(tₖ) = k để tìm từng tₖ
```

Vị trí slot đầu tiên phụ thuộc vào `startRate`. Phân tích 2 trường hợp:

**── Case A: startRate = 0 ──**

Rate bắt đầu từ 0 → diện tích tích lũy ban đầu = 0, cần thời gian để đạt 1.

Mini ví dụ: `startRate=0, stage 1 ramp 0 → 4/s trong 2s`:

```text
Bước 1 — Xác định rate(t):
  lambda_prev = 0, lambda_next = 4, duration = 2s
  slope = (4 - 0) / 2 = 2
  rate(t) = 0 + 2t = 2t

Bước 2 — Tính S(t) = ∫ rate(t) dt:
  S(t) = ∫ 2t dt = t²

  Đây là diện tích dưới đường rate(t) từ 0 đến t.
  S(t) cho biết "đáng lẽ đã fire bao nhiêu slot đến lúc t".

Bước 3 — Giải phương trình S(t) = k cho từng slot:
  t² = k  →  t = √k  (chỉ lấy nghiệm dương)

  k=1: t = √1 = 1.000s  → slot #1 fire tại t=1.000s
  k=2: t = √2 ≈ 1.414s  → slot #2 fire tại t=1.414s
  k=3: t = √3 ≈ 1.732s  → slot #3 fire tại t=1.732s
  k=4: t = √4 = 2.000s  → slot #4 fire tại t=2.000s

  (k=0 không fire vì t=0, S(0)=0, chưa có slot nào)

Bước 4 — Kiểm tra lại bằng cách thế ngược:
  S(1.000) = 1.0² = 1.0 ✓
  S(1.414) = 1.414² = 2.0 ✓
  S(1.732) = 1.732² = 3.0 ✓
  S(2.000) = 2.0² = 4.0 ✓
```

Tóm tắt timeline:
```text
  t=0s     : S=0    → chưa fire
  t=1.000s : S=1.0  → fire slot #1
  t=1.414s : S=2.0  → fire slot #2
  t=1.732s : S=3.0  → fire slot #3
  t=2.000s : S=4.0  → fire slot #4
```

Đặc điểm khi `startRate=0`:
```text
- Slot đầu luôn LỆCH xa khỏi t=0 (vd 1s trong ví dụ trên)
- Nửa đầu stage thưa (interval lớn), nửa cuối dày dần
- Tổng slot vẫn = diện tích = 4 slot
- scheduled_total so với completed có thể lệch 1 slot ở biên
```

**── Case B: startRate > 0 ──**

Rate bắt đầu > 0 → diện tích tích lũy NGAY từ t=0, slot đầu đến sớm hơn nhiều.

Ví dụ 1: `startRate=2/s, stage 1 ramp 2 → 4/s trong 2s`:

```text
Bước 1 — Xác định rate(t):
  lambda_prev = 2, lambda_next = 4, duration = 2s
  slope = (4 - 2) / 2 = 1
  rate(t) = 2 + 1t = 2 + t

Bước 2 — Tính S(t) = ∫ rate(t) dt:
  S(t) = ∫ (2 + t) dt = 2t + t²/2

Bước 3 — Giải phương trình S(t) = k cho từng slot:
  2t + t²/2 = k
  → t² + 4t - 2k = 0  (nhân 2 vế cho 2)
  → t = [-4 + √(16 + 8k)] / 2   (công thức nghiệm, chỉ lấy nghiệm dương)
  → t = -2 + √(4 + 2k)

  Tính từng k:
  ┌─────┬────────────────────┬──────────────────┬──────────────────┐
  │  k  │ phép tính          │ t (chính xác)    │ t (xấp xỉ)       │
  ├─────┼────────────────────┼──────────────────┼──────────────────┤
  │  1  │ -2 + √(4+2)        │ -2 + √6          │ -2+2.449 = 0.449s│
  │  2  │ -2 + √(4+4)        │ -2 + √8          │ -2+2.828 = 0.828s│
  │  3  │ -2 + √(4+6)        │ -2 + √10         │ -2+3.162 = 1.162s│
  │  4  │ -2 + √(4+8)        │ -2 + √12         │ -2+3.464 = 1.464s│
  │  5  │ -2 + √(4+10)       │ -2 + √14         │ -2+3.742 = 1.742s│
  │  6  │ -2 + √(4+12)       │ -2 + √16         │ -2+4 = 2.000s    │
  └─────┴────────────────────┴──────────────────┴──────────────────┘

Bước 4 — Kiểm tra lại bằng cách thế ngược:
  k=1: S(0.449) = 2×0.449 + 0.449²/2 = 0.898 + 0.101 = 0.999 ≈ 1 ✓
  k=2: S(0.828) = 2×0.828 + 0.828²/2 = 1.656 + 0.343 = 1.999 ≈ 2 ✓
  k=6: S(2.000) = 2×2 + 2²/2 = 4 + 2 = 6.000 ✓
```

Timeline các slot:
```text
  t=0s     : S=0       → chưa fire
  t≈0.449s : S≈1.0     → fire slot #1
  t≈0.828s : S≈2.0     → fire slot #2
  t≈1.162s : S≈3.0     → fire slot #3
  t≈1.464s : S≈4.0     → fire slot #4
  t≈1.742s : S≈5.0     → fire slot #5
  t=2.000s : S=6.0     → fire slot #6
```

So sánh với case A (startRate=0):
```text
               Case A (startRate=0)    Case B (startRate=2)
               ────────────────────    ────────────────────
Slot đầu tại   t ≈ 1.0s                t ≈ 0.45s
Slot thứ 2     t ≈ 1.414s              t ≈ 0.83s
Slot cuối      t = 2.0s                t = 2.0s
Tổng slot      4                       6

→ startRate > 0: slot đầu đến SỚM hơn (~0.45s thay vì 1s)
→ Tổng slot nhiều hơn (6 vs 4) vì diện tích hình thang lớn hơn
```

Ví dụ 2: `startRate=10/s, stage 1 ramp 10 → 20/s trong 2s`:
```text
rate(t) = 10 + 5t

  t=0s: rate=10/s → slot_interval ≈ 100ms
  → Slot đầu fire rất sớm, gần như ngay sau t=0
  → Khác biệt rõ nhất với startRate=0
```

**── Bảng so sánh 2 case ──**

| | startRate = 0 | startRate > 0 |
|---|---|---|
| rate tại t=0 | 0/s | startRate |
| Diện tích tại t=0 | 0 | 0 (nhưng tăng ngay) |
| Slot đầu tiên | Trễ (có thể > 1s) | Sớm (phụ thuộc startRate) |
| Khoảng cách slot đầu/cuối | Chênh lớn (thưa→dày) | Chênh ít hơn |
| Ảnh hưởng đến scheduled_total | Có thể lệch 1 slot | Thường khớp hơn |
| Dùng khi nào | "Khởi động từ 0", cold start | Đã có traffic nền, warm start |

Điểm cần nhớ:
```text
- Slot đầu KHÔNG fire tại t=0, kể cả startRate > 0
- Nhưng startRate càng cao, slot đầu càng gần t=0
- startRate=0 làm slot đầu trễ nhất có thể
- Lệch 1 slot ở biên là bình thường với startRate=0,
  không nhất thiết do drop/interrupt
```

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

### 3.2. Đỉnh rate: dùng cho sizing VU (`lambda_peak` vs `average_target_rate`)

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
λ_peak  = max(λ_start, mọi λ_i_end)
λ_avg   = N_sched / T
```

| Biến | Ý nghĩa | Đơn vị | Ref |
| --- | --- | --- | --- |
| `λ_start` | rate ở đầu scenario (= `startRate / timeUnit_seconds`) | iter/s | bảng KH |
| `λ_i_end` | rate ở cuối stage i (= `stage[i].target / timeUnit_seconds`) | iter/s | bảng KH |
| `λ_peak` | rate cao nhất scenario phải fire ở bất kỳ thời điểm nào | iter/s | bảng KH |
| `N_sched` | tổng slot trong cả timeline (xem `3.1`) | slot | bảng KH |
| `T` | tổng thời gian timeline = `sum(d_i)` | s | bảng KH |
| `λ_avg` | rate trung bình tính theo tổng slot / tổng thời gian | iter/s | bảng KH |

(Tên cũ `lambda_peak`, `average_target_rate` giữ lại trong code cho dễ
tìm kiếm nhưng từ 3.2 trở đi văn bản dùng ký hiệu toán `λ_peak`, `λ_avg`
để khớp bảng ký hiệu chung ở đầu Section 3.)

#### Vì sao `λ_peak` chỉ cần xét điểm đầu/cuối stage?

Vì rate ramp **tuyến tính** trong từng stage (xem `3.1`):

```text
λ(t) = λ_prev + slope × (t − stageStart)
```

Đây là phương trình đường thẳng. Cực trị (max/min) của 1 đường thẳng
trên đoạn `[stageStart, stageEnd]` chỉ có thể nằm tại **2 đầu mút**, không
bao giờ nằm giữa.

**Giải thích trực quan**:

```text
Đường thẳng có hệ số góc (slope) cố định trong cả stage.
=> λ(t) chỉ tăng đều, giảm đều, hoặc giữ nguyên — không đổi xu hướng.

3 trường hợp:
  - slope > 0 (ramp lên):    λ tăng đều  → max ở cuối stage (stageEnd)
  - slope < 0 (ramp xuống):  λ giảm đều  → max ở đầu stage (stageStart)
  - slope = 0 (hold):         λ const    → max = const (cả 2 đầu bằng nhau)

→ Trong mọi case, λ_peak của 1 stage = max(λ_prev, λ_next) — chỉ cần
   so 2 điểm, không cần quét cả stage.
```

**Mở rộng cho cả timeline** (n stage):

```text
λ_peak_global = max trên toàn [0, T]
              = max( λ_peak của từng stage )
              = max( max(λ_prev_i, λ_next_i) for i = 0..n-1 )
              = max( λ_start, λ_0_end, λ_1_end, ..., λ_(n-1)_end )

Vì λ_prev_i = λ_(i-1)_end (rate cuối stage trước = rate đầu stage sau).
→ chỉ cần xét n+1 điểm rời rạc, không cần quét cả timeline liên tục.
```

#### Tính `λ_avg` bằng cách đơn giản

`λ_avg` là **rate trung bình** = tổng slot fire / tổng thời gian:

```text
λ_avg = N_sched / T
```

Giải thích trực quan:

```text
N_sched = tổng slot toàn timeline (đã tính ở 3.1)
T       = tổng thời gian timeline = sum(stage.duration)

λ_avg = "nếu rải đều N_sched slot trong T giây thì rate là bao nhiêu"
      = N_sched / T
```

**Áp config demo `3.2`**:

```text
N_sched = 4 + 12 + 4 = 20 slot   (tính từng stage theo công thức 3.1)
T       = 2 + 3 + 2 = 7s
λ_avg   = 20 / 7 ≈ 2.857 iter/s
```

Cách kiểm tra cho người ưa toán: vì rate ramp tuyến tính, có thể tính
trực tiếp từng stage bằng công thức hình thang ở `3.1`:

```text
stage 0 (ramp 0→4 trong 2s): slot = 2 × (0+4)/2 = 4
stage 1 (hold 4 trong 3s):    slot = 3 × 4       = 12
stage 2 (ramp 4→0 trong 2s): slot = 2 × (4+0)/2 = 4
                              ----------------------
                              N_sched = 20 slot ✓

λ_avg = 20 / 7 ≈ 2.857/s
```

→ Khớp với công thức nhanh `λ_avg = N_sched / T`.

#### Vì sao `λ_avg` không dùng để sizing?

Lấy lại config demo trên:

```text
λ_peak = 4/s         <- giữa stage 1 (hold), nhịp đỉnh
λ_avg  = 2.86/s      <- bình quân cả timeline
```

Nếu sizing theo `λ_avg`:

```text
required_vus = ceil(λ_avg × W)        <- W = iter_time

Với W=0.4s: required = ceil(2.86 × 0.4) = 2 VU

Tại stage 1 hold 4/s:
  λ(t) = 4/s, cần ceil(4 × 0.4) = 2 VU ... vẫn vừa khít

Nhưng nếu W = 0.5s:
  required theo λ_avg  = ceil(2.86 × 0.5) = 2 VU
  required tại stage 1 = ceil(4 × 0.5)    = 2 VU ... vẫn ổn

Nếu W = 1s:
  required theo λ_avg  = ceil(2.86 × 1) = 3 VU
  required tại stage 1 = ceil(4 × 1)    = 4 VU ... THIẾU 1!
  -> tại stage 1 sẽ drop 1/s
```

→ Càng W lớn, sai số càng lớn. Luôn dùng `λ_peak` cho an toàn.

**Counter-example mạnh hơn (timeline lệch nặng)**:

Cấu hình "3 stage thấp + 1 stage đỉnh ngắn":

```text
stage 0: hold 1/s trong 10s    -> 10 slot
stage 1: hold 1/s trong 10s    -> 10 slot
stage 2: ramp 1 → 10/s trong 1s -> 5.5 slot
stage 3: hold 10/s trong 2s     -> 20 slot
                                -------
                                N_sched ≈ 45.5 slot
                                T = 23s
                                λ_avg  ≈ 1.98/s
                                λ_peak = 10/s

Với W = 0.5s:
  required theo λ_avg  = ceil(1.98 × 0.5) = 1 VU
  required tại stage 3 = ceil(10 × 0.5)   = 5 VU ... THIẾU 4!
```

→ Timeline có "đỉnh ngắn" giữa các đoạn rate thấp khiến `λ_avg` rất xa
`λ_peak`. Sizing theo `λ_avg` sẽ drop nặng tại đỉnh.

#### Ví dụ áp dụng sizing

```text
scenario lên 8/s rồi xuống 2/s, code sleep(0.5):

W = 0.5s
λ_peak = 8/s
required_vus = ceil(8 × 0.5) = 4 VU

Verify từng đoạn:
  đoạn 8/s: λ × W = 8 × 0.5 = 4 VU bận     <- đúng required
  đoạn 5/s: λ × W = 5 × 0.5 = 2.5 VU bận   <- thừa 1.5 VU
  đoạn 2/s: λ × W = 2 × 0.5 = 1 VU bận     <- thừa 3 VU
```

VU thừa ở các đoạn rate thấp là **chấp nhận được** — không tốn thêm
tài nguyên đáng kể (VU rảnh chỉ chờ ở channel).

#### Quan hệ với `drop_rate`

```text
drop(t) = max(0, λ_current(t) − C)
        = max(0, λ(t) − M / W)
```

| Biến | Ý nghĩa | Ref |
| --- | --- | --- |
| `λ_current(t)` (= `λ(t)`) | rate đang fire tại thời điểm t | bảng KH |
| `C` | capacity của pool M VU = `M / W` | bảng KH |
| `drop(t)` | rate slot bị drop tại thời điểm t (iter/s) | bảng KH |

Áp vào ví dụ:

```text
M = 3 VU, W = 0.5s  -> C = 3 / 0.5 = 6 iter/s

Tại đoạn λ=8/s: drop(t) = max(0, 8 − 6) = 2/s    <- drop 2 slot/giây
Tại đoạn λ=5/s: drop(t) = max(0, 5 − 6) = 0       <- không drop
Tại đoạn λ=2/s: drop(t) = max(0, 2 − 6) = 0       <- không drop

Tổng dropped = cộng dồn drop(t) qua thời gian
             = "diện tích phần λ vượt capacity trên đồ thị"
             = "rate vượt × thời gian vượt"
```

→ chỉ phần `λ(t) > C` mới drop. Đoạn nào λ thấp hơn capacity, VU
thừa nhưng không drop.

#### Ví dụ tính tay (số cụ thể) cho config demo 3.2

Áp toàn bộ bảng ký hiệu vào config `startRate=0, ramp 0→4 (2s),
hold 4 (3s), ramp 4→0 (2s)`:

```text
Bước 1: Liệt kê các điểm rate
  λ_start  = 0/s         (= startRate)
  λ_0_end  = 4/s         (= stage[0].target)
  λ_1_end  = 4/s         (= stage[1].target)
  λ_2_end  = 0/s         (= stage[2].target)

Bước 2: Tính λ_peak
  λ_peak = max(0, 4, 4, 0) = 4 iter/s
  → đỉnh xảy ra trong suốt stage 1 (hold) và tại t=2s, t=5s

Bước 3: Tính λ_avg
  N_sched = 4 + 12 + 4 = 20 slot           (xem 3.1)
  T       = 2 + 3 + 2 = 7s
  λ_avg   = 20 / 7 ≈ 2.857 iter/s

Bước 4: Verify đẳng thức λ_peak ≥ λ_avg
  4 ≥ 2.857 ✓                              (luôn đúng vì peak là max)

Bước 5: Sizing với W = 0.4s
  required = ceil(λ_peak × W) = ceil(4 × 0.4) = ceil(1.6) = 2 VU
  capacity tại 2 VU: C = 2/0.4 = 5 iter/s ≥ λ_peak = 4 ✓ → 0 drop

Bước 6: Sizing nhầm với λ_avg (W = 0.4s)
  required_avg = ceil(2.857 × 0.4) = ceil(1.143) = 2 VU
  → trong demo này tình cờ trùng do đỉnh thấp. Demo W=1s sẽ lệch
    (xem section "vì sao λ_avg không sizing").
```

#### Caveat / Edge case

```text
- λ_peak chỉ đúng khi rate trong stage là tuyến tính (k6 luôn vậy).
- Nếu có stage duration=0s, đó chỉ là "đặt lại điểm" (xem 3.20),
  không sinh slot, không ảnh hưởng λ_peak (vẫn xét điểm cuối stage).
- λ_avg không tính grace, không tính transient warmup.
- λ_peak có thể nằm tại λ_start nếu startRate cao hơn mọi target
  (ví dụ startRate=10, stage ramp xuống 5 → 0).
```

#### Tóm gọn 3.2

```text
λ_peak  = max(λ_start, mọi λ_i_end)            -> dùng SIZING VU (3.3)
λ_avg   = N_sched / T                          -> đối chiếu sau test
drop(t) = max(0, λ(t) − C)                     -> diễn biến drop theo t

Quy tắc nhớ: peak >= avg luôn đúng. Sizing dùng peak.
```

### 3.3. Đếm VU: cần bao nhiêu VU để không drop (Little's Law)

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
required_vus_min_peak ≈ ceil(λ_peak × W)
C                     ≈ M / W
drop(t)               ≈ max(0, λ(t) − C)
```

| Biến | Ý nghĩa | Đơn vị | Ref |
| --- | --- | --- | --- |
| `λ_peak` | rate cao nhất scenario phải chịu (xem `3.2`) | iter/s | bảng KH |
| `W` | iter_time hiệu dụng = `max(iter_duration, minIterationDuration)` | s/iter | bảng KH |
| `λ_peak × W` | số VU **đồng thời bận** tại đỉnh rate | VU | bảng KH |
| `ceil(...)` | làm tròn lên (không có nửa VU) | VU | - |
| `M` | số VU thực tế trong pool = `preAllocatedVUs + spawned_unplanned` | VU | bảng KH |
| `C = M / W` | capacity của pool M VU = bao nhiêu iter/s phục vụ được | iter/s | bảng KH |
| `λ_current − C` | phần dư khi rate vượt năng lực (= drop) | iter/s | - |

**Đây chính là Little's Law** đã thấy ở `1.3`:

```text
L(t) = λ(t) × W
     = số VU bận đồng thời tại t

required_vus = max L(t) = λ_peak × W   (đủ cho đỉnh)
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

#### Vì sao công thức là `λ × W` (giải thích từ định nghĩa)

Đây là **Little's Law** — định luật cơ bản của hệ thống hàng đợi
(queueing theory). Phát biểu chính xác:

```text
L = λ × W

L = số "items" trung bình trong hệ thống ở trạng thái steady-state
λ = arrival rate trung bình (items vào hệ thống / đơn vị thời gian)
W = thời gian trung bình 1 item ở trong hệ thống
```

**Phát biểu cho k6 arrival-rate**:

```text
Hệ thống = pool VU
Item     = iteration
L(t)     = số iteration đang chạy tại t = số VU đang bận tại t
λ(t)     = rate slot fire (mục tiêu scheduler)
W        = iter_time (thời gian 1 iter chiếm 1 VU)

Steady-state: L = λ × W
```

**Chứng minh trực quan từ "đếm số iter đang chạy"**:

Tại 1 thời điểm `t`, đếm số VU đang bận = số iter đang chạy.

```text
Mỗi iter mất W giây để hoàn thành.
=> 1 iter đang chạy tại t = nó được start trong window [t − W, t].

Số iter start trong window [t − W, t]:
  = rate × thời gian window
  = λ × W

(giả sử λ ổn định trong window, đây là điều kiện steady-state)

=> L(t) = λ × W
```

**Chứng minh bằng số (rate=10/s, W=0.5s)**:

```text
slot_interval = 1/10 = 100ms
W = 500ms = 5 × slot_interval

Window [0, 500ms]:
  slot fire tại t = 0, 100, 200, 300, 400 ms (5 slot)
  iter#0 (start tại t=0)   bận đến t=500ms  → đang bận tại t=500ms
  iter#1 (start tại t=100) bận đến t=600ms  → đang bận tại t=500ms
  iter#2 (start tại t=200) bận đến t=700ms  → đang bận tại t=500ms
  iter#3 (start tại t=300) bận đến t=800ms  → đang bận tại t=500ms
  iter#4 (start tại t=400) bận đến t=900ms  → đang bận tại t=500ms

→ L(t=500ms) = 5 VU đang bận = 10 × 0.5 = λ × W ✓
```

#### Vì sao `W` dùng `max(iter_duration, minIterationDuration)`?

Phát sinh từ **behavior k6 sleep bù**: nếu code chạy nhanh hơn
`minIterationDuration`, k6 chèn 1 sleep nội bộ để VU bận đủ
`minIterationDuration` trước khi return về pool.

```text
iter_duration            = thời gian thực sự code chạy
minIterationDuration     = sàn k6 ép buộc

Nếu iter_duration < minIterationDuration:
  k6 sleep (minIterationDuration − iter_duration) thêm
  → VU bận tổng cộng minIterationDuration

Nếu iter_duration >= minIterationDuration:
  → VU bận = iter_duration (không bù gì)

→ W_effective = max(iter_duration, minIterationDuration)
```

Ví dụ:

```text
code mất 0.2s, minIterationDuration = 1s
=> W = max(0.2, 1) = 1s
=> rate=10/s cần ceil(10 × 1) = 10 VU (không phải 2 VU)
```

#### Khi nào Little's Law KHÔNG áp được?

Little's Law cần **steady-state** và **arrival rate ổn định**. Trong
ramping-arrival-rate có 3 tình huống lệch:

```text
1) Transient state đầu stage ramp lên gắt
   - λ vừa nhảy từ 1/s lên 10/s, hệ chưa kịp filling
   - L(t) tăng dần từ 1 → 10 trong vài chu kỳ W
   - Tại window nhỏ, L(t) < λ × W (chưa đầy)
   → Sau ~2W giây hệ ổn định, công thức lại đúng.

2) Ramp xuống gắt (rate giảm nhanh)
   - λ vừa giảm từ 10/s xuống 1/s
   - VU đang bận từ rate cao chưa kịp xong
   - L(t) > λ × W trong vài chu kỳ W (residual)
   → Tạm thời đông VU bận hơn công thức đoán.

3) Đỉnh ngắn hơn W (rate spike < W giây)
   - Vd hold 10/s chỉ trong 0.1s với W=0.5s
   - Window quan sát chưa kịp filling đã hết spike
   - L thực tế < λ_peak × W
   → Trong thực tế ramp k6 hiếm khi có spike < W.
```

→ Trong load test thường (stage >= 5W), Little's Law là xấp xỉ tốt.
Sizing dùng `λ_peak × W` luôn là **giới hạn trên** (upper bound) của
số VU đồng thời, do đó an toàn.

#### Quan hệ ba biến `λ_peak, M, W` quyết định drop hay không

```text
Không drop khi capacity đủ phục vụ rate đỉnh:
   C ≥ λ_peak
   M / W ≥ λ_peak
   M ≥ λ_peak × W            (= required_vus)

→ 3 cách giảm drop:
  (a) Tăng M:        thêm VU (preAllocatedVUs hoặc maxVUs)
  (b) Giảm W:        code nhanh hơn, bỏ minIterationDuration
  (c) Giảm λ_peak:   hạ stage.target xuống
```

Quyết định phụ thuộc context:

```text
- Test stress server → KHÔNG hạ λ_peak, tăng M.
- Test code logic → có thể hạ λ_peak để loại drop.
- Test thiết kế cố ý drop → giữ M nhỏ (xem 3.5).
```

#### Ví dụ tính tay (số cụ thể) cho config demo 3.3

Áp toàn bộ bảng ký hiệu vào config `λ_peak=8/s, sleep(0.4)`:

```text
Bước 1: Đọc config
  λ_peak (từ stage.target) = 8 iter/s
  W (từ code: sleep(0.4))  = 0.4 s/iter
  preAllocatedVUs          = 5 (đã set)
  maxVUs                   = 10

Bước 2: Tính required_vus
  L_peak = λ_peak × W = 8 × 0.4 = 3.2 VU đồng thời bận tại đỉnh
  required = ceil(L_peak) = ceil(3.2) = 4 VU

Bước 3: So với pool
  preAllocatedVUs = 5 ≥ 4 ✓     → KHÔNG drop tại đỉnh
  maxVUs           = 10 ≥ 5     → có quota unplanned (an toàn)

Bước 4: Tính capacity với pool 5 VU
  C_5 = 5 / 0.4 = 12.5 iter/s ≥ λ_peak=8 ✓

Bước 5: Verify drop
  drop(t) = max(0, λ(t) − C_5)
  Trên cả timeline λ(t) ∈ [0, 8] ≤ 12.5
  → drop(t) = 0 với mọi t → tổng dropped = 0
```

**Ngược lại nếu chỉ có M=3 VU**:

```text
C_3 = 3 / 0.4 = 7.5 iter/s
Tại λ=8: drop = 8 − 7.5 = 0.5 iter/s
Trong stage hold 8/s × 3s = 1.5 slot drop
→ summary sẽ thấy dropped_iterations ≈ 1-2.
```

#### Caveat / Edge case

```text
- W phải là iter_time HIỆU DỤNG, gồm sleep, http wait, minIterationDuration.
- Nếu code có sleep ngẫu nhiên: dùng W ≈ p95(iter_duration) cho an toàn.
- Little's Law cho ramping chỉ đúng "trung bình", có jitter ở biên stage.
- Nếu set maxVUs > preAllocatedVUs, M có thể tăng dần → C tăng dần.
- W không cố định nếu server response time biến động → C cũng biến động.
```

#### Tóm gọn 3.3

```text
required_vus = ceil(λ_peak × W)             <- sizing
C            = M / W                          <- năng lực M VU
drop(t)      = max(0, λ(t) − C)               <- phần vượt

Quy tắc:
  preAllocatedVUs >= required_vus × 1.2 (buffer 20%)
  maxVUs >= preAllocatedVUs (mặc định bằng nhau nếu không khai báo)
```

### 3.4. Rate thực tế sau test (vs rate target trong config)

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
actual_rate     = N_done / T_run
http_reqs_rate  = total_http_requests / T_run
checks_rate     = total_checks / T_run
```

| Biến | Ý nghĩa | Đơn vị | Ref |
| --- | --- | --- | --- |
| `N_done` | số iter HOÀN THÀNH (không drop, không interrupt) | iter | bảng KH |
| `actual_rate` | rate thực tế summary in trong cột `iterations.../s` | iter/s | bảng KH |
| `total_http_requests` | tổng HTTP request đã gửi | req | summary `http_reqs` |
| `T_run` | runtime thực tế khi summary tính rate (mẫu số cột `/s`) | s | bảng KH |

#### `T_run` là gì?

Mẫu số core dùng cho cột `/s` của Counter. Trong demo 1 scenario, không
`setup()/teardown()`, `startTime=0`:

```text
T_run ≈ thời gian scenario thật sự chạy (regular_duration + grace nếu có dùng)
```

Nhưng KHÔNG NÊN đồng nhất với `T` (= total_regular_duration):

```text
T      = sum(d_i)             = lý thuyết (tổng stage)
T_run  = thời gian summary đo  = thực tế khi chạy, có thể chênh ±1s
```

Quan hệ:

```text
T ≤ T_run ≤ T + gracefulStop

- T_run = T              khi mọi iter xong trước hết regular_duration
- T_run = T + grace      khi có iter "kéo dài" hết grace
- T_run ∈ (T, T+grace)   trường hợp giữa
```

#### 3 rate phân biệt (đã thống nhất ký hiệu)

```text
1) λ_peak       [iter/s, mục tiêu cao nhất] - dùng SIZING (3.3)
2) λ_avg        [iter/s, trung bình lịch start = N_sched/T] - đối chiếu (3.2)
3) actual_rate  [iter/s, completed thực tế = N_done/T_run] - KPI cuối cùng
```

#### Vì sao `λ_peak ≥ λ_avg ≥ actual_rate`?

**Phần 1: `λ_peak ≥ λ_avg`** (đỉnh luôn ≥ trung bình)

Trực quan: λ_avg là trung bình của λ(t), nên không thể vượt giá trị
lớn nhất λ_peak.

```text
λ_avg = N_sched / T = trung bình của λ(t) trên đoạn [0, T]
λ_peak = max của λ(t)

Trung bình ≤ max → λ_avg ≤ λ_peak ✓

Đẳng thức xảy ra khi λ(t) = const = λ_peak (timeline phẳng,
1 stage hold suốt scenario).
```

**Phần 2: `λ_avg ≥ actual_rate`** (target ≥ thực tế)

Trực quan: completed luôn ≤ scheduled, vì có drop và interrupt.

```text
N_done = N_sched − N_drop − N_int   (đã trừ drop và interrupt)

→ N_done ≤ N_sched (luôn)

actual_rate = N_done / T_run
λ_avg       = N_sched / T

Trường hợp đơn giản T_run = T (không dùng grace):
  actual_rate = N_done / T ≤ N_sched / T = λ_avg ✓

Trường hợp T_run > T (dùng grace):
  N_done vẫn ≤ N_sched
  T_run > T → mẫu số lớn hơn → actual_rate càng nhỏ
  → vẫn ≤ λ_avg ✓
```

**Đẳng thức xảy ra khi nào?**

```text
λ_peak = λ_avg khi rate phẳng (1 stage hold suốt scenario)
λ_avg = actual_rate khi N_drop = N_int = 0 và T_run = T
                    (tức test "hoàn hảo": đủ VU, không grace)
```

#### `N_done` quan hệ với scheduled

```text
N_done ≈ N_sched − N_drop − N_int

Xấp xỉ vì:
  + biên slot (xem 3.1 caveat 2: slot đầu lệch t=0)
  + slot cuối có thể đã fire nhưng iter chưa xong (chưa kịp tính done)
  + part-slot mang sang stage sau (xem 3.1 caveat 1)
  → có thể lệch ±1 slot
```

#### Áp config demo 3.4 vào quan hệ (ví dụ tính tay)

Config: `preAlloc=3, maxVUs=3, sleep(0.5)`, stage `2s, 3s, 2s` target
`4, 4, 0` (giống demo 3.2):

```text
Bước 1: Tính lý thuyết từ CONFIG
  λ_peak  = 4 iter/s
  N_sched = 4 + 12 + 4 = 20 slot     (xem 3.1)
  T       = 7s
  λ_avg   = 20 / 7 ≈ 2.857 iter/s

  → Đây là con số 2.86/s trong câu hỏi
  → Nó là TARGET TRUNG BÌNH: nếu mọi slot đều hoàn thành, k6 sẽ đạt rate này

Bước 2: Sizing kiểm tra
  required = ceil(λ_peak × W) = ceil(4 × 0.5) = 2 VU
  M = 3 VU → C = 3 / 0.5 = 6 iter/s ≥ λ_peak=4 ✓
  → Lý thuyết KHÔNG drop (nếu W chính xác = 0.5s)

Bước 3: Đọc summary THẬT
  iterations: 18    actual_rate ≈ 2.571/s

  → actual_rate = 18 / 7 = 2.571/s
  → Có lệch: 20 (lý thuyết) − 18 (thực tế) = 2 iter không hoàn thành

Bước 4: So sánh 3 con số rate
  ┌─────────────────┬──────────┬─────────────────────────────┐
  │ Rate             │ Giá trị  │ Đến từ                      │
  ├─────────────────┼──────────┼─────────────────────────────┤
  │ λ_peak           │ 4.000/s  │ max(startRate, targets)     │
  │ λ_avg            │ 2.857/s  │ N_sched / T = 20/7         │
  │ actual_rate      │ 2.571/s  │ N_done / T_run = 18/7      │
  └─────────────────┴──────────┴─────────────────────────────┘

  Khoảng cách:
    λ_peak → λ_avg:      4.000 - 2.857 = 1.143/s  (do rate thay đổi theo thời gian)
    λ_avg  → actual_rate: 2.857 - 2.571 = 0.286/s  (do 2 slot không hoàn thành)

  Ý nghĩa từng khoảng cách:
    λ_peak - λ_avg = 1.143/s: "rate dao động bao nhiêu trong timeline"
      → không phải lỗi, là do thiết kế ramp-up/ramp-down
    λ_avg - actual_rate = 0.286/s: "hao hụt do drop/interrupt/biên slot"
      → 2 slot mất trên tổng 20 = 10% hao hụt

Bước 5: Giải thích 2 slot mất
  Nguyên nhân có thể:
  (a) iter_duration thực tế > 0.5s (cộng overhead startup VU)
      → W_thực ≈ 0.55-0.6s → C_thực = 3/0.6 = 5/s vẫn ≥ λ_peak ✓
  (b) Slot đầu fire muộn so với t=0 (caveat 2 ở 3.1)
      → 1-2 slot không kịp fire trong T=7s → không drop, chỉ thiếu
  (c) Race spawn unplanned (xem 3.16)
      → trong demo này maxVUs=preAlloc nên KHÔNG có spawn → không liên quan
  → Khả năng cao là (b): biên slot.

Bước 6: Verify quan hệ bất đẳng thức
  λ_peak = 4   ≥   λ_avg = 2.857   ≥   actual_rate = 2.571 ✓
  4 ≥ 2.857 ≥ 2.571 (đúng cả 2 vế).

Bước 7: Tính N_drop, N_int
  N_done = 18, N_sched ≈ 20
  N_drop + N_int ≈ 2 (kiểm tra summary cụ thể)
  Trong demo này iter=0.5s ngắn, không có ai bị grace cancel
  → N_int = 0, N_drop ≈ 2 (hoặc 1 + 1 lệch biên).
```

**── Sơ đồ: từ config → 3 rate ──**

```text
CONFIG                              SUMMARY
──────                              ───────
startRate=0                         iterations.........: 18    2.571428/s
stages:                             http_reqs..........: 36    5.142857/s
  2s: 0→4/s  ┐
  3s: 4/s    ├─► N_sched=20 slot
  2s: 4→0/s  ┘

              ┌──────────────────────────────────────────────────┐
              │                                                  │
  N_sched=20  │  λ_avg = 20/7 = 2.857/s  ←── TARGET TRUNG BÌNH │
  T=7s        │           (mục tiêu scheduler)                   │
              │                                                  │
              │         trừ drop + interrupt + biên slot          │
              │                    ↓                             │
              │  actual_rate = 18/7 = 2.571/s ←── THỰC TẾ       │
              │           (KPI cuối cùng)                        │
              │                                                  │
              │  λ_peak = 4/s  ←── DÙNG ĐỂ SIZING VU            │
              │           (rate cao nhất, dù chỉ trong 1s)       │
              └──────────────────────────────────────────────────┘

Trả lời câu hỏi "vì sao config ra 2.86?":
  2.86 = 20 slot / 7 giây
       = trung bình toàn timeline của lịch start
       = NẾU không drop, completed rate cũng sẽ ≈ 2.86/s

Trả lời "vì sao summary chỉ 2.57?":
  2.57 = 18 iter / 7 giây
       = thực tế chỉ 18 trong 20 slot hoàn thành
       = 2 slot mất (có thể drop hoặc biên slot)
```

#### Phân biệt `iterations rate` vs `http_reqs rate`

```text
iterations rate   = N_done / T_run   (số iter HOÀN THÀNH)
http_reqs rate    = total_http_requests / T_run

Quan hệ:
  total_http_requests ≈ N_done × số_request_per_iter (nếu code không có nhánh fail)

Ví dụ với 2 request/iter:
  N_done = 18 -> http_reqs = 36
  iterations rate = 2.57/s -> http_reqs rate = 5.14/s
```

→ rate http_reqs **không phải** rate slot, mà là rate request đã gửi
thành công trong các iter HOÀN THÀNH.

#### Caveat / Edge case

```text
- T_run vs T có thể lệch khi:
  + scenario dừng sớm (abort, error fatal)
  + scenario dùng hết grace (iter cuối kéo dài)
  → kiểm tra summary header để biết T_run thực tế.

- N_done không bằng N_sched ngay cả khi không drop:
  + slot fire ở t=T-ε mà iter chưa kịp xong → không tính done
  + slot biên (caveat 3.1) lệch ±1

- Nếu actual_rate > λ_avg → BẤT THƯỜNG, cần check lại:
  + summary_runtime_base có đúng không
  + có nhầm metric (vd dùng http_reqs thay iterations)
  + có duplicate counter (multi-scenario)

- λ_peak ≥ λ_avg là tính chất của trung bình (đã giải thích ở trên),
  không phụ thuộc vào behavior k6.
```

#### Tóm gọn 3.4

```text
actual_rate = N_done / T_run        <- KPI thực tế (summary in)
λ_avg       = N_sched / T            <- mục tiêu lý thuyết
λ_peak      = max(λ_start, λ_i_end)  <- đỉnh rate

Quan hệ thứ tự (luôn đúng):
  λ_peak ≥ λ_avg ≥ actual_rate

Càng sát nhau -> hệ thống chịu rate càng tốt
Lệch xa -> kiểm tra dropped/interrupted (3.5)
```

### 3.5. Phân biệt `dropped` vs `interrupted`: chưa start vs đã start nhưng không finish

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

#### Phân tích công thức

```text
N_drop = số slot fire mà TryRunIteration() return false
N_int  = số iter đã start mà context cancel giữa chừng
N_done = N_sched − N_drop − N_int   (xấp xỉ ±1 do biên slot, xem 3.1 caveat)
```

| Biến | Ý nghĩa | Đơn vị | Nguồn |
| --- | --- | --- | --- |
| `N_drop` | số slot fire mà không có VU rảnh | slot | summary metric `dropped_iterations` |
| `N_int` | số iter đã start mà bị cancel | iter | progress/footer (`X interrupted iterations`) |
| `N_done` | số iter chạy xong sạch | iter | summary `iterations` |
| `N_sched` | tổng slot dự kiến (xem `3.1`) | slot | tự tính từ config |

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

#### Lệch giữa N_sched và (N_done + N_drop + N_int)

Quan hệ chính xác là:

```text
N_done + N_drop + N_int = N_sched ± biên_slot
```

Lệch về phía nào?

```text
Trường hợp lệch DƯƠNG (N_done + N_drop + N_int > N_sched):
  - hiếm gặp
  - có thể do double-count (xem 3.16 race spawn)
  → kiểm tra log, không phải logic sizing

Trường hợp lệch ÂM (N_done + N_drop + N_int < N_sched):
  - thường gặp
  - slot biên cuối stage chưa kịp fire trong T
  - slot đầu lệch t=0 (caveat 2 ở 3.1)
  - phần lẻ doneSoFar mang sang stage cuối chưa fire hết
  → lệch 1-2 slot là bình thường, không cần xử lý
```

#### Ví dụ tính tay (số cụ thể) cho config demo 3.5

Config: `preAlloc=2, maxVUs=2, gracefulStop=1s, sleep(2)`, stages
`3s target=4, 2s target=4`:

```text
Bước 1: Tính lý thuyết
  λ_peak = 4 iter/s
  λ_avg  = (3 × 4 + 2 × 4) / (3+2) = 20/5 = 4/s   (hold suốt nên = peak)
  N_sched = 5 × 4 = 20 slot
  T = 5s

Bước 2: Sizing đáng lẽ
  required = ceil(λ_peak × W) = ceil(4 × 2) = 8 VU
  M = 2 VU (CỐ TÌNH thiếu) → C = 2 / 2 = 1 iter/s
  → drop_rate = 4 − 1 = 3 iter/s liên tục
  → N_drop_lý_thuyết ≈ 3 × 5 = 15 slot

Bước 3: Lý thuyết N_done
  N_done_lý_thuyết = N_sched − N_drop = 20 − 15 = 5 iter
  Kiểm tra với capacity: C × T = 1 × 5 = 5 iter ✓

Bước 4: Tính N_int
  Tại t = T = 5s, các VU đang chạy iter (chưa kịp xong vì sleep(2)).
  Grace = 1s. iter cuối cần 2s nữa, chỉ được grace 1s → cancel sau 1s.
  → 2 VU đang bận tại t=5s → 2 iter bị interrupt sau grace.
  N_int ≈ 2

Bước 5: Verify đẳng thức
  N_done + N_drop + N_int = 5 + 15 + 2 = 22
  N_sched = 20
  → lệch +2: do biên slot (2 iter cuối tính cả vào "đã start trong window
    cuối" nhưng cũng tính vào "sẽ fire trong slot 19-20")
  → trong thực tế summary có thể thấy: N_done=18, N_drop=5, N_int=2
    (số demo trong section là 18/5/2)

Bước 6: Số trong demo summary thật (đề bài)
  iterations: 18, dropped_iterations: 5, interrupted: 2
  N_done + N_drop + N_int = 25 > 20
  → Sai lệch dương: do iter chạy DÀI (sleep(2)) → grace cho phép
    fire thêm slot trong window grace, fire thêm slot ngoài T
  → cho thấy N_sched chỉ là số "lý thuyết" trong T, có thể thấp hơn
    số thực tế khi grace dài.

  Bài học: nếu scenario kết thúc bằng iter dài, grace cho phép fire
  thêm slot ngoài T → N_sched lý thuyết (chỉ trong T) có thể thấp
  hơn số slot thật sự đã fire trong window T + gracefulStop.
```

#### Verify công thức khi cộng số từ demo cụ thể

Lấy 3 demo đã có trong file:

```text
Demo 3.4 (preAlloc=3, maxVUs=3, sleep(0.5), stages 4/4/0):
  N_sched = 20, N_done = 18, N_drop = 2, N_int = 0
  18 + 2 + 0 = 20 = N_sched ✓ (khớp tuyệt đối)

Demo 3.5 (preAlloc=2, maxVUs=2, sleep(2), stages 4/4):
  N_sched = 20, N_done = 18, N_drop = 5, N_int = 2
  18 + 5 + 2 = 25 > N_sched (lệch +5 do grace fire thêm)

Demo 3.3 (preAlloc=5, maxVUs=10, sleep(0.4), stages 8/8):
  N_sched ≈ 4 + 24 = 28 slot (tự tính theo 3.1)
  N_done ≈ 28, N_drop = 0, N_int = 0
  28 + 0 + 0 = 28 ✓
```

→ Khớp tốt khi không có grace dài. Lệch khi grace cộng thêm slot.

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

Sai số vì gap không hoàn toàn = `1/rate(t_k)` mà còn phụ thuộc rate ở slot trước.
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

## 6. Cheat sheet — Công thức cần nhớ nhất

> Phần này dành cho người mới. Mỗi công thức có **tên tiếng Việt**, ví dụ
> đời thường, và "khi nào dùng". Đọc xong section này là dùng được ngay
> mà không cần đọc 3.1-3.5 chi tiết.

### 6.0. Config chung của `ramping-arrival-rate`

Đây là **bộ config đầy đủ** cho executor `ramping-arrival-rate`. Đọc bảng
này trước khi viết test, biết tham số nào BẮT BUỘC, tham số nào có default.

#### Template config đầy đủ

```js
export const options = {
  scenarios: {
    my_scenario: {
      // === BẮT BUỘC ===
      executor: "ramping-arrival-rate",   // tên executor
      stages: [                           // mảng stage, ít nhất 1 stage
        { duration: "2s", target: 10 },
        { duration: "5s", target: 10 },
        { duration: "2s", target: 0 },
      ],
      preAllocatedVUs: 5,                 // số VU sẵn từ đầu

      // === TUỲ CHỌN (có default) ===
      startRate: 0,                       // default = 0 iter/timeUnit
      timeUnit: "1s",                     // default = "1s"
      maxVUs: 10,                         // default = preAllocatedVUs
      gracefulStop: "30s",                // default = "30s" (từ BaseConfig)
      startTime: "0s",                    // default = "0s"
      exec: "default",                    // default = "default" function
      tags: { test: "demo" },             // default = {}
      env: { DEBUG: "1" },                // default = {}
    },
  },
};

export default function () {
  // code chạy mỗi iter
}
```

#### Bảng tham số chi tiết

| Tham số | Required? | Default | Đơn vị | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | **BẮT BUỘC** | — | string | Phải đặt là `"ramping-arrival-rate"` |
| `stages` | **BẮT BUỘC** | — | array | Ít nhất 1 stage, mỗi stage có `duration` + `target` |
| `stages[].duration` | **BẮT BUỘC** | — | duration | Thời gian stage (vd `"2s"`, `"1m"`) |
| `stages[].target` | **BẮT BUỘC** | — | int | Rate đích ở cuối stage (số iter/timeUnit) |
| `preAllocatedVUs` | **BẮT BUỘC** | — | int | Số VU sẵn sàng từ đầu test |
| `startRate` | tuỳ chọn | `0` | int | Rate lúc bắt đầu scenario |
| `timeUnit` | tuỳ chọn | `"1s"` | duration | Đơn vị của rate (vd `"1s"`, `"1m"`) |
| `maxVUs` | tuỳ chọn | `= preAllocatedVUs` | int | Trần VU tối đa (cho phép spawn unplanned) |
| `gracefulStop` | tuỳ chọn | `"30s"` | duration | Grace cuối scenario cho iter đang chạy |
| `startTime` | tuỳ chọn | `"0s"` | duration | Trễ trước khi scenario bắt đầu |
| `exec` | tuỳ chọn | `"default"` | string | Tên function JS chạy mỗi iter |
| `tags` | tuỳ chọn | `{}` | object | Tag attach vào metric của scenario |
| `env` | tuỳ chọn | `{}` | object | Biến môi trường riêng cho scenario |

#### 4 quy tắc validate (đọc từ core)

```text
1. preAllocatedVUs phải có và >= 0
   (nếu thiếu: lỗi "the number of preAllocatedVUs isn't specified")

2. startRate >= 0
   (nếu âm: lỗi "the startRate value can't be negative")

3. timeUnit > 0
   (nếu <= 0: lỗi "the timeUnit must be more than 0")

4. maxVUs >= preAllocatedVUs
   (nếu nhỏ hơn: lỗi "maxVUs can't be less than preAllocatedVUs")
   (nếu không khai báo: tự động bằng preAllocatedVUs)
```

Code ref: `ramping_arrival_rate.go:87-114` (function `Validate()`).

#### Config tối thiểu (chạy được)

Nếu chỉ muốn config gọn nhất:

```js
export const options = {
  scenarios: {
    minimal: {
      executor: "ramping-arrival-rate",
      preAllocatedVUs: 5,
      stages: [{ duration: "10s", target: 10 }],
    },
  },
};
```

5 dòng đủ chạy. Các field khác lấy default.

### 6.1. 5 công thức TOP cần thuộc lòng

#### Công thức 1: "Cần bao nhiêu nhân viên?" (Sizing VU)

```text
required_vus = ceil(λ_peak × W) × 1.2
```

**Tiếng Việt**: "Số nhân viên cần = (số khách đỉnh điểm/giây) × (thời
gian phục vụ 1 khách) × 1.2 (dự phòng 20%)"

**Ví dụ đời thường**:

```text
Quán phở giờ cao điểm có 10 khách/phút vào.
Mỗi khách ăn xong mất 5 phút.
=> cần 10 × 5 = 50 chỗ ngồi (+20% dự phòng = 60 chỗ)
```

**Áp vào k6**:

```text
rate đỉnh = 10 iter/giây
1 iter chạy mất 0.5s
=> cần 10 × 0.5 = 5 VU (+20% = 6 VU)
```

**Vì sao buffer 20%?**

`required_vus = λ × W` chỉ đúng ở điều kiện lý tưởng. Thực tế có 4 nguồn
biến thiên khiến số VU CẦN THỰC TẾ cao hơn. Lấy lại ví dụ quán phở:

**1. iter_time biến thiên (thời gian phục vụ không đều)**

```text
Đời thường:
  Trung bình mỗi khách ăn 5 phút, NHƯNG:
  - khách trẻ ăn 3 phút (nhanh)
  - khách nói chuyện điện thoại ăn 8 phút (chậm)
  - 95% khách ăn ≤ 6.5 phút (p95 cao hơn avg 30%)
  -> nếu chỉ tính 50 chỗ theo avg, lúc đông khách ăn lâu sẽ thiếu chỗ

Áp vào k6:
  iteration_duration avg = 0.5s, p95 = 0.65s
  -> server lag, GC pause, network jitter làm 1 số iter chậm hơn
```

**2. Slot fire jitter (khách đến không đều tuyệt đối)**

```text
Đời thường:
  10 khách/phút trung bình, nhưng đến lúc lệch nhau:
  - có lúc 3 khách vào cùng phút (dồn cụm)
  - có lúc cả phút không ai vào
  -> phải dư 1-2 chỗ cho lúc dồn cụm

Áp vào k6:
  k6 fire slot không đều tuyệt đối, có vài ms jitter
  Đôi khi 2 slot dồn lại cùng thời điểm -> cần 1 VU dư
```

**3. Boundary effect (giờ chuyển ca / chuyển stage)**

```text
Đời thường:
  Quán chuyển giữa ca trưa (6 khách/phút) sang ca tối (12 khách/phút).
  Trong 30 giây chuyển ca, khách dồn lên 13/phút (vượt target 1 chút).
  -> cần dư VÀI chỗ cho moment chuyển

Vì sao có "dồn cụm"?
  - Lễ tân chưa kịp xử lý hết khách ca trưa khi ca tối bắt đầu
  - Khách ca tối đến đúng giờ, gặp khách ca trưa chưa rời -> dồn

Áp vào k6:
  Tại biên giới giữa 2 stage, có 3 nguyên nhân kỹ thuật:

  (a) Floating point precision khi tính slot:
      cal() dùng nghiệm bậc 2 (sqrt) để tìm mốc fire
      sqrt trả số lẻ -> làm tròn ms -> slot fire sớm/muộn 0.1-0.5ms

  (b) doneSoFar tích lũy phần lẻ giữa stage:
      Stage trước có 12.3 slot -> fire 12, dư 0.3 mang sang stage sau
      Stage sau fire slot đầu sớm hơn -> dồn cụm nhỏ tại biên

  (c) Window đo rate ngắn:
      Đo rate trong window 5ms tại biên có thể thấy vượt target 1-2%
      (window càng ngắn càng dao động lớn)

  -> rate "trung bình" vẫn đúng, nhưng instant rate trong vài ms biên
     có thể vượt target 1-2%
```

**4. Scheduler overhead (lễ tân bố trí chỗ tốn vài giây)**

```text
Đời thường:
  Khách đến quán phải qua các bước:
  - Lễ tân chào hỏi          (~5 giây)
  - Tìm bàn trống            (~10 giây)
  - Hướng dẫn vào chỗ        (~5 giây)
                              -----
                              ~20 giây trước khi khách thực sự ngồi

  Trong 20 giây đó, khách "ngồi tạm" ở khu chờ -> cần thêm 1-2 ghế chờ.

Áp vào k6:
  Mỗi slot fire có 5 bước nhỏ trong Go runtime:

  1. Timer wake up        (đánh thức goroutine từ sleep)   ~0.1ms
  2. Send vào channel     (vusPool.iterations <- ...)       ~0.05ms
  3. VU goroutine receive (for range p.iterations)          ~0.05ms
  4. Activate VU context  (tạo runtime cho iter)            ~0.5ms
  5. Bắt đầu chạy JS      (entry vào default function)      ~0.3ms
                                                             -----
                                                  tổng ~1ms

  Nếu rate=1000/s: overhead = 1ms × 1000 = 1 giây tích lũy mỗi giây
  -> rất đáng kể
  Nếu rate=10/s:   overhead = 1ms × 10  = 10ms (không đáng kể)

  -> overhead này KHÔNG ảnh hưởng iter_time đo được, NHƯNG có thể
     làm chậm slot fire vài ms -> cần buffer VU
```

→ 4 nguồn biến thiên này cộng lại thường rơi vào 10-50%, nên buffer 20%
là điểm vừa phải.

**Buffer factor tuỳ tình huống** (vẫn dùng ví dụ quán phở):

| Buffer | Tình huống quán phở | Tình huống k6 |
| --- | --- | --- |
| 1.1 (10%) | Quán có khách đều, không đông giờ cao điểm | Code chỉ `sleep`, không HTTP |
| **1.2 (20%)** | **Default — quán quen** | **Code có HTTP nhẹ, latency ổn** |
| 1.5 (50%) | Quán có khách giờ cao điểm bất thường | HTTP với p99 spike, server chia sẻ |
| 2.0+ (100%+) | Quán stress test dịp Tết, lễ | Stress test dài, server có thể degrade |

**Công thức đầy đủ**:

```text
required_vus = ceil(λ_peak × W) × buffer_factor
buffer_factor ∈ [1.1, 2.0+]   (chọn theo độ ổn định của hệ thống)

preAllocatedVUs = 6
```

**Khi nào dùng**: trước khi chạy test, để biết đặt `preAllocatedVUs`
bao nhiêu cho đủ.

#### Công thức 2: "Đỉnh rate là bao nhiêu?" (Tìm rate cao nhất)

```text
λ_peak = max(startRate, mọi stage.target) / timeUnit
```

**Tiếng Việt**: "Rate đỉnh = lấy con số LỚN NHẤT trong số: startRate
và tất cả stage.target, rồi chia cho timeUnit"

**Ví dụ**:

```text
config:
  startRate: 0
  timeUnit: "1s"
  stages:
    - duration: "2s", target: 10
    - duration: "5s", target: 4
    - duration: "2s", target: 0

số lớn nhất = max(0, 10, 4, 0) = 10
λ_peak = 10 / 1s = 10 iter/giây
```

**Khi nào dùng**: bước đầu tiên trước Công thức 1 — phải biết đỉnh
rate trước thì mới sizing được.

**Lưu ý**: KHÔNG dùng rate trung bình (`λ_avg`) để sizing. Vì giữa
stage rate có thể vọt lên đỉnh, và VU phải đủ chịu lúc đỉnh đó.

#### Công thức 3: "Tổng có bao nhiêu lượt start?" (Đếm slot 1 stage)

```text
scheduled_slots = duration × (rate_đầu + rate_cuối) / 2
```

**Tiếng Việt**: "Tổng slot = thời gian stage × rate trung bình của
stage (trung bình rate đầu và rate cuối)"

**TRƯỚC KHI ĐỌC TIẾP — "rate" trong section này là gì?**

Khi nói "rate = 10/s" trong context `ramping-arrival-rate`, ý là:

```text
rate = TARGET RATE của scheduler
     = số slot scheduler MUỐN fire mỗi giây (mục tiêu)
     = stage.target / timeUnit_seconds

KHÔNG phải:
  - rate iter HOÀN THÀNH (= actual throughput, đo từ summary)
  - rate HTTP request gửi đi (= http_reqs/s)
  - rate VU đang bận
```

Ví dụ:

```text
Config: stage.target = 10, timeUnit = "1s"
=> rate = 10/s
=> nghĩa là "scheduler có nhiệm vụ fire 10 slot/giây" (mục tiêu)
=> KHÔNG nghĩa "10 iter hoàn thành/giây"
   (số iter hoàn thành phụ thuộc VU có rảnh không)
```

Trong section này, tất cả "rate" đều là **target rate của scheduler**:

```text
rate_đầu  = rate target ở đầu stage  (= λ_prev = stage trước.target / timeUnit)
rate_cuối = rate target ở cuối stage (= λ_next = stage này.target / timeUnit)
rate(t)   = rate target tại thời điểm t (đường thẳng nội suy)
```

**Ví dụ áp vào config 3 stage thực tế**:

```js
startRate: 0,
timeUnit: "1s",
stages: [
  { duration: "2s", target: 10 },   // stage 0
  { duration: "5s", target: 4 },    // stage 1
  { duration: "2s", target: 0 },    // stage 2
],
```

**Cách tính rate_đầu và rate_cuối cho từng stage**:

Quy tắc chung:

```text
rate_đầu của stage N = rate_cuối của stage (N-1)
                     = stage trước.target / timeUnit_seconds
                     (riêng stage 0: rate_đầu = startRate / timeUnit_seconds)

rate_cuối của stage N = stage N.target / timeUnit_seconds
```

Vì `timeUnit = "1s"` nên `timeUnit_seconds = 1`. Mọi phép chia là chia
cho 1 → giữ nguyên giá trị.

**Tính từng stage một**:

Stage 0 — stage ĐẦU TIÊN, rate_đầu lấy từ `startRate`:

```text
Đầu vào:
  startRate = 0
  stages[0] = { duration: "2s", target: 10 }
  timeUnit = "1s"  -> timeUnit_seconds = 1

Tính:
  rate_đầu  = startRate / timeUnit_seconds
            = 0 / 1
            = 0/s    (đầu scenario, chưa fire slot nào)

  rate_cuối = stages[0].target / timeUnit_seconds
            = 10 / 1
            = 10/s   (target ở cuối stage 0)

Kết quả:
  Stage 0 = ramp 0/s → 10/s trong 2s
  (rate tăng tuyến tính từ 0 lên 10 trong 2 giây)
```

Stage 1 — stage giữa, rate_đầu lấy từ rate_cuối của stage trước:

```text
Đầu vào:
  Stage 0 đã tính: rate_cuối = 10/s
  stages[1] = { duration: "5s", target: 4 }

Tính:
  rate_đầu  = rate_cuối của stage 0
            = 10/s   (NỐI LIÊN TỤC, không nhảy bậc!)

  rate_cuối = stages[1].target / timeUnit_seconds
            = 4 / 1
            = 4/s

Kết quả:
  Stage 1 = ramp 10/s → 4/s trong 5s
  (rate giảm tuyến tính từ 10 xuống 4 trong 5 giây)
```

Stage 2 — stage CUỐI, vẫn theo cùng quy tắc:

```text
Đầu vào:
  Stage 1 đã tính: rate_cuối = 4/s
  stages[2] = { duration: "2s", target: 0 }

Tính:
  rate_đầu  = rate_cuối của stage 1
            = 4/s    (NỐI LIÊN TỤC)

  rate_cuối = stages[2].target / timeUnit_seconds
            = 0 / 1
            = 0/s

Kết quả:
  Stage 2 = ramp 4/s → 0/s trong 2s
  (rate giảm tuyến tính từ 4 xuống 0, scenario kết thúc với rate=0)
```

**Tóm tắt 3 stage** dưới dạng bảng:

```text
| Stage | rate_đầu | rate_cuối | duration | Diễn giải             |
|-------|----------|-----------|----------|-----------------------|
| 0     | 0/s      | 10/s      | 2s       | Ramp lên (warm up)    |
| 1     | 10/s     | 4/s       | 5s       | Giữ peak rồi giảm dần |
| 2     | 4/s      | 0/s       | 2s       | Ramp xuống (cool down)|
```

Lưu ý: `rate_cuối stage 0` = `rate_đầu stage 1` = `10/s` (giá trị giống
nhau ở 2 chỗ). Đây là cách k6 đảm bảo rate **không nhảy bậc** giữa các
stage — đường rate(t) trên đồ thị là đường gấp khúc liên tục.

**Biết rate_đầu/rate_cuối → tính được slot_interval ra sao?**

**Vì sao cần thêm slot_interval khi đã có rate?**

```text
rate           = "TỐC ĐỘ" fire slot                  (slot/giây)
slot_interval  = "KHOẢNG CÁCH" giữa 2 slot liên tiếp (giây/slot)

2 đại lượng nghịch đảo, đo CÙNG 1 hiện tượng nhưng từ 2 góc nhìn:
  rate          trả lời: "1 giây fire mấy slot?"
  slot_interval trả lời: "slot tiếp theo cách bao xa?"
```

Người mới đọc config thấy `rate=10/s` → khó hình dung. Nhưng đổi sang
`slot_interval=100ms` → ngay lập tức biết "cứ 100ms fire 1 slot, scheduler
phải đẩy slot vào hệ thống mỗi 100ms".

**Công thức tính slot_interval từ rate**:

```text
slot_interval(t) = 1 / rate(t)         (xấp xỉ trực giác, đủ dùng)

Tại biên stage:
  slot_interval đầu stage  ≈ 1 / rate_đầu
  slot_interval cuối stage ≈ 1 / rate_cuối
```

(Công thức chính xác hơn — nghiệm bậc 2 — đã ở phần "Khoảng cách thật
giữa 2 slot liên tiếp" trên đầu, sai số ~5%. Dùng `1/rate` cho ước lượng
nhanh, dùng nghiệm bậc 2 khi cần mốc fire chính xác.)

**Áp vào 3 stage (chỉ tính 2 đầu mỗi stage)**:

```text
| Stage | rate_đầu → rate_cuối | slot_interval đầu → cuối | Pattern        |
|-------|----------------------|--------------------------|----------------|
| 0     | 0 → 10/s             | ∞ → 100ms                | CO LẠI dần    |
| 1     | 10 → 4/s             | 100ms → 250ms            | GIÃN RA dần   |
| 2     | 4 → 0/s              | 250ms → ∞                | GIÃN RA dần   |
```

Diễn giải:

```text
Stage 0: rate tăng -> slot_interval CO LẠI -> mật độ slot DÀY DẦN
Stage 1: rate giảm -> slot_interval GIÃN RA -> mật độ slot THƯA DẦN
Stage 2: rate giảm về 0 -> slot_interval → ∞ -> mật độ slot RẤT THƯA
```

**Ý nghĩa thực tế của slot_interval**:

```text
1. Hình dung "tốc độ fire" tại biên stage
   - Stage 1 đầu: 100ms/slot -> hệ thống nhận burst nhặt
   - Stage 1 cuối: 250ms/slot -> hệ thống được "thở"

2. So với iter_time để dự đoán drop
   - Nếu slot_interval < iter_time/M (M = số VU)
   - Slot fire nhanh hơn năng lực VU xử lý -> DROP

   vd stage 1 đầu (slot=100ms), iter_time=500ms, M=4:
       capacity = 4 / 0.5 = 8 slot/s = slot_interval đủ 125ms
       slot thực = 100ms -> SẮP DROP (capacity sát đỉnh)
       => cần M=5 (capacity 100ms) để an toàn
```

→ slot_interval là **cầu nối** giữa rate (config) và năng lực VU (Little's Law).

**Có rate từng stage rồi, dùng để LÀM GÌ?**

5 mục đích chính:

**(1) Sizing VU — quan trọng nhất**

```text
λ_peak = max(0, 10, 4, 0) = 10/s         (lấy từ bảng trên)
required_vus = ceil(λ_peak × iter_time) × 1.2
            = ceil(10 × 0.5) × 1.2        (với code sleep(0.5))
            = ceil(5) × 1.2 = 6 VU

=> đặt preAllocatedVUs = 6 (ĐỦ cho đỉnh rate)
```

Không có rate từng stage → không biết đỉnh ở đâu → đặt VU sai.

**(2) Tính tổng slot dự kiến (`N_sched`)**

```text
Stage 0: 2 × (0+10)/2 = 10 slot
Stage 1: 5 × (10+4)/2 = 35 slot
Stage 2: 2 × (4+0)/2  = 4  slot
                       -----
                       49 slot

Trước test: biết N_sched = 49 (đáng lẽ chạy được 49 iter)
Sau test:   so với "iterations" trong summary
            - 49 -> hoàn hảo
            - <49 -> có drop hoặc interrupt
```

**(3) Biết stage nào "đỉnh" để FIX khi có vấn đề**

```text
Stage 1 có rate đầu = 10/s (đỉnh) -> đoạn DỄ DROP NHẤT

Nếu sau test có drop:
  -> 90% drop xảy ra trong stage 1 (lúc rate cao nhất)
  -> Fix: tăng preAllocatedVUs HOẶC giảm stage 1.target

Nếu drop ở stage 0/2 (rate thấp):
  -> Bất thường, kiểm tra biên slot hoặc spawn unplanned chậm
```

**(4) Tính chi phí test (cloud k6)**

```text
Cloud k6 tính tiền theo iter count + VUh:
  Iter count = 49
  VUh = 6 VU × 9s = 54 VU-giây ≈ 0.015 VUh (rẻ với demo nhỏ)

Khi scenario lớn:
  Iter count = 1M, max VU = 1000, T = 1h
  -> 1M iter × $X/iter + 1000 VUh × $Y
  -> dự trù budget trước khi chạy
```

**(5) Đối chiếu mật độ slot theo thời gian khi đọc log**

```text
Stage 0 (rate 0→10):  slot ĐẦU thưa (gap ~0.6s), CUỐI nhặt (gap ~0.1s)
Stage 1 (rate 10→4):  slot ĐẦU nhặt (gap ~0.1s), CUỐI thưa (gap ~0.25s)
Stage 2 (rate 4→0):   slot ĐẦU thưa, CUỐI rất thưa (slot cuối ~t=8.6s)

=> Đọc log debug biết "đang fire slot dày hay thưa"
=> Nếu http_req_duration tăng vọt khi slot dày
   -> server không chịu nổi rate đỉnh, cần tối ưu server
```

**Tóm gọn 1 dòng**:

```text
"Rate từng stage" = INPUT để TÍNH SLOT + SIZING VU + DIAGNOSE DROP

Không có rate từng stage:
  - không biết chuẩn bị bao nhiêu VU
  - không biết test đáng lẽ có bao nhiêu iter
  - không biết drop (nếu có) xảy ra ở đâu trên timeline
```

**Quan sát quan trọng — rate nối liên tục giữa các stage**:

```text
| Mốc thời gian | Stage chuyển | rate trước biên | rate sau biên |
|---------------|--------------|-----------------|---------------|
| t=0s          | start        | -               | 0/s (startRate) |
| t=2s          | stage 0 → 1  | 10/s            | 10/s ✓ (= nhau) |
| t=7s          | stage 1 → 2  | 4/s             | 4/s  ✓ (= nhau) |
| t=9s          | end          | 0/s             | -               |

=> Rate KHÔNG nhảy bậc tại biên (= nguyên tắc của ramping)
```

**Tính rate(t) tại 1 thời điểm cụ thể** (vd "rate ở giữa stage 1 là bao
nhiêu?"): xem **Công thức 4** ở dưới — đây là chỗ giải thích đường thẳng
nội suy `rate(t) = rate_đầu + slope × (t - thời_điểm_đầu_stage)`.

Trong Công thức 3 này, chỉ cần biết `rate_đầu` và `rate_cuối` (= 2 đầu
stage) là đủ để áp công thức diện tích hình thang.

**Đây là công thức diện tích hình thang** đã thấy ở Section 3.1
(`scheduled_iterations_i = d_i × (λ_prev + λ_next) / 2`).
Cả 2 công thức GIỐNG NHAU, chỉ khác cách viết:

```text
Section 3.1 (technical):
  scheduled_iterations_i = d_i × (λ_prev + λ_next) / 2

Section 6.1 (beginner):
  scheduled_slots = duration × (rate_đầu + rate_cuối) / 2

Cùng nội dung:
  d_i                    ≡ duration
  λ_prev                 ≡ rate_đầu
  λ_next                 ≡ rate_cuối
  scheduled_iterations_i ≡ scheduled_slots
```

**Trước hết — "lượt start" / "slot" là gì?**

Quay lại phần trên: ta đã có `rate_đầu`, `rate_cuối` của 3 stage và biết
`slot_interval ≈ 1/rate(t)` thay đổi theo curve. Vậy 1 SLOT thực chất
là gì?

```text
1 SLOT = 1 LƯỢT START iteration mà scheduler "đặt lịch"
       = 1 mốc thời gian trên timeline mà scheduler quyết định
         "bây giờ phải start 1 iter"
```

Nói cách khác:

```text
slot_interval (đã tính ở trên) = KHOẢNG CÁCH giữa 2 SLOT liên tiếp
slot                            = ĐIỂM trên timeline (1 lượt start)
rate_đầu/rate_cuối              = quy định MẬT ĐỘ slot ở 2 đầu stage
```

Hình dung trên timeline:

```text
Stage 1 (ramp 10/s → 4/s trong 5 giây, từ t=2s đến t=7s wall-clock)

Đầu stage (t=2s):  rate=10/s -> slot DÀY (gap ~100ms)
Giữa stage (t=4.5s): rate=7/s  -> slot THƯA dần (gap ~140ms)
Cuối stage (t=7s): rate=4/s  -> slot THƯA (gap ~250ms)

(Các gap 100ms, 140ms, 250ms đều áp công thức xấp xỉ
slot_interval ≈ 1/rate(t) từ phần "Biết rate_đầu/rate_cuối → tính
được slot_interval ra sao?" ở trên: 1/10 = 100ms, 1/7 ≈ 143ms,
1/4 = 250ms.)

Trục t (giây):
  2.0    2.5    3.0    3.5    4.0    4.5    5.0    5.5    6.0    6.5    7.0
  |------|------|------|------|------|------|------|------|------|------|
  ●●●●● ●●●●● ●●●●  ●●●● ●●●●  ●●●●   ●●●●   ●●●●    ●●●●     ●●●●      ●
  ↑                  ↑                ↑                          ↑
  rate=10/s          rate=8.8/s       rate=7/s                   rate=4/s
  (slot 11-15)       (slot 16-20)     (slot 21-25)               (slot 35)

  Trong 0.5s đầu (t=2..2.5s): có ~5 slot (rate ~9.4/s, gap ~107ms)
  Trong 0.5s cuối (t=6.5..7s): chỉ ~2 slot (rate ~4.3/s, gap ~234ms)

Tổng cả stage 1: 5 × (10+4)/2 = 35 slot
```

**Quan sát**:

```text
- Đầu stage (rate cao): slot DÀY, các dấu ● gần nhau
- Cuối stage (rate thấp): slot THƯA, các dấu ● cách xa nhau
- Mật độ slot CO LẠI hay GIÃN RA tùy rate đang tăng/giảm
- Trong stage 1 này rate GIẢM (10→4), nên slot GIÃN RA dần
```

So sánh với stage 0 (ramp ngược lại):

```text
Stage 0 (ramp 0/s → 10/s trong 2s):
  Đầu stage rate=0/s  -> chưa fire slot (gap = ∞)
  Cuối stage rate=10/s -> slot DÀY (gap ~100ms)

Trục t (giây) trong stage 0:
  0.0    0.5    1.0    1.5    2.0
  |------|------|------|------|
                  ●     ●●    ●●●●
                  ↑     ↑     ↑
                  ↑     ↑     rate=10/s (slot dồn cuối)
                  ↑     rate=7.5/s
                  rate=5/s (slot bắt đầu xuất hiện)

  Nửa đầu stage (rate thấp): rất ít slot
  Nửa cuối stage (rate cao): slot dồn vào

Tổng cả stage 0: 2 × (0+10)/2 = 10 slot, RẢI LỆCH về cuối
```

Trong open model với rate biến thiên (ramping), scheduler hoạt động như
**người bấm chuông gọi món**, nhịp chuông thay đổi theo `rate_đầu/rate_cuối`:

```text
- Lúc rate thấp (= rate_đầu của stage 0, hoặc rate_cuối của stage 2):
  chuông kêu CÁCH QUÃNG (gap dài)
- Lúc rate cao (= rate_cuối stage 0 hoặc rate_đầu stage 1 = đỉnh 10/s):
  chuông kêu LIÊN TỤC (gap ngắn)
- Mỗi tiếng chuông = 1 LƯỢT START = 1 SLOT
- Có VU rảnh -> VU đó nhận, chạy iter
- Không VU rảnh -> drop slot (chuông kêu vô ích)
```

→ Tới đây ta đã nối được:

```text
config (target, timeUnit) -> rate_đầu, rate_cuối
                          -> slot_interval (1/rate)
                          -> SLOT (mốc fire trên timeline)
```

Bước tiếp theo trong section này: tính tổng SỐ slot mỗi stage (công thức
hình thang) và mối quan hệ với iter hoàn thành.

**Lưu ý — đừng nhầm "nhịp slot" với "số VU"**:

```text
Nhịp slot (slot_interval) = quyết định bởi RATE
  - Rate CAO  -> slot_interval NHỎ (chuông kêu liên tục)
  - Rate THẤP -> slot_interval LỚN (chuông kêu cách quãng)

Số VU đang bận = quyết định bởi rate × iter_time (Little's Law)
  - Rate CAO  -> nhiều VU bận đồng thời
  - Rate THẤP -> ít VU bận đồng thời

=> Đỉnh stage có RATE CAO:
   - Nhịp chuông LIÊN TỤC (gap ngắn) ← do rate
   - NHIỀU VU bận đồng thời           ← do rate × iter_time

=> Số VU KHÔNG quyết định nhịp chuông. Scheduler fire slot theo rate(t),
   ĐỘC LẬP với VU. VU chỉ là người NHẬN slot, không TẠO slot.
```

Đời thường: quán phở giờ cao điểm có lễ tân đẩy khách vào, nhưng tần
suất thay đổi:

```text
9h sáng: ít khách, lễ tân đẩy 1 khách / 30s     (rate thấp)
11h trưa: đông khách, lễ tân đẩy 1 khách / 6s   (rate đỉnh)
14h chiều: vắng khách, lễ tân đẩy 1 khách / 60s (rate giảm)

=> nhịp đẩy thay đổi theo giờ, không cố định cả ngày
=> giống stage ramp trong ramping-arrival-rate
```

**Vậy 1 SLOT có phải = 1 lần `default()` chạy không?**

Câu hỏi rất hay. Trả lời ngắn:

```text
1 SLOT = 1 LỊCH GỌI default()
       (lịch có thể thực hiện, có thể bỏ, có thể dở dang)
```

3 trường hợp khi 1 slot fire:

```text
Trường hợp 1: chuông kêu + có VU rảnh + default() chạy XONG SẠCH
  -> 1 SLOT = 1 lần default() chạy hoàn chỉnh = 1 ITER COMPLETE
  Đời thường: chuông kêu, có bàn, khách ăn xong sạch sẽ

Trường hợp 2: chuông kêu + KHÔNG có VU rảnh
  -> 1 SLOT = 0 lần default() chạy = 1 DROPPED
  default() KHÔNG được gọi
  Đời thường: chuông kêu, hết bàn, đuổi khách về

Trường hợp 3: chuông kêu + có VU rảnh + default() đã start NHƯNG bị cancel
  -> 1 SLOT = 1 lần default() ĐƯỢC GỌI nhưng KHÔNG XONG = 1 INTERRUPTED
  Đời thường: chuông kêu, có bàn, khách vào ăn dở thì quán đóng cửa
```

Vì vậy, cách diễn đạt CHÍNH XÁC nhất:

```text
N_sched = số LỊCH GỌI default() (số chuông kêu = số slot)
N_done  = số default() chạy XONG SẠCH (= summary "iterations")
N_drop  = số lịch bị BỎ — default() KHÔNG được gọi
N_int   = số default() chạy DỞ DANG — bị cancel giữa chừng

N_sched = N_done + N_drop + N_int
```

Tóm gọn cho dễ nhớ:

```text
"1 slot = 1 lần default() được gọi" -> CHỈ ĐÚNG ở trường hợp 1 + 3
"1 slot = 1 lần default() chạy xong" -> CHỈ ĐÚNG ở trường hợp 1
"1 slot = 1 LỊCH GỌI default()"      -> ĐÚNG cho cả 3 trường hợp ✓
```

Đời thường — quán phở chuyển ca trong 1 stage ramp:

```text
Stage: ramp 0 → 10 khách/phút trong 2 phút (lễ tân tăng tốc dần)

Phút 0:   rate=0/phút   -> chưa đẩy khách (gap = ∞)
Phút 0.5: rate=2.5/phút -> 1 khách / 24 giây (gap thưa)
Phút 1:   rate=5/phút   -> 1 khách / 12 giây
Phút 1.5: rate=7.5/phút -> 1 khách / 8 giây
Phút 2:   rate=10/phút  -> 1 khách / 6 giây (gap dày nhất)

=> đầu stage thưa, cuối stage nhặt
=> KHÔNG có "1 nhịp đẩy" cố định cả stage
```

Áp công thức cho từng thời điểm:

```text
slot_interval(t) = 1 / rate(t)

Tại 1 thời điểm cụ thể trong stage ramp, có thể tính rate(t) bằng đường
thẳng nội suy (xem Công thức 4 ở dưới):
  rate(t) = rate_đầu + slope × (t - thời_điểm_đầu_stage)
  slope   = (rate_cuối - rate_đầu) / duration

Rồi nghịch đảo để có slot_interval tại thời điểm đó.
```

Lưu ý quan trọng: trong `ramping-arrival-rate`, **không có 1 con số
slot_interval cố định** — phải đọc theo từng thời điểm.

**Khoảng cách thật giữa 2 slot liên tiếp** (chính xác hơn `1/rate(t)`):

Core dùng công thức nghiệm bậc 2 để tính mốc fire chính xác của từng
slot. Công thức trông phức tạp nhưng ý tưởng đơn giản:

```text
Slot thứ k được fire khi "diện tích tích lũy dưới đường rate(t)
tính từ đầu stage" đạt giá trị k.

Tức là: slot 1 fire khi đã "tích đủ 1 lượt", slot 2 khi tích đủ 2, ...

Công thức nghiệm bậc 2 (đọc từ ramping_arrival_rate.go:253-282):
  x_k = (from × dur − sqrt(dur × (from² × dur + 2 × k × (to − from))))
        ───────────────────────────────────────────────────────────────
                              (from − to)

Trong đó:
  x_k  = thời điểm slot k fire (tính từ stageStart)
  from = rate đầu stage (= λ_prev)
  to   = rate cuối stage (= λ_next)
  dur  = duration stage
  k    = slot thứ k (k=1, 2, 3, ...)
```

Ví dụ thực tế — stage `ramp 2 → 4 iter/s trong 2s`:

```text
from=2, to=4, dur=2 -> tổng slot = 2 × (2+4)/2 = 6 slot

Áp công thức cho từng slot:
  slot 1: x = (2×2 − sqrt(2×(2²×2 + 2×1×2))) / (2−4)
            = (4 − sqrt(24)) / −2
            ≈ 0.449s

  slot 2: x ≈ 0.828s   (gap với slot 1: 0.379s)
  slot 3: x ≈ 1.162s   (gap: 0.334s)
  slot 4: x ≈ 1.464s   (gap: 0.302s)
  slot 5: x ≈ 1.742s   (gap: 0.278s)
  slot 6: x = 2.000s   (gap: 0.258s)

Nhận xét:
  - Đầu stage gap LỚN (0.45s) vì rate đầu thấp (2/s)
  - Cuối stage gap NHỎ (0.26s) vì rate cuối cao (4/s)
  - KHÔNG đều như chia trung bình (0.333s/slot)
```

Quy tắc nhớ nhanh:

```text
gap_k ≈ 1 / rate(t_k)

Tại slot k:
  rate(t_k) = từ công thức đường thẳng (Công thức 4)
  gap đến slot tiếp theo ≈ 1 / rate hiện tại

=> Rate cao -> gap nhỏ -> chuông kêu liên tục
=> Rate thấp -> gap lớn -> chuông kêu cách quãng
```

Xem **Section 3.14 "Bước nhảy của rate trong 1 stage"** cho derivation
chi tiết từ phương trình bậc 2.

#### Áp dụng cho config 3 stage thực tế

Quay lại config đầu doc (đã thấy nhiều lần):

```text
stages:
  - duration: "2s", target: 10    <- ramp 0 → 10/s   (stage 0)
  - duration: "5s", target: 4     <- ramp 10 → 4/s   (stage 1)
  - duration: "2s", target: 0     <- ramp 4 → 0/s    (stage 2)
```

**Bước 1: Tính tổng slot mỗi stage** (công thức hình thang):

```text
stage 0: 2 × (0 + 10) / 2 = 10 slot
stage 1: 5 × (10 + 4) / 2 = 35 slot
stage 2: 2 × (4 + 0) / 2  = 4  slot
                            -----
                  N_sched = 49 slot
```

**Bước 2: Tính mốc fire từng slot trong từng stage**

Stage 0 (ramp 0 → 10/s, dur=2s, from=0):
```text
Vì from=0, công thức rút gọn: x_k = sqrt(0.4 × k)

slot 1:  x = sqrt(0.4)  ≈ 0.632s   (gap đầu lớn vì rate=0/s)
slot 2:  x = sqrt(0.8)  ≈ 0.894s   (gap 0.262s)
slot 3:  x = sqrt(1.2)  ≈ 1.095s   (gap 0.201s)
slot 4:  x = sqrt(1.6)  ≈ 1.265s   (gap 0.170s)
slot 5:  x = sqrt(2.0)  ≈ 1.414s   (gap 0.149s)
slot 6:  x = sqrt(2.4)  ≈ 1.549s   (gap 0.135s)
slot 7:  x = sqrt(2.8)  ≈ 1.673s   (gap 0.124s)
slot 8:  x = sqrt(3.2)  ≈ 1.789s   (gap 0.116s)
slot 9:  x = sqrt(3.6)  ≈ 1.897s   (gap 0.108s)
slot 10: x = sqrt(4.0)  = 2.000s   (gap 0.103s, đúng cuối stage)

Đầu stage gap LỚN (~0.6s) vì rate khởi đầu 0
Cuối stage gap NHỎ (~0.1s) vì rate đỉnh 10/s
```

Stage 1 (ramp 10 → 4/s, dur=5s, from=10, to=4, doneSoFar=10):
```text
Slot k (k=11..45) tính từ công thức bậc 2 đầy đủ:
  x_k = (10×5 − sqrt(5×(100×5 − 12×(k−10)))) / 6

slot 11: x ≈ 0.101s  (gap với slot 10: 0.101s — slot 10 cuối stage 0)
slot 12: x ≈ 0.203s  (gap 0.102s — rate vẫn cao gần 10/s)
slot 13: x ≈ 0.306s  (gap 0.103s)
...
slot 25: x ≈ 1.667s  (gap ~0.13s — rate giảm xuống ~7.6/s)
...
slot 45: x ≈ 5.000s  (gap ~0.20s — đúng cuối stage, rate=4/s)

Đầu stage gap NHỎ (~0.1s) vì rate vẫn cao 10/s
Cuối stage gap LỚN dần (~0.2s) vì rate giảm về 4/s
```

Stage 2 (ramp 4 → 0/s, dur=2s, from=4, to=0, doneSoFar=45):
```text
Slot k (k=46..49):
slot 46: x ≈ 0.268s  (gap ~0.27s — rate ~3.5/s)
slot 47: x ≈ 0.586s  (gap 0.318s — rate ~3/s)
slot 48: x ≈ 0.978s  (gap 0.392s — rate ~2/s)
slot 49: x ≈ 1.591s  (gap 0.613s — rate ~1/s, slot cuối)

Đầu stage gap NHỎ (~0.27s) vì rate đầu 4/s
Cuối stage gap LỚN (~0.6s) vì rate giảm về gần 0

Lưu ý: stage 2 KHÔNG fire slot tại t=2s (rate=0/s, không có slot ở rate 0)
```

**Bước 3: Tổng hợp timeline cả scenario**

```text
Wall-clock | Stage | Slot | Diễn giải
-----------|-------|------|--------------------------------
t=0.6s     |  0    |  1   | Slot đầu tiên (rate 0 -> ramp lên)
t=2.0s     |  0    |  10  | Cuối stage 0, slot 10
t=2.1s     |  1    |  11  | Bắt đầu stage 1 (rate 10/s)
t=4.0s     |  1    |  ~28 | Giữa stage 1 (rate ~7/s)
t=7.0s     |  1    |  45  | Cuối stage 1 (rate 4/s)
t=7.27s    |  2    |  46  | Bắt đầu stage 2
t=8.59s    |  2    |  49  | Slot cuối cùng (rate ~1/s)
t=9.0s     |  2    |  --  | Hết stage 2 (rate=0, không slot)
                          | Tổng: 49 slot
```

**Quan sát quan trọng**:

```text
1. Slot đầu tiên KHÔNG fire tại t=0
   -> phải đợi rate tích lũy đủ 1 đơn vị (xem caveat 3.1)
   -> demo này: slot 1 fire tại t=0.632s

2. Mật độ slot KHÔNG đều cả scenario
   -> stage 0: rare -> dense (đầu thưa, cuối nhặt)
   -> stage 1: dense -> medium (đầu nhặt, cuối thưa hơn)
   -> stage 2: medium -> rare (đầu thưa, cuối rất thưa)

3. Tổng slot N_sched = 49 (không phải 50 dù tổng diện tích = 49)
   -> số nguyên do core tính theo "tích đủ k đơn vị"

4. Verify với kỳ vọng:
   - Test hoàn hảo (preAlloc đủ): N_done = 49
   - Có drop (preAlloc thiếu): N_done < 49, drop xảy ra ở stage 1 (rate đỉnh)
```

#### Stage interval — mốc chuyển giữa các stage

Phần trước đã có **slot_interval** (= khoảng cách giữa 2 slot, đo bằng
ms). Phần này có **stage interval** (= mốc chuyển stage trên timeline,
đo bằng giây) — đừng nhầm 2 khái niệm này.

```text
slot_interval  = gap giữa 2 SLOT liên tiếp     (đo theo ms, ngắn)
                 do rate quyết định (1/rate)
                 vd: 100ms, 250ms

stage interval = thời điểm 1 STAGE chuyển sang stage kế tiếp
                 do duration quyết định (cộng dồn)
                 vd: t=2s, t=7s, t=9s
```

"Stage interval" tính bằng cách **cộng dồn duration** của các stage trước.

**Áp dụng vào config 3 stage**:

```text
stages:
  - duration: "2s", target: 10    <- stage 0
  - duration: "5s", target: 4     <- stage 1
  - duration: "2s", target: 0     <- stage 2

Mốc chuyển stage (cộng dồn duration):
  stage 0: t=0s   →  t=2s    (duration 2s)
  stage 1: t=2s   →  t=7s    (duration 5s, mốc end = 2 + 5)
  stage 2: t=7s   →  t=9s    (duration 2s, mốc end = 7 + 2)

Tổng T = 2 + 5 + 2 = 9s
```

**Quan hệ giữa stage interval và slot interval tại biên**:

```text
Tại biên t=2s (stage 0 -> stage 1):
  Cuối stage 0:    rate = 10/s -> slot_interval = 100ms
  Đầu stage 1:     rate = 10/s -> slot_interval = 100ms
  => slot_interval CÙNG GIÁ TRỊ ở 2 bên biên (nối liên tục)

Tại biên t=7s (stage 1 -> stage 2):
  Cuối stage 1:    rate = 4/s  -> slot_interval = 250ms
  Đầu stage 2:     rate = 4/s  -> slot_interval = 250ms
  => slot_interval CÙNG GIÁ TRỊ ở 2 bên biên

=> Stage chuyển KHÔNG làm slot_interval "nhảy bậc"
=> Người đọc log không thể biết chính xác lúc nào stage chuyển
   chỉ qua mật độ slot — phải nhìn timeline tổng
```

**Tại biên stage, rate có "nhảy bậc" không?**

KHÔNG. Rate luôn nối liên tục giữa 2 stage:

```text
Tại biên t=2s (giữa stage 0 và stage 1):
  Cuối stage 0: rate = 10/s  (đạt target stage 0)
  Đầu stage 1: rate = 10/s  (= rate cuối stage 0, nối liên tục)

Tại biên t=7s (giữa stage 1 và stage 2):
  Cuối stage 1: rate = 4/s   (target stage 1)
  Đầu stage 2: rate = 4/s    (nối liên tục)

=> Rate KHÔNG nhảy bậc, luôn liên tục giữa 2 stage.
```

Đây là quy tắc của ramping: `λ_prev của stage i+1` = `λ_next của stage i`.
Nhờ vậy đường rate(t) là **đường gấp khúc liên tục** (zigzag), không có
"đứt gãy".

**Vẽ hình rate(t) cho config 3 stage**:

```text
rate (iter/s)
  10 |     /‾‾\
   8 |    /    \
   6 |   /      \
   4 |  /        ‾‾\
   2 | /           \
   0 |/_____________\______
     0  2          7   9    t (giây)
        ↑          ↑
        biên       biên
        stage 0/1  stage 1/2

stage 0: ramp 0 → 10  (slope dương = +5/s²)
stage 1: ramp 10 → 4  (slope âm = -1.2/s²)
stage 2: ramp 4 → 0   (slope âm = -2/s²)
```

**Cách dùng stage interval khi đọc log/timeline**:

```text
Wall-clock t  Stage   Đang làm gì?
0.0s          stage 0 ramp up từ 0
0.6s          stage 0 slot 1 fire (đã tích đủ 1 đơn vị)
2.0s          biên    stage 0 hết, stage 1 bắt đầu
                      rate = 10/s (đỉnh)
4.5s          stage 1 đang giảm dần (~7/s)
7.0s          biên    stage 1 hết, stage 2 bắt đầu
                      rate = 4/s
8.59s         stage 2 slot CUỐI fire
9.0s          biên    scenario hết (rate=0)
9.0-39.0s     grace   gracefulStop=30s, không slot mới, iter cuối kịp xong
```

**Tại sao cần biết stage interval?**

```text
1. Đọc log debug
   - Log in [iter] t=4.5s -> biết đang ở stage 1 (giữa)
   - Không cần đoán mò "stage nào"

2. Đối chiếu drop với stage
   - Nếu drop tăng vọt từ t=2..7s -> drop ở stage 1 (rate đỉnh)
   - Biết để fix sizing đúng đoạn đó

3. Tính grace cuối
   - T = 9s, gracefulStop = 30s -> max wall-clock = 39s
   - Iter cuối (start t=8.59s) có 30.41s để xong -> rất dư
```

Khách có vào ngồi ăn được hay không phụ thuộc có chỗ trống không, nhưng
"lượt đẩy khách" thì cứ đều đặn theo curve rate(t).

```text
Lưu ý: 1 SLOT (lượt start) ≠ 1 ITER (lượt hoàn thành)
  - Slot là LỊCH gọi, do scheduler quyết định
  - Iter là VIỆC ĐÃ XONG, do VU thực sự chạy

Quan hệ:
  iter_hoàn_thành (N_done) ≤ slot_dự_kiến (N_sched)
  Phần thiếu = slot bị drop hoặc iter bị interrupt
```

**Vì sao có dấu ≤ chứ không phải = ?**

Đời thường — quán phở chuyển ca từ trưa sang tối (stage ramp):

```text
Stage: ramp 4/phút → 10/phút trong 5 phút (lễ tân tăng tốc dần)

Theo công thức diện tích hình thang:
  N_sched = 5 × (4 + 10) / 2 = 35 lượt đẩy khách

Trong 5 phút này, lễ tân đẩy ĐỦ 35 khách (= 35 slot).

Nhưng số khách THỰC SỰ ĂN XONG có thể ÍT HƠN 35:
  - 4 khách bị từ chối vì hết bàn lúc cao điểm (= drop)
    "Lúc đỉnh 10/phút, quán chỉ có 5 bàn -> 4 khách phải về"
  - 1 khách ngồi vào ăn dở, quán đóng cửa (= interrupt)

=> số khách ăn xong (N_done) = 35 - 4 - 1 = 30
=> N_done (30) ≤ N_sched (35) ✓
```

Áp vào k6:

```text
N_sched = số slot scheduler ĐÃ LÊN LỊCH (cứ đến giờ là kêu chuông)
N_drop  = slot kêu chuông NHƯNG không VU rảnh để nhận
N_int   = iter VU đã nhận, đang chạy thì hết grace -> bị cancel
N_done  = iter VU chạy XONG SẠCH

Công thức quan hệ:
  N_done = N_sched - N_drop - N_int   (xấp xỉ ±1 do biên slot)

Trường hợp đặc biệt:
  Test "hoàn hảo" -> N_drop = N_int = 0 -> N_done = N_sched
  Test có vấn đề -> N_done < N_sched, kiểm tra N_drop và N_int

=> Vì N_drop và N_int luôn ≥ 0, N_done LUÔN ≤ N_sched
   (không bao giờ vượt được lịch dự kiến)
```

Quy tắc nhớ nhanh:

```text
N_sched  = "đã hẹn"     (số chuông kêu)
N_done   = "đã xong"    (số phở ăn xong)

"Đã xong" không bao giờ vượt "đã hẹn" -> N_done ≤ N_sched
```

**Vì sao cần đếm slot trước khi chạy?**

3 lý do thực tế:

```text
1. ƯỚC LƯỢNG TẢI HỆ THỐNG SẼ CHỊU
   vd: scheduled_total = 1000 slot, mỗi slot 2 HTTP request
       -> hệ thống sẽ nhận 2000 request
       -> để biết DB, cache, log có chứa nổi không

2. TÍNH CHI PHÍ TEST (khi chạy trên cloud)
   vd: k6 cloud tính tiền theo VUh + iter count
       -> biết trước scheduled_total để dự trù budget

3. ĐỐI CHIẾU SAU TEST (kiểm tra hệ thống có "chịu" được không)
   vd: scheduled = 1000, completed = 850
       -> drop 15%, sizing thiếu hoặc server chậm
       -> không có scheduled thì không biết đáng lẽ là 1000
```

**Vì sao công thức tổng slot có dấu chia 2?**

Quay lại công thức ở đầu Công thức 3:

```text
scheduled_slots = duration × (rate_đầu + rate_cuối) / 2
                            └────────────────────┘
                              = rate TRUNG BÌNH của stage
```

Phần `(rate_đầu + rate_cuối) / 2` chính là **rate trung bình** — trung
bình cộng của 2 đầu stage. Vì sao công thức dùng trung bình?

Vì rate ramp **đường thẳng** (tuyến tính) — trung điểm của đường thẳng
nối 2 điểm chính là trung bình cộng của 2 điểm đó.

```text
rate
  ↑
4 |        ●  rate_cuối = 4
  |       /
3 |      ●   rate trung bình = (2+4)/2 = 3 (tại giữa stage)
  |     /
2 |    ●  rate_đầu = 2
  |
  +─────────→ t
  0   1   2

=> Diện tích dưới đường rate(t) = duration × rate trung bình
=> tổng slot = 2 × 3 = 6
```

**Ví dụ cụ thể**:

```text
stage: duration=2s, ramp 2/s -> 4/s
rate trung bình = (2 + 4) / 2 = 3 iter/giây
tổng slot = 2 × 3 = 6 lượt start
```

(Đây cũng là **diện tích hình thang** với 2 đáy là `rate_đầu` và
`rate_cuối`, chiều cao là `duration` — đã thấy ở Section 3.1.)

Diễn giải: trong 2 giây này, scheduler "bấm chuông" 6 lần. Phân bố không
đều (đầu thưa, cuối dày), nhưng tổng vẫn là 6:

```text
slot 1: ~ t=0.4s   (rate ~2.4/s, gap ~0.4s)
slot 2: ~ t=0.8s   (rate ~2.8/s, gap ~0.36s)
slot 3: ~ t=1.1s   (rate ~3.1/s, gap ~0.32s)
slot 4: ~ t=1.4s   (rate ~3.4/s, gap ~0.29s)
slot 5: ~ t=1.7s   (rate ~3.7/s, gap ~0.27s)
slot 6: ~ t=1.95s  (rate ~3.95/s, gap ~0.25s)
```

Cách tính 2 cột "rate" và "gap" trong bảng:

```text
Cột rate(t) — áp công thức đường thẳng nội suy (Công thức 4):
  rate(t) = rate_đầu + slope × (t - stageStart)
  slope   = (rate_cuối - rate_đầu) / duration = (4-2)/2 = 1
  => rate(t) = 2 + 1×t = 2 + t

  rate tại t=0.4s  : 2 + 0.4   = 2.4/s
  rate tại t=0.8s  : 2 + 0.8   = 2.8/s
  rate tại t=1.1s  : 2 + 1.1   = 3.1/s
  rate tại t=1.4s  : 2 + 1.4   = 3.4/s
  rate tại t=1.7s  : 2 + 1.7   = 3.7/s
  rate tại t=1.95s : 2 + 1.95  = 3.95/s

Cột gap — áp công thức xấp xỉ 1/rate(t):
  gap tại slot k ≈ 1 / rate(t_k)

  gap tại t=0.4s  : 1/2.4   ≈ 0.42s ≈ 0.4s
  gap tại t=0.8s  : 1/2.8   ≈ 0.36s
  gap tại t=1.1s  : 1/3.1   ≈ 0.32s
  ...
  gap tại t=1.95s : 1/3.95  ≈ 0.25s
```

→ Cả 2 cột đều suy ra từ rate_đầu/rate_cuối + công thức nội suy đường
thẳng + công thức xấp xỉ slot_interval. Không có gì "ngoài kế hoạch".

→ Đầu stage chuông kêu cách quãng (0.4s/lần), cuối stage chuông kêu liên
tục (0.25s/lần), tổng vẫn 6 lượt.

**Khi nào dùng**: ước lượng số iter scenario sẽ có (trước khi chạy),
hoặc đối chiếu với `iterations` trong summary sau test.

**Vì sao cần đếm SLOT cho TỪNG STAGE riêng (không chỉ tổng)?**

4 lý do thực tế (mỗi lý do đều dùng SLOT của stage):

```text
1. TÌM STAGE CÓ MẬT ĐỘ SLOT CAO NHẤT -> SIZING VU
   Slot mỗi stage = duration × (rate_đầu+rate_cuối)/2
     Stage 0: 2 × (0+10)/2 = 10 slot   trong 2s -> 5 slot/s
     Stage 1: 5 × (10+4)/2 = 35 slot   trong 5s -> 7 slot/s  <- đỉnh slot
     Stage 2: 2 × (4+0)/2  = 4  slot   trong 2s -> 2 slot/s
   -> Stage 1 có mật độ slot CAO NHẤT
   -> Sizing VU theo stage 1: cần ceil(10/s × 0.5s) = 5 VU đỉnh
   -> Không có slot/stage thì không biết đỉnh ở đâu để sizing

2. ƯỚC LƯỢNG TẢI HỆ THỐNG TẠI MỖI GIAI ĐOẠN
   Slot/stage = số request ĐỀ NGHỊ scheduler đẩy vào hệ thống:
     Stage 0: 10 slot -> hệ thống warm up nhẹ (không đáng kể)
     Stage 1: 35 slot -> hệ thống nhận burst (đoạn dài + rate đỉnh)
     Stage 2: 4 slot  -> cool down
   -> Biết stage nào "hot" để chuẩn bị monitoring DB/cache đoạn đó

3. ĐỐI CHIẾU DROP THEO TỪNG GIAI ĐOẠN
   Summary chỉ cho TỔNG dropped, không phân theo stage.
   Nhưng nếu biết slot dự kiến mỗi stage:
     Stage 0: 10 slot dự kiến, completed 10  -> OK
     Stage 1: 35 slot dự kiến, completed 25  -> drop 10!
     Stage 2: 4  slot dự kiến, completed 4   -> OK
   -> Biết DROP xảy ra ở stage 1 (rate cao), fix sizing đoạn đó
   -> Không có slot/stage thì chỉ biết "tổng drop 10/49", không biết ở đâu

4. THIẾT KẾ NGƯỢC TỪ SỐ SLOT MONG MUỐN
   Muốn có đúng 100 SLOT trong giai đoạn cao điểm:
     - cách A: stage hold rate=4/s trong 25s   -> 25 × 4 = 100 slot
     - cách B: stage hold rate=10/s trong 10s -> 10 × 10 = 100 slot
     - cách C: stage ramp 0→20/s trong 10s    -> 10 × 10 = 100 slot
   -> Cùng 100 slot nhưng load pattern khác nhau
   -> Đếm slot/stage giúp chọn pattern phù hợp SLA
```

→ Tóm gọn: **slot/stage** là đại lượng để **chia nhỏ** scenario thành
các đoạn có thể phân tích riêng (sizing, monitoring, debug, design).

**Lưu ý — slot có thể "vắt qua" biên stage**

Đời thường — quán phở chuyển ca:

```text
Slot fire lúc 17:59:55 (cuối ca trưa, còn 5s trước ca tối)
-> khách vào ngồi xuống lúc 17:59:55
-> ăn xong lúc 18:00:25 (đã sang ca tối)

Khách này thuộc ca trưa hay ca tối?
  -> Tính theo LÚC VÀO QUÁN (= slot fire) -> ca trưa
```

Áp vào k6:

```text
k6 đếm slot theo MỐC FIRE TIME, không theo mốc default() xong:
  Slot fire t=1.95s (cuối stage 0) -> đếm vào stage 0
  default() xong t=2.45s (đã sang stage 1) -> KHÔNG đếm sang stage 1

=> 1 stage có thể có iter "tràn" thời gian sang stage sau
   nhưng vẫn được đếm vào stage cũ
```

**Quy tắc nhớ nhanh**:

```text
"Số slot dự kiến mỗi stage" = áp công thức diện tích hình thang cho stage đó
"Số iter complete mỗi stage" ≤ số slot (do drop/interrupt)

Test hoàn hảo (drop=0, int=0): số iter complete = số slot dự kiến
```

#### Công thức 4: "Rate ở giây thứ N là bao nhiêu?" (Đường thẳng nội suy)

**Liên hệ với Công thức 3**:

```text
Công thức 3 chỉ dùng rate_đầu và rate_cuối (= 2 ĐẦU stage)
   để tính TỔNG slot.

Nhưng đôi khi cần biết rate TẠI 1 THỜI ĐIỂM CỤ THỂ (giữa stage):
   - "Tại t=4.5s rate là bao nhiêu?" -> Công thức 4 trả lời
   - "Slot_interval tại t=4.5s là bao nhiêu?" -> 1/rate(t) từ Công thức 4

=> Công thức 4 = Công thức MỞ RỘNG của rate_đầu/rate_cuối, áp được
   cho mọi điểm trong stage (không chỉ 2 đầu).
```

```text
rate(t) = rate_đầu + slope × (t - thời_điểm_đầu_stage)
slope = (rate_cuối - rate_đầu) / duration
```

**Tiếng Việt**: "Rate tại 1 thời điểm = rate đầu stage + (độ dốc) × (đã
trôi bao lâu trong stage)"

**Ví dụ**:

```text
stage: ramp 2/s -> 4/s trong 2s

slope = (4 - 2) / 2 = 1 (mỗi giây tăng 1)

rate tại t=0   : 2 + 1×0   = 2/s   (đầu)    <- Công thức 3 đã có
rate tại t=0.5 : 2 + 1×0.5 = 2.5/s            <- mới: giữa stage
rate tại t=1   : 2 + 1×1   = 3/s   (giữa)
rate tại t=2   : 2 + 1×2   = 4/s   (cuối)   <- Công thức 3 đã có
```

→ Công thức 4 lấp khoảng trống giữa rate_đầu và rate_cuối: cho phép tính
rate TẠI bất kỳ thời điểm nào trong stage.

**Khi nào dùng**: muốn biết tại 1 thời điểm cụ thể trong scenario,
rate đang là bao nhiêu (để debug, hoặc tính `λ_current` cho công thức
drop, hoặc tính slot_interval tại điểm giữa stage).

#### Công thức 5: "Hệ thống chịu nổi không?" (Verify drop/interrupt)

**Liên hệ với Công thức 3**:

```text
Công thức 3 cho biết N_sched (TỔNG SLOT DỰ KIẾN) trước khi chạy.
Sau khi chạy, summary cho N_done (số iter HOÀN THÀNH).

Công thức 5 = SO SÁNH 2 con số đó để biết hệ thống có "chịu" được
              rate config (rate_đầu, rate_cuối) hay không.

Vòng đời 1 slot:
  Công thức 3: scheduler LÊN LỊCH       -> N_sched
  Trong test:  có VU rảnh nhận?
                  + có  -> chạy iter
                       + chạy xong -> N_done
                       + bị cancel -> N_int
                  + không -> N_drop
  Công thức 5: ĐÁNH GIÁ kết quả          -> N_done = N_sched - N_drop - N_int
```

```text
N_done ≈ N_sched - N_drop - N_int
actual_rate = N_done / T_run
```

**Tiếng Việt**:
- "Số iter HOÀN THÀNH = TỔNG SLOT dự kiến (Công thức 3) − slot bị drop − iter bị cancel"
- "Rate thực tế = số iter hoàn thành / thời gian thực tế chạy"

**Ví dụ**:

```text
Trước test (Công thức 3):  N_sched = 20 slot
                            (vd stage hold 4/s × 5s = 20)

Sau test summary cho:
  iterations          = 18 (= N_done)
  dropped_iterations  = 2  (= N_drop)
                       0  (= N_int, đọc từ progress footer)

Verify cộng số: 18 + 2 + 0 = 20 = N_sched ✓
actual_rate = 18 / 7s ≈ 2.57 iter/s
```

→ Công thức 5 là **bước cuối** trong chuỗi:

```text
config (rate_đầu, rate_cuối)
  → Công thức 3: N_sched = duration × (rate_đầu+rate_cuối)/2
  → CHẠY TEST →  k6 fire slot, VU nhận hoặc không
  → Công thức 5: SO SÁNH N_done với N_sched
                 -> drop nhiều = sizing thiếu (cần tăng VU theo Công thức 1)
                 -> interrupt nhiều = code chậm (tăng gracefulStop)
```

**Khi nào dùng**: sau test, để biết hệ thống có chịu được rate config
hay không. Drop nhiều = sizing thiếu, interrupt nhiều = code chậm.

### 6.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

5 tình huống hay gặp, mỗi tình huống dùng công thức nào:

```text
| Tình huống                              | Công thức chính | Phụ trợ      |
| --------------------------------------- | --------------- | ------------ |
| 1. Sắp viết config, sizing VU           | CT 1, 2         | CT 3 verify  |
| 2. Có sẵn N VU, hỏi chịu rate nào       | CT 1 (đảo)      | CT 3         |
| 3. Muốn biết rate ở 1 thời điểm cụ thể  | CT 4            | -            |
| 4. Thiết kế ngược từ số slot mong muốn  | CT 3            | CT 4         |
| 5. Đã chạy xong, đọc summary            | CT 5            | CT 3 đối chiếu |
```

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

Đây là tình huống đầu tiên ai cũng gặp: đã có script, muốn test với pattern
ramp-up-hold-ramp-down ở tốc độ target, nhưng chưa biết đặt `preAllocatedVUs`
bao nhiêu.

Demo dùng để phân tích: `examples/ramping_arrival_rate_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 4;
const ITER_TIME_SEC = 0.5;  // sleep cố định giả lập request HTTP

const W = ITER_TIME_SEC;
const lambdaPeak = TARGET_RATE;
const requiredVUs = Math.ceil(lambdaPeak * W * 1.2);

const HOLD_DUR = 4;
const RAMP_DUR = 2;

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: requiredVUs,
      maxVUs: requiredVUs + 2,
      gracefulStop: "10s",
      stages: [
        { duration: `${RAMP_DUR}s`, target: lambdaPeak },
        { duration: `${HOLD_DUR}s`, target: lambdaPeak },
        { duration: `${RAMP_DUR}s`, target: 0 },
      ],
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC);
}
```

Chạy:

```bash
k6 run examples/ramping_arrival_rate_sizing_demo.js               # λ_peak = 4
k6 run -e TARGET_RATE=2 examples/ramping_arrival_rate_sizing_demo.js   # λ_peak = 2
k6 run -e TARGET_RATE=8 examples/ramping_arrival_rate_sizing_demo.js   # λ_peak = 8
k6 run -e DROP_MODE=1 examples/ramping_arrival_rate_sizing_demo.js     # thiếu VU
```

Giờ phân tích output theo đúng 5 bước, lấy lần chạy `TARGET_RATE=4` làm mẫu.

**── Bước 1: Tính rate đỉnh (CT 2) ──**

Lý thuyết: `λ_peak = max(startRate, mọi stage.target) / timeUnit`. Đây
là rate cao nhất scenario phải fire ở bất kỳ thời điểm nào. Phải biết
λ_peak trước thì mới sizing VU được.

Từ config:
  startRate = 0, timeUnit = "1s"
  stages[0].target = 4, stages[1].target = 4, stages[2].target = 0
  → λ_peak = max(0, 4, 4, 0) / 1 = 4 iter/s

```text
scenarios: ... * sizing_demo: Up to 4.00 iterations/s for 8s over 3 stages
                            ↑                ↑
                        λ_peak = 4/s    T = 2+4+2 = 8s
```

**Lưu ý quan trọng**: λ_peak LÀ RATE TARGET CỦA SCHEDULER, không phải
rate iter hoàn thành. λ_peak = 4/s nghĩa là scheduler có nhiệm vụ fire
4 slot/giây tại đỉnh. Số iter HOÀN THÀNH phụ thuộc VU có rảnh không.

**── Bước 2: Đo iter_time (W) ──**

Lý thuyết: chạy thử 1 VU, xem `iteration_duration avg` trong summary,
lấy đó làm W.

Trong demo: `const ITER_TIME_SEC = 0.5` → W = 0.5s. Đây là giả lập —
sleep(0.5) mô phỏng 1 request HTTP mất 0.5s. Ngoài đời thì bạn chạy
thử script với 1 VU rồi đọc số từ summary.

```text
iteration_duration...: avg=500.31ms     ← W thực tế ~0.5s, khớp code
```

**── Bước 3: Tính số VU cần (CT 1) ──**

Lý thuyết: `required_vus = ceil(λ_peak × W) × 1.2`. Buffer 1.2 (20%)
để dự phòng jitter, boundary effect, scheduler overhead.

Trong demo:
  `const requiredVUs = Math.ceil(4 × 0.5) × 1.2`
  = ceil(2.0) × 1.2 = 2 × 1.2 = 2.4 → làm tròn lên = 3 VU
  → config tự điền `preAllocatedVUs: 3, maxVUs: 5`

```text
vus_max..............: 3   min=3      max=3
```

  vus_max = 3 → đúng Bước 3. k6 chỉ spawn 3 VU vì rate đỉnh 4/s
  với W=0.5s chỉ cần 2 VU concurrent, cộng buffer 20% là 3 VU.

  KHÔNG cần spawn hết maxVUs=5 vì rate chưa đủ cao để cần.

**── Bước 4: Tính N_sched dự kiến (CT 3) ──**

Lý thuyết: `N_sched_i = duration_i × (rate_đầu_i + rate_cuối_i) / 2`.
Đây là số slot scheduler DỰ TÍNH fire (mục tiêu), khác số iter HOÀN THÀNH.

```text
Stage 0: ramp 0 → 4/s trong 2s  → 2 × (0 + 4) / 2 = 4 slot
Stage 1: hold 4/s trong 4s      → 4 × (4 + 4) / 2 = 16 slot
Stage 2: ramp 4 → 0/s trong 2s  → 2 × (4 + 0) / 2 = 4 slot
                                    -------------------
                                    N_sched = 24 slot
λ_avg = N_sched / T = 24 / 8 = 3.00 iter/s
```

**── Bước 5: Chạy, đọc summary, verify (CT 5) ──**

Lý thuyết: `N_done + N_drop + N_int ≈ N_sched` (CT 5). Đây là đẳng thức
quan trọng nhất để verify test có chạy đúng không.

Output thực tế (TARGET_RATE=4, đủ VU):

```text
scenarios: (100.00%) 1 scenario, 5 max VUs, 18s max duration (incl. graceful stop):
         * sizing_demo: Up to 4.00 iterations/s for 8s over 3 stages (maxVUs: 3-5, gracefulStop: 10s)

running (08.0s), 0/3 VUs, 23 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.31ms min=500ms med=500.35ms max=500.76ms p(90)=500.53ms p(95)=500.53ms
    iterations...........: 23  2.874645/s
    vus..................: 0   min=0      max=2
    vus_max..............: 3   min=3      max=3
```

Verify CT 5:
  N_done = 23, N_drop = 0, N_int = 0
  N_done + N_drop + N_int = 23 + 0 + 0 = 23
  N_sched = 24 → lệch 1 slot (23 vs 24)

  Lệch 1 slot là BÌNH THƯỜNG. Nguyên nhân: caveat slot biên (xem 3.1
  caveat 2: slot đầu không mặc định ở t=0). Với startRate=0, vài ms đầu
  chưa tích lũy đủ 1 slot để fire. Kết quả: fire 23 slot thay vì 24.

  Tỷ lệ N_done / N_sched = 23/24 = 95.8% → rơi vào nhóm "drop biên slot"
  (95-99%), không đáng lo.

Verify CT 1 đảo (capacity):
  C = vus_max / W = 3 / 0.5 = 6 iter/s
  λ_peak = 4 iter/s → capacity (6) > λ_peak (4) → không drop ✓

  vus max trong summary = 2 (VU bận cao nhất), không phải 3. Vì tại
  thời điểm bận nhất, chỉ cần 2 VU concurrent (2 × 0.5 = 1s, đủ phục
  vụ rate 4/s). VU thứ 3 là buffer, có lúc dùng có lúc không.

Footer:
```text
running (08.0s), 0/3 VUs, 23 complete and 0 interrupted iterations
                         ↑               ↑
                    N_done = 23     N_int = 0 → sạch
```

  Runtime = 8.0s → đúng tổng duration (2+4+2) ✓
  N_int = 0 → không iter nào bị cắt giữa chừng ✓
  N_drop không có dòng riêng trong output này = 0 ✓

**── Thử target khác để thấy quy luật ──**

```bash
k6 run -e TARGET_RATE=2 examples/ramping_arrival_rate_sizing_demo.js
```

Bước 1: λ_peak = 2.  Bước 3: requiredVUs = ceil(2 × 0.5) × 1.2 = 2 VU.

```text
  iteration_duration...: avg=500.27ms    ← W ~0.5s
  iterations...........: 12  1.411723/s  ← gần λ_avg = 1.5/s
  vus_max..............: 2   min=2 max=2
```

N_sched = 2×(0+2)/2 + 4×(2+2)/2 + 2×(2+0)/2 = 2 + 8 + 2 = 12 slot.
N_done = 12, khớp tuyệt đối. Tỷ lệ = 100%.

```bash
k6 run -e TARGET_RATE=8 examples/ramping_arrival_rate_sizing_demo.js
```

Bước 1: λ_peak = 8.  Bước 3: requiredVUs = ceil(8 × 0.5) × 1.2 = 5 VU.

```text
  iteration_duration...: avg=500.29ms    ← W ~0.5s
  iterations...........: 47  5.874318/s  ← gần λ_avg = 6.0/s
  vus_max..............: 5   min=5 max=5
```

N_sched = 2×(0+8)/2 + 4×(8+8)/2 + 2×(8+0)/2 = 8 + 32 + 8 = 48 slot.
N_done = 47, lệch 1 slot (caveat slot biên). Tỷ lệ = 97.9%.

Bảng tổng kết:

| λ_peak | W | requiredVUs | N_sched | N_done | Tỷ lệ | Drop? |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 | 0.5s | 2 | 12 | 12 | 100% | Không |
| 4 | 0.5s | 3 | 24 | 23 | 95.8% | Không (lệch slot biên) |
| 8 | 0.5s | 5 | 48 | 47 | 97.9% | Không (lệch slot biên) |

→ λ_peak gấp đôi → VU cần gấp đôi. Đúng lý thuyết: requiredVUs ∝ λ_peak.

**── Demo thiếu VU (DROP_MODE=1) ──**

```bash
k6 run -e DROP_MODE=1 examples/ramping_arrival_rate_sizing_demo.js
```

Cố ý đặt preAllocatedVUs=1 (thiếu so với required=3) để thấy
dropped_iterations.

```text
scenarios: ... * sizing_demo: Up to 4.00 iterations/s for 8s over 3 stages (maxVUs: 1)

  █ TOTAL RESULTS

    EXECUTION
    dropped_iterations...: 13  1.624683/s
    iteration_duration...: avg=500.38ms ...
    iterations...........: 10  1.249756/s
    vus_max..............: 1   min=1      max=1

running (08.0s), 0/1 VUs, 10 complete and 0 interrupted iterations
```

Phân tích:
  N_sched = 24 slot (scheduler vẫn fire 24 slot như cũ)
  N_done = 10, N_drop = 13, N_int = 0
  N_done + N_drop = 10 + 13 = 23 ≈ 24 ✓ (CT 5)

  Tỷ lệ N_done / N_sched = 10/24 = 41.7% → RẤT THẤP.
  13 slot bị drop vì chỉ có 1 VU, capacity = 1/0.5 = 2 iter/s,
  trong khi λ_peak = 4 iter/s. Thiếu 2 iter/s → drop.

  Warning trong log:
  ```
  level=warning msg="Insufficient VUs, reached 1 active VUs and cannot initialize more"
  ```

Bài học:
  - preAllocatedVUs phải >= ceil(λ_peak × W) (chưa tính buffer)
  - Nếu preAllocatedVUs = maxVUs (không cho spawn) mà thiếu → drop
  - Nếu maxVUs > preAllocatedVUs: k6 spawn thêm, nhưng có window
    vài ms đầu vẫn drop (xem 3.16)

#### Tình huống 2: "Đã có sẵn N VU, hỏi chịu được rate cao nhất là bao nhiêu?"

Ngược với Tình huống 1: đã biết số VU (vd do giới hạn tài khoản test,
server giới hạn connection, hoặc sếp bảo "chỉ được dùng 4 VU"), muốn ước
lượng rate cao nhất có thể chịu trước khi viết config.

Dùng chung demo `examples/ramping_arrival_rate_sizing_demo.js` nhưng
phân tích theo hướng ngược: từ N VU → capacity.

**── Công thức ──**

```text
Công thức gốc: required_vus = ceil(λ_peak × W) × 1.2     (CT 1)
Đảo lại:       capacity    = N / W                         (CT 1 đảo)

Trong đó:
  N = preAllocatedVUs (số VU sẵn sàng)
  W = iter_time (thời gian 1 iter)
  capacity = rate tối đa pool N VU chịu được (iter/s)

Nếu λ_peak ≤ capacity → không drop
Nếu λ_peak > capacity → drop, số slot drop/giây ≈ λ_peak − capacity
```

**── Ví dụ A: có 2 VU, W = 0.5s ──**

```bash
k6 run -e TARGET_RATE=2 examples/ramping_arrival_rate_sizing_demo.js
```

Demo tự tính: preAllocatedVUs = ceil(2 × 0.5) × 1.2 = 2 VU.
Đây là case ĐỦ VU — capacity = λ_peak.

```text
  iteration_duration...: avg=500.27ms     ← W thực tế ~0.5s
  iterations...........: 12  1.411723/s
  dropped_iterations...: (không có dòng)  ← = 0
  vus_max..............: 2   min=2 max=2
```

Kiểm tra:
  CT 1 đảo: capacity = N / W = 2 / 0.5 = 4 iter/s
  λ_peak = 2 iter/s → capacity (4) > λ_peak (2) → không drop ✓
  Thực tế: N_drop = 0 ✓

  pool 2 VU DƯ SỨC chịu rate 2/s. Có thể tăng λ_peak lên 4/s
  mà vẫn không drop (với W=0.5s).

**── Ví dụ B: có 3 VU, W = 0.5s ──**

```bash
k6 run -e TARGET_RATE=4 examples/ramping_arrival_rate_sizing_demo.js
```

  capacity = 3 / 0.5 = 6 iter/s
  λ_peak = 4 iter/s → capacity (6) > λ_peak (4) → không drop ✓

```text
  iteration_duration...: avg=500.31ms
  iterations...........: 23  2.874645/s
  vus_max..............: 3   min=3 max=3
```

  N_drop = 0. Pool 3 VU chịu được rate 4/s thoải mái.

**── Ví dụ C: có 1 VU, W = 0.5s (thiếu VU) ──**

```bash
k6 run -e DROP_MODE=1 examples/ramping_arrival_rate_sizing_demo.js
```

  capacity = 1 / 0.5 = 2 iter/s
  λ_peak = 4 iter/s → capacity (2) < λ_peak (4) → SẼ DROP

```text
  dropped_iterations...: 13  1.624683/s
  iteration_duration...: avg=500.38ms
  iterations...........: 10  1.249756/s
  vus_max..............: 1   min=1 max=1
```

  N_drop = 13 slot. Tại sao 13?
  λ_peak − capacity = 4 − 2 = 2 slot drop/giây (ở đỉnh)
  Nhưng drop không chỉ ở đỉnh — trong stage ramp lên và ramp xuống,
  rate thấp hơn 4/s, có lúc chỉ 1-2/s, nên drop ít hơn.

  Tổng quát: số drop ≈ N_sched − (capacity × T_effective)
  Với T_effective là thời gian hệ thống bận (VU active).

**── Ví dụ D: có 5 VU, W = 0.5s ──**

```bash
k6 run -e TARGET_RATE=8 examples/ramping_arrival_rate_sizing_demo.js
```

  capacity = 5 / 0.5 = 10 iter/s
  λ_peak = 8 iter/s → capacity (10) > λ_peak (8) → không drop ✓

```text
  iteration_duration...: avg=500.29ms
  iterations...........: 47  5.874318/s
  vus_max..............: 5   min=5 max=5
```

**── Bảng tổng kết capacity ──**

| N (VU) | W | capacity = N/W | λ_peak | Drop? | N_done | N_drop |
| ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 0.5s | 2 iter/s | 4/s | CÓ | 10 | 13 |
| 2 | 0.5s | 4 iter/s | 2/s | Không | 12 | 0 |
| 3 | 0.5s | 6 iter/s | 4/s | Không | 23 | 0 |
| 5 | 0.5s | 10 iter/s | 8/s | Không | 47 | 0 |

**── Điểm mấu chốt ──**

```text
Với ramping-arrival-rate, N VU CÓ SẴN không đảm bảo chịu được
mọi λ_peak. Phải kiểm tra: capacity = N / W ≥ λ_peak.

Nếu capacity < λ_peak:
  → dropped_iterations > 0
  → Tăng preAllocatedVUs (ít nhất lên ceil(λ_peak × W))
  → HOẶC tăng maxVUs để cho phép spawn unplanned VU

Nếu capacity > λ_peak (dư VU):
  → Có thể tăng λ_peak để stress test nặng hơn
  → HOẶC giảm preAllocatedVUs để tiết kiệm RAM

So sánh với constant-vus:
  constant-vus:         rate = vus / W (rate phụ thuộc latency)
  ramping-arrival-rate: rate do scheduler quyết định,
                        VU chỉ là "công nhân" phục vụ rate đó
                        → rate không phụ thuộc latency (trừ khi drop)
```

#### Tình huống 3: "Muốn biết rate ở thời điểm cụ thể trong stage"

Câu hỏi điển hình: "Tại t=3.0s (giữa stage 1 hold) rate đang là bao nhiêu?"
hoặc "Tại t=1.0s (giữa stage 0 ramp) đã fire được mấy slot rồi?"

Dùng config demo `ramping_arrival_rate_sizing_demo.js` (TARGET_RATE=4):

```text
startRate = 0, timeUnit = "1s"
stages:
  stage 0: { duration: "2s", target: 4 }   // ramp 0 → 4/s
  stage 1: { duration: "4s", target: 4 }   // hold 4/s
  stage 2: { duration: "2s", target: 0 }   // ramp 4 → 0/s

Timeline: 0──2s──6s──8s
```

**── Bước 1: Xác định stage chứa thời điểm cần ──**

Cộng dồn duration để tìm stage:

```text
stage 0: t = 0s .. 2s   (duration = 2s)
stage 1: t = 2s .. 6s   (duration = 4s)
stage 2: t = 6s .. 8s   (duration = 2s)
```

**── Bước 2: Lấy rate_đầu, rate_cuối của stage đó ──**

Nhớ quy tắc: `rate_đầu của stage N = rate_cuối của stage (N-1)`.
Riêng stage 0: `rate_đầu = startRate`.

```text
stage 0: rate_đầu = startRate = 0/s,  rate_cuối = 4/s
stage 1: rate_đầu = 4/s (từ stage 0), rate_cuối = 4/s (hold)
stage 2: rate_đầu = 4/s (từ stage 1), rate_cuối = 0/s
```

**── Bước 3: Áp công thức nội suy đường thẳng ──**

Công thức: `slope = (rate_cuối − rate_đầu) / duration`
           `rate(t) = rate_đầu + slope × (t − stageStart)`

**Ví dụ 1: t = 1.0s (giữa stage 0 ramp lên)**:

```text
stage 0: rate_đầu=0, rate_cuối=4, dur=2s
  slope = (4 − 0) / 2 = +2.0
  t_local = 1.0 − 0 = 1.0s
  rate(1.0s) = 0 + 2.0 × 1.0 = 2.0/s

→ Tại t=1s, scheduler đang fire với rate 2/s
→ slot_interval ≈ 1/2 = 500ms (cứ 500ms fire 1 slot)
```

**Ví dụ 2: t = 3.0s (giữa stage 1 hold)**:

```text
stage 1: rate_đầu=4, rate_cuối=4, dur=4s
  slope = (4 − 4) / 4 = 0  (hold, không đổi)
  t_local = 3.0 − 2 = 1.0s
  rate(3.0s) = 4 + 0 × 1.0 = 4.0/s

→ Tại t=3s, rate = 4/s (đang ở đỉnh hold)
→ slot_interval ≈ 1/4 = 250ms (cứ 250ms fire 1 slot)
```

**Ví dụ 3: t = 7.0s (giữa stage 2 ramp xuống)**:

```text
stage 2: rate_đầu=4, rate_cuối=0, dur=2s
  slope = (0 − 4) / 2 = −2.0
  t_local = 7.0 − 6 = 1.0s
  rate(7.0s) = 4 + (−2.0) × 1.0 = 2.0/s

→ Tại t=7s, rate giảm còn 2/s
→ slot_interval ≈ 1/2 = 500ms
```

**── Ví dụ 4: t = 0.5s (sát đầu stage 0) ──**

```text
stage 0: rate_đầu=0, rate_cuối=4, dur=2s
  t_local = 0.5 − 0 = 0.5s
  rate(0.5s) = 0 + 2.0 × 0.5 = 1.0/s

→ slot_interval ≈ 1s. Slot đầu tiên chưa fire (chưa tích lũy đủ 1).
  Đúng caveat 3.1: slot đầu không mặc định ở t=0.
```

**── Bảng rate tại các thời điểm ──**

| t | Stage | rate_đầu | rate_cuối | slope | t_local | rate(t) | slot_interval |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.5s | 0 (ramp) | 0/s | 4/s | +2.0 | 0.5s | 1.0/s | 1000ms |
| 1.0s | 0 (ramp) | 0/s | 4/s | +2.0 | 1.0s | 2.0/s | 500ms |
| 1.5s | 0 (ramp) | 0/s | 4/s | +2.0 | 1.5s | 3.0/s | 333ms |
| 2.0s | 0→1 biên | 4/s | 4/s | 0 | 0.0s | 4.0/s | 250ms |
| 3.0s | 1 (hold) | 4/s | 4/s | 0 | 1.0s | 4.0/s | 250ms |
| 5.0s | 1 (hold) | 4/s | 4/s | 0 | 3.0s | 4.0/s | 250ms |
| 6.0s | 1→2 biên | 4/s | 0/s | −2.0 | 0.0s | 4.0/s | 250ms |
| 7.0s | 2 (ramp) | 4/s | 0/s | −2.0 | 1.0s | 2.0/s | 500ms |
| 7.5s | 2 (ramp) | 4/s | 0/s | −2.0 | 1.5s | 1.0/s | 1000ms |

**── Khi nào dùng ──**

```text
- Debug log: "sao slot fire dày ở giây 4 mà thưa ở giây 7?"
  → rate(4s) = 4/s (hold), rate(7s) = 2/s (ramp xuống)

- Ước lượng burst: "tại t=3s có bao nhiêu slot fire trong 200ms?"
  → rate = 4/s → 4 × 0.2 = 0.8 slot → ~1 slot mỗi 250ms

- Tính capacity local: "tại t=1s, cần mấy VU?"
  → rate=2/s, W=0.5s → cần ceil(2 × 0.5) = 1 VU
  → tại t=3s, rate=4/s → cần ceil(4 × 0.5) = 2 VU
```

#### Tình huống 4: "Thiết kế ngược từ số slot mong muốn"

Câu hỏi: "Muốn có đúng 100 slot ở giai đoạn cao điểm, config thế nào?"
hoặc "Cần N_sched = 50 slot, chọn stage ra sao?"

Đây là bài toán ngược: biết output mong muốn (N_sched), tìm input (stages).

**── Công thức gốc (CT 3) ──**

```text
N_sched_i = duration_i × (rate_đầu_i + rate_cuối_i) / 2
         = duration_i × rate_trung_bình_i

→ Đảo lại: duration_i = N_sched_i / rate_trung_bình_i
           = N_sched_i × 2 / (rate_đầu_i + rate_cuối_i)
```

**── Bước 1: Quyết định pattern muốn dùng ──**

3 pattern cơ bản, mỗi pattern có "hình dạng" slot khác nhau:

```text
Pattern A: HOLD (rate cố định)
  ┌─────────────────┐
  │ rate = const    │  slot rải ĐỀU, dễ tính nhất
  └─────────────────┘
  Dùng cho: regression test, soak test, benchmark ổn định

Pattern B: RAMP LÊN (0 → peak)
       ╱
      ╱               slot THƯA → DÀY dần
     ╱
  Dùng cho: warm up, ramp test, tìm điểm gãy

Pattern C: SPIKE (ramp lên → hold → ramp xuống)
       ╱‾‾‾‾‾‾‾╲
      ╱           ╲    slot: thưa → dày → đều → thưa
     ╱             ╲
  Dùng cho: stress test có warm up + cool down
```

**── Bước 2: Áp công thức cho từng pattern ──**

Ví dụ muốn có N_sched = 24 slot với W = 0.5s (để λ_peak = 4/s):

**Pattern A: HOLD 4/s liên tục**

```text
N_sched = duration × (4 + 4) / 2 = duration × 4
→ duration = 24 / 4 = 6s

Config:
  stages: [{ duration: "6s", target: 4 }]
  preAllocatedVUs: ceil(4 × 0.5) × 1.2 = 3 VU
  N_sched = 24 slot, λ_peak = 4/s, T = 6s
```

**Pattern B: RAMP 0 → 8/s**

```text
N_sched = duration × (0 + 8) / 2 = duration × 4
→ duration = 24 / 4 = 6s

Config:
  stages: [{ duration: "6s", target: 8 }]
  preAllocatedVUs: ceil(8 × 0.5) × 1.2 = 5 VU
  N_sched = 24 slot, λ_peak = 8/s, T = 6s

  → Cùng số slot, nhưng rate đỉnh gấp đôi → cần VU gấp đôi
```

**Pattern C: RAMP UP → HOLD → RAMP DOWN (giống demo)**

```text
Chọn λ_peak = 4/s, T_total = 8s

Phân bổ:
  stage 0 (ramp up):   2s × (0 + 4) / 2  = 4 slot
  stage 1 (hold):      4s × (4 + 4) / 2  = 16 slot
  stage 2 (ramp down): 2s × (4 + 0) / 2  = 4 slot
  ─────────────────────────────────────────
  N_sched = 24 slot, λ_peak = 4/s, T = 8s

Config:
  stages: [
    { duration: "2s", target: 4 },
    { duration: "4s", target: 4 },
    { duration: "2s", target: 0 },
  ]
```

**── Bước 3: So sánh 3 pattern ──**

| Pattern | stages | T | λ_peak | N_sched | VU cần | Đặc điểm |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A: Hold | 1 stage | 6s | 4/s | 24 | 3 | Đơn giản, slot đều, nhanh nhất |
| B: Ramp | 1 stage | 6s | 8/s | 24 | 5 | Slot dày dần, cần VU gấp đôi |
| C: Ramp+Hold+Ramp | 3 stages | 8s | 4/s | 24 | 3 | Mô phỏng thực tế, có warm up + cool down |

Cùng 24 slot nhưng:
  - Pattern A: nhanh (6s), VU ít (3), slot đều → dùng cho CI nhanh
  - Pattern B: nhanh (6s), VU nhiều (5), slot dày cuối → stress VU pool
  - Pattern C: chậm hơn (8s), VU vừa (3), có warm up → mô phỏng production

**── Bước 4: Verify rate không vượt capacity ──**

Sau khi chọn pattern, kiểm tra:

```text
capacity = preAllocatedVUs / W
phải ≥ λ_peak

Pattern A: capacity = 3/0.5 = 6/s ≥ 4/s ✓
Pattern B: capacity = 5/0.5 = 10/s ≥ 8/s ✓
Pattern C: capacity = 3/0.5 = 6/s ≥ 4/s ✓
```

**── Ví dụ thực tế: thiết kế test 100 slot ──**

```text
Yêu cầu: 100 slot, λ_peak không quá 10/s (giới hạn server), W=0.5s

Pattern A (hold 10/s):
  duration = 100 × 2 / (10+10) = 10s
  preAllocatedVUs = ceil(10 × 0.5) × 1.2 = 6 VU
  Config: 1 stage [{ duration: "10s", target: 10 }]

Pattern C (ramp 0→10→0, 3 stage):
  Giả sử ramp 2s mỗi bên, hold x giây:
  ramp_up:   2 × (0+10)/2 = 10 slot
  hold:      x × (10+10)/2 = 10x slot
  ramp_down: 2 × (10+0)/2 = 10 slot
  → 10 + 10x + 10 = 100 → x = 8s
  Config: [
    { duration: "2s", target: 10 },
    { duration: "8s", target: 10 },
    { duration: "2s", target: 0 },
  ]
  preAllocatedVUs = 6 VU, T = 12s

→ Pattern C chậm hơn 2s nhưng mô phỏng realistic hơn.
```

#### Tình huống 5: "Đã chạy xong, đọc summary"

Sau khi run xong, summary là nơi duy nhất cần đọc để kết luận test
có chạy đúng kế hoạch không.

Dùng output từ demo `ramping_arrival_rate_sizing_demo.js` (TARGET_RATE=4, đủ VU)
làm mẫu:

```text
  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.31ms min=500ms med=500.35ms max=500.76ms
                           p(90)=500.53ms p(95)=500.53ms
    iterations...........: 23  2.874645/s
    vus..................: 0   min=0      max=2
    vus_max..............: 3   min=3      max=3

    NETWORK
    data_received........: 0 B 0 B/s
    data_sent............: 0 B 0 B/s

running (08.0s), 0/3 VUs, 23 complete and 0 interrupted iterations
```

**── 6 con số trong EXECUTION ──**

| Dòng summary | Ký hiệu | Nghĩa | Giá trị mẫu | Đọc thế nào |
|---|---|---|---|---|
| `iteration_duration avg` | W | Thời gian 1 iter trung bình | 500.31ms | So với W dự kiến (0.5s) → khớp |
| `iterations` (count) | N_done | Số iter hoàn thành | 23 | So với N_sched (24) → 95.8%, lệch slot biên |
| `iterations X/s` | actual_rate | Tốc độ trung bình toàn test | 2.87/s | So với λ_avg (3.00/s) → gần đúng |
| `vus max` | M_peak | Số VU bận cao nhất | 2 | Cần 2 VU concurrent cho rate 4/s |
| `vus_max` | preAllocated | Số VU trong pool | 3 | Đúng config preAllocatedVUs=3 |
| `dropped_iterations` | N_drop | Slot bị drop | (không có dòng) = 0 | Không drop → đủ VU ✓ |

**── So sánh với output thiếu VU (DROP_MODE=1) ──**

```text
    EXECUTION
    dropped_iterations...: 13  1.624683/s       ← N_drop = 13 (!)
    iteration_duration...: avg=500.38ms ...
    iterations...........: 10  1.249756/s        ← N_done = 10
    vus..................: 0   min=0      max=1
    vus_max..............: 1   min=1      max=1

running (08.0s), 0/1 VUs, 10 complete and 0 interrupted iterations
```

So sánh 2 output:

| Chỉ số | Đủ VU (preAlloc=3) | Thiếu VU (preAlloc=1) | Giải thích |
| --- | ---: | ---: | --- |
| N_done | 23 | 10 | Thiếu VU → ít iter hoàn thành hơn |
| N_drop | 0 | 13 | Thiếu VU → 13 slot không có VU nhận |
| N_done + N_drop | 23 | 23 | Cả 2 ≈ N_sched=24 (±1 slot biên) |
| vus_max | 3 | 1 | Pool nhỏ hơn |
| actual_rate | 2.87/s | 1.25/s | Rate thực tế thấp vì drop |

**── Footer progress ──**

```text
running (08.0s), 0/3 VUs, 23 complete and 0 interrupted iterations
           ↑       ↑        ↑              ↑
       T_run   VU active  N_done         N_int
```

  T_run = 8.0s → đúng tổng stage duration (2+4+2=8s), không bị grace kéo dài
  VU active cuối = 0 → tất cả VU đã xong, không còn VU bận
  N_done = 23 → gần N_sched (24), lệch 1 slot biên
  N_int = 0 → không iter nào bị cắt giữa chừng

**── 5 câu hỏi kiểm tra (theo thứ tự) ──**

```text
1. N_done có gần N_sched không?
     CT 3: N_sched = 2×(0+4)/2 + 4×(4+4)/2 + 2×(4+0)/2 = 24 slot
     Summary: N_done = 23 → 95.8%, lệch 1 slot biên → BÌNH THƯỜNG
     (lệch <5% hay ±1 slot là OK với ramping-arrival-rate)

2. Có dropped_iterations không?
     N_drop = 0 → đủ VU, không slot nào bị drop ✓
     Nếu N_drop > 0: đọc mục "Drop nhiều quá!" ở 6.3

3. Có interrupted iterations không?
     N_int = 0 → không iter nào bị cắt ✓
     Nếu N_int > 0: tăng gracefulStop hoặc giảm iter_time

4. iteration_duration avg có gần W dự kiến không?
     W dự kiến = 0.5s, thực tế = 500.31ms → khớp ✓
     Nếu lệch nhiều: code biến thiên, có thể do HTTP latency dao động

5. actual_rate có gần λ_avg không?
     λ_avg = N_sched / T = 24/8 = 3.00/s
     actual_rate = 23 / 8.0 = 2.875/s → gần 3.0 ✓
     Nếu thấp hơn hẳn: có N_drop hoặc N_int che khuất
```

**── Với ramping-arrival-rate, summary PHỨC TẠP hơn constant-vus ──**

```text
ramping-arrival-rate: CÓ dropped_iterations (cơ chế drop slot)
                      vus min có thể = 0, max thay đổi theo rate
                      Cần kiểm: N_done, N_drop, N_int, M_peak, λ_avg
                      → 5 chỉ số, không chỉ 3 như constant-vus

So sánh:
  constant-vus:          chỉ kiểm N_done, W, N_int (3 thứ)
  constant-arrival-rate: kiểm thêm dropped_iterations (4 thứ)
  ramping-arrival-rate:  kiểm thêm N_sched từng stage (5 thứ)
                         → phức tạp nhất vì rate thay đổi theo stage
```

### 6.3. Hành động khi gặp vấn đề

#### "Drop nhiều quá!"

Nguyên nhân: rate đỉnh vượt năng lực pool VU. Cách xử lý theo độ ưu tiên:

```text
1. (DỄ NHẤT) Tăng preAllocatedVUs
   -> Pool có sẵn nhiều VU rảnh, không cần spawn
   -> Tốt cho test ổn định

2. Tăng maxVUs (cho phép spawn unplanned)
   -> Cho k6 spawn thêm VU khi cần
   -> Nhưng có window vài chục ms ban đầu vẫn drop (xem 3.16)

3. Giảm rate đỉnh (hạ stage.target)
   -> Đơn giản nhất nếu rate cao là không cần thiết

4. Tối ưu code (giảm iter_time)
   -> Bỏ sleep dư, tối ưu logic, giảm số HTTP request
```

#### "Có interrupted iterations cuối test!"

Nguyên nhân: iter chưa kịp xong khi grace hết. Cách xử lý:

```text
1. Tăng gracefulStop
   -> Cho iter cuối thêm thời gian
   -> Vd: gracefulStop: "30s" thay vì default

2. Đổi stage cuối thành rate giảm dần
   -> stages: [..., { duration: "5s", target: 0 }]
   -> Iter cuối ít hơn, ít kịp đè giờ kết thúc

3. Tối ưu code (giảm iter_time)
   -> Iter ngắn hơn -> ít có khả năng vắt qua mốc cuối
```

#### "Rate thực thấp hơn target nhiều!"

```text
1. Check N_drop trước  -> nếu drop nhiều, fix theo hướng dẫn trên
2. Check N_int sau     -> nếu interrupt nhiều, tăng gracefulStop
3. Check T_run         -> nếu T_run > T (dùng grace), divisor lớn hơn
                         -> rate thực tự nhiên thấp hơn

Nếu drop=0, int=0 mà rate vẫn thấp -> có thể là caveat slot biên
                                       (xem 3.1 caveat 2: slot đầu lệch t=0)
```

### 6.4. Bảng từ vựng: ký hiệu nào nghĩa là gì?

> Section 3.1-3.5 dùng nhiều ký hiệu rút gọn cho gọn. Đây là bảng tra
> để bạn không phải lật lại đầu Section 3 mỗi lần.

| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
| --- | --- | --- | --- |
| `λ` (lambda) | "lam-da" | Rate, nhịp start | iter/giây |
| `λ_peak` | "lam-da đỉnh" | Rate cao nhất scenario | iter/giây |
| `λ_avg` | "lam-da trung bình" | Rate trung bình của cả timeline | iter/giây |
| `λ(t)` | "lam-da tại t" | Rate ở 1 thời điểm cụ thể | iter/giây |
| `W` | "đắp-bờ-liu" | Thời gian 1 iter chiếm 1 VU | giây/iter |
| `T` | "ti" | Tổng thời gian timeline (sum stages) | giây |
| `T_run` | "ti rần" | Thời gian thực tế chạy (có thể có grace) | giây |
| `M` | "em" | Số VU thực tế trong pool | VU |
| `C` | "xi" | Capacity (năng lực pool M VU) = M/W | iter/giây |
| `N_sched` | "ren skét" | Tổng slot dự kiến | slot |
| `N_done` | "ren đần" | Tổng iter HOÀN THÀNH | iter |
| `N_drop` | "ren đờ-rốp" | Slot bị drop (chưa start) | slot |
| `N_int` | "ren in-tờ" | Iter bị interrupt (đã start, không xong) | iter |

### 6.5. 3 công thức "1 dòng" để giải mọi case (nhớ vĩnh viễn)

```text
Cần BAO NHIÊU VU?       VU = ceil(rate_đỉnh × thời_gian_1_iter)
Pool CHỊU rate cao bao nhiêu?  rate_max = số_VU / thời_gian_1_iter
THỪA hay THIẾU bao nhiêu?      thiếu = rate_đỉnh − pool_chịu_được
                               (dương = drop, âm = thừa VU)
```

Học thuộc 3 dòng này là dùng được 80% nhu cầu thực tế.

### 6.6. Đọc output sau test: tìm số ở đâu?

Sau khi `k6 run` xong, bạn sẽ thấy 3 nhóm số liệu. Phải biết tìm từng
con số ở đâu để **áp vào đúng công thức** đã học ở 6.1.

**Bảng mapping nhanh: số ở đâu → dùng cho công thức nào**:

```text
| Số liệu                  | Đọc ở đâu              | Dùng cho công thức |
| ------------------------ | ---------------------- | ------------------ |
| λ_peak                   | Header "Up to X iter/s"| CT 1, 2 (verify)   |
| T = sum(stage.duration)  | Header "for Xs"        | CT 3 verify        |
| preAllocatedVUs, maxVUs  | Header "maxVUs: A-B"   | CT 1 verify        |
| W (iter_time)            | Summary iteration_duration | CT 1, 2 (sizing)|
| N_done                   | Summary iterations count   | CT 5 (verify)   |
| N_drop                   | Summary dropped_iterations | CT 5 (verify)   |
| M_peak (VU bận cao nhất) | Summary vus max        | CT 1 đảo (suy ngược)|
| actual_rate              | Summary iterations rate    | CT 5 (so target) |
| T_run                    | Footer "running (X.Xs)"| CT 5 (mẫu số rate) |
| N_int                    | Footer "X interrupted" | CT 5 (verify)   |
```

#### Nhóm 1: Header (in ra ngay đầu test)

```text
scenarios: (100.00%) 1 scenario, 6 max VUs, 9s max duration (incl. graceful stop):
         * my_scenario: Up to 4.00 iterations/s for 7s over 3 stages (maxVUs: 5-10)
```

Đọc các con số:

```text
| Output                       | Biến      | Dùng để                                |
|------------------------------|-----------|----------------------------------------|
| "6 max VUs"                  | vus_max   | verify pool đã init đủ                 |
| "9s max duration"            | T+grace   | verify gracefulStop                    |
| "Up to 4.00 iterations/s"    | λ_peak    | INPUT cho CT 1 (sizing) và CT 2 (peak) |
| "for 7s"                     | T         | INPUT cho CT 3 (tính N_sched)          |
| "3 stages"                   | -         | verify số stage trong config           |
| "maxVUs: 5-10"               | preAlloc, maxVUs | verify config                   |
```

**Khi nào đọc**: ngay đầu để verify config đã parse đúng. Đây là input
cho CT 1, 2, 3 (chuẩn bị tính).

#### Nhóm 2: Summary cuối test (block "TOTAL RESULTS")

```text
EXECUTION
iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
iterations...........: 18    2.571428/s
dropped_iterations...: 5     0.714285/s
vus..................: 4     min=2  max=4
vus_max..............: 6     min=6  max=6

NETWORK
http_req_duration....: avg=200ms ...
http_reqs............: 36    5.142857/s
```

Đọc các con số:

```text
| Output                  | Biến         | Dùng để                              |
|-------------------------|--------------|--------------------------------------|
| iteration_duration avg  | W            | INPUT CT 1 (sizing), CT 2 (capacity) |
| iterations (count)      | N_done       | OUTPUT CT 5 (verify với N_sched)     |
| iterations (rate)       | actual_rate  | OUTPUT CT 5 (so với λ_avg target)    |
| dropped_iterations      | N_drop       | OUTPUT CT 5 (slot bị drop)           |
| vus max                 | M_peak       | INPUT CT 1 đảo (capacity_thực = M/W) |
| vus_max                 | preAllocated | verify init phase đúng config        |
| http_reqs (count)       | N_done × N_req| nếu code N HTTP req/iter           |
```

**Khi nào đọc**: sau test xong, áp công thức ngược:

```text
- W từ summary -> verify Bước 2 sizing (CT 1)
- N_done so với N_sched (CT 3) -> tính tỷ lệ chịu được (CT 5)
- M_peak/W -> capacity thực tế (CT 1 đảo)
- N_drop > 0 -> sizing thiếu -> tăng preAllocated (CT 1)
```

#### Nhóm 3: Progress/footer (ngay trước summary)

```text
running (07.6s), 0/6 VUs, 18 complete and 2 interrupted iterations
```

Đọc các con số:

```text
| Output                      | Biến      | Dùng để                          |
|-----------------------------|-----------|----------------------------------|
| "07.6s"                     | T_run     | MẪU SỐ cho actual_rate (CT 5)    |
| "0/6 VUs"                   | -         | snapshot lúc test xong (cosmetic)|
| "18 complete"               | N_done    | trùng với summary, dùng CT 5     |
| "2 interrupted iterations"  | N_int     | OUTPUT CT 5 (iter bị cancel)     |
```

**Lưu ý**: `N_int` CHỈ xuất hiện ở footer, KHÔNG có metric Counter riêng
trong summary. Phải đọc dòng progress cuối cùng.

**Tổng hợp luồng đọc số → áp công thức**:

```text
Header   -> λ_peak, T              [INPUT cho CT 1, 2, 3 - chuẩn bị tính]
Summary  -> W, N_done, N_drop, M   [OUTPUT cho CT 1, 5 - so kết quả]
Footer   -> T_run, N_int           [OUTPUT cho CT 5 - hoàn tất verify]

Áp công thức theo thứ tự:
   CT 3: tính N_sched từ rate_đầu/rate_cuối (lấy từ Header)
   CT 5: verify N_done + N_drop + N_int ≈ N_sched
   CT 1 đảo: M_peak / W = capacity thực, so với λ_peak để biết dư/thiếu
```

### 6.7. Quy trình 5 bước phân tích output

Sau khi có đủ số liệu từ 6.6, làm 5 bước theo thứ tự. Mỗi bước **dùng
đúng 1 công thức từ 6.1**.

**Bảng mapping nhanh: Bước → Công thức → Số liệu cần**:

```text
| Bước | Công thức dùng    | Input cần              | Output                |
|------|-------------------|------------------------|-----------------------|
| 1    | CT 2 (λ_peak)     | Header + config        | Verify config OK      |
| 2    | CT 3 (N_sched)    | rate_đầu, rate_cuối, dur | N_sched mỗi stage   |
| 3    | CT 5 (verify)     | N_done từ summary      | Tỷ lệ N_done/N_sched  |
| 4    | CT 5 (phân tích)  | N_drop + N_int         | Diagnose drop/int     |
| 5    | CT 1 đảo (suy ngược)| W + M_peak từ summary | Capacity thực tế      |
```

#### Output mẫu để phân tích (dùng xuyên suốt 5 bước)

**Config đã chạy**:

```js
export const options = {
  scenarios: {
    demo_analyze: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 5,
      maxVUs: 10,
      gracefulStop: "30s",
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

**Output đầy đủ k6 in ra**:

```text
scenarios: (100.00%) 1 scenario, 10 max VUs, 37s max duration (incl. graceful stop):
         * demo_analyze: Up to 4.00 iterations/s for 7s over 3 stages (maxVUs: 5-10)

running (07.0s), 0/10 VUs, 20 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
    iterations...........: 20    2.857142/s
    dropped_iterations...: 0
    vus..................: 2     min=0  max=2
    vus_max..............: 6     min=6  max=6

  EXECUTION
  scenarios: 1 scenarios completed
```

Áp 5 bước dưới đây vào đúng output này.

#### Bước 1: Verify config có chạy đúng không [dùng CT 2: λ_peak]

**Mục đích**: Kiểm tra k6 đã parse config đúng. Nếu sai → fix config
trước khi đi tiếp.

**Cách làm**: So Header (đọc từ 6.6 Nhóm 1) với config gốc:

```text
Header k6 in:                    Config gốc:
  "Up to 4.00 iterations/s"      startRate=0, max stage.target=4, timeUnit="1s"
                                 -> Áp CT 2: λ_peak = max(0, 4) / 1 = 4 iter/s ✓

  "for 7s"                       sum(stage.duration) = 2+3+2 = 7s ✓

  "maxVUs: 5-10"                 preAllocatedVUs=5, maxVUs=10 ✓

  "10 max VUs"                   pool init đủ 10 instance ✓
```

**Quyết định**:

```text
- Tất cả khớp -> config OK, sang Bước 2
- Có lệch     -> dừng, fix config, chạy lại
```

#### Bước 2: Tính N_sched (số slot dự kiến) [dùng CT 3]

**Mục đích**: Biết "đáng lẽ chạy được bao nhiêu iter" để so với thực tế.

**Cách làm**: Áp Công thức 3 cho TỪNG STAGE rồi cộng lại.

```text
Bước 2.1: Tính rate_đầu, rate_cuối mỗi stage
  Stage 0: rate_đầu = startRate/timeUnit  = 0/1  = 0/s
           rate_cuối = stages[0].target/timeUnit = 4/1 = 4/s
  Stage 1: rate_đầu = rate_cuối stage 0   = 4/s
           rate_cuối = stages[1].target/timeUnit = 4/1 = 4/s (hold)
  Stage 2: rate_đầu = rate_cuối stage 1   = 4/s
           rate_cuối = stages[2].target/timeUnit = 0/1 = 0/s

Bước 2.2: Áp công thức diện tích hình thang [CT 3]
  N_sched_i = duration_i × (rate_đầu_i + rate_cuối_i) / 2

  Stage 0: 2 × (0 + 4) / 2 = 4 slot
  Stage 1: 3 × (4 + 4) / 2 = 12 slot
  Stage 2: 2 × (4 + 0) / 2 = 4 slot
                            ----------
                            N_sched = 20 slot
```

**Tại sao tách stage**: nếu Bước 4 phát hiện drop, biết drop xảy ra ở
stage nào (xem 6.1 Công thức 3 / "Vì sao cần đếm slot từng stage").

#### Bước 3: So với N_done (đã hoàn thành) [dùng CT 5: verify]

**Mục đích**: Tính tỷ lệ "hệ thống chịu được rate target". Càng gần 100%
càng tốt.

**Cách làm**: Lấy `N_done` từ Summary (xem 6.6 Nhóm 2), so với `N_sched`
từ Bước 2:

```text
Lấy số liệu:
  N_done = 20 (Summary "iterations" count)
  N_sched = 20 (vừa tính từ Bước 2)

Áp CT 5:
  N_done / N_sched = 20 / 20 = 100%
  -> hệ thống chịu được TOÀN BỘ rate target
```

**Phân loại tỷ lệ và quyết định**:

```text
| Tỷ lệ N_done/N_sched | Đánh giá          | Hành động       |
|----------------------|-------------------|-----------------|
| >= 99%               | hoàn hảo          | OK, dừng phân tích nếu không cần stress test thêm |
| 95-99%               | drop biên slot    | OK, ignore slot lẻ ở biên stage (xem CT 3 caveat) |
| 80-95%               | có vấn đề        | Bắt buộc Bước 4 + 5 để tìm nguyên nhân |
| < 80%                | sizing sai nặng  | Tăng preAllocated mạnh, chạy lại |

DEMO này: 100% -> rơi vào nhóm "hoàn hảo"
```

#### Bước 4: Tách rõ drop vs interrupt [dùng CT 5: phân tích]

**Mục đích**: Nếu có thiếu hụt (Bước 3 < 100%), xác định **chính xác**
là do drop (sizing thiếu) hay interrupt (code chậm).

**Cách làm**: Đọc 2 con số từ output (xem 6.6):

```text
Lấy số liệu:
  N_drop = 0 (Summary "dropped_iterations")
  N_int  = 0 (Footer "0 interrupted iterations")

Áp CT 5 (verify đẳng thức):
  N_done + N_drop + N_int ≈ N_sched
  20 + 0 + 0 = 20 = N_sched ✓ (khớp tuyệt đối)
```

**Diagnose theo 4 case**:

```text
| N_drop | N_int  | Diagnose                          | Fix                       |
|--------|--------|-----------------------------------|---------------------------|
| 0      | 0      | hoàn hảo                          | không cần fix             |
| > 0    | 0      | sizing thiếu lúc đỉnh rate       | tăng preAllocated (CT 1)  |
| 0      | > 0    | code chậm hơn duration            | tăng gracefulStop         |
| > 0    | > 0    | cả 2 vấn đề: thiếu VU + code chậm | fix cả 2 hướng            |

DEMO này: N_drop=0, N_int=0 -> không cần fix
```

#### Bước 5: Tính capacity thực tế từ output [dùng CT 1 đảo: suy ngược]

**Mục đích**: Biết hệ thống thật sự chịu được rate cao nhất bao nhiêu →
quyết định có thể tăng load hay nên giảm preAllocated.

**Cách làm**: Áp CT 1 đảo `capacity = M / W`:

```text
Bước 5.1: Lấy W và M từ Summary (xem 6.6 Nhóm 2)
  W = iteration_duration avg = 505ms = 0.505s
  M_peak = vus max = 2 (số VU bận cao nhất trong test)

Bước 5.2: Tính capacity THỰC TẾ với M_peak
  C_peak = M_peak / W = 2 / 0.505 ≈ 3.96 iter/s
  -> Đúng bằng λ_peak (~4 iter/s) -> pool dùng VỪA KHÍT

Bước 5.3: Tính capacity NẾU DÙNG HẾT preAllocated
  C_max = preAllocatedVUs / W = 5 / 0.505 ≈ 9.9 iter/s
  -> có thể tăng λ_peak lên ~9 iter/s mà vẫn không drop

Bước 5.4: Verify với CT 1 (sizing forward)
  required_vus theo CT 1 = ceil(λ_peak × W) × 1.2
                         = ceil(4 × 0.505) × 1.2
                         = ceil(2.02) × 1.2
                         ≈ 3 VU
  vus max thực tế = 2 VU (sai số nhỏ vì k6 dùng số nguyên)
  -> sizing CT 1 đúng (cần 3, dùng 2)
```

**Đánh giá pool config**:

```text
preAllocatedVUs = 5 (config)
vus max thực tế = 2 (chỉ dùng 2/5)
-> DƯ 3 VU không dùng tới

Có 2 hướng tối ưu:
  A. Giảm preAllocated xuống 3 -> tiết kiệm RAM, vẫn an toàn (buffer 50%)
  B. Tăng λ_peak lên 8-9/s    -> stress test hệ thống nặng hơn
```

**Tóm tắt 5 bước thành 1 dòng** (dùng cho audit nhanh):

```text
[Bước 1] Header     -> verify config OK
[Bước 2] CT 3       -> N_sched = 20 slot
[Bước 3] CT 5 ratio -> 100%, hoàn hảo
[Bước 4] CT 5 diag  -> N_drop=0, N_int=0
[Bước 5] CT 1 đảo   -> C_thực=3.96/s vừa khít, pool dư 60%
```

Tiếp theo: Section 7+ áp dụng quy trình này vào các edge case (drop nhiều,
interrupt cuối, VU spawn không kịp, ...) — xem Section 4 "Edge cases".
