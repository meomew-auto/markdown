# `ramping-vus`: tham số, ý nghĩa và công thức

File này là bài song song với:

```text
docs/20260514_per-vu-iterations-tham-so-cong-thuc.md
docs/20260515_shared-iterations-tham-so-cong-thuc.md
docs/20260516_constant-vus-tham-so-cong-thuc.md
```

nhưng dành cho executor:

```text
ramping-vus
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-vus/>

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260517_ramping-vus-quick-index.md
```

Worked example QuickPizza:

```text
docs/20260517_ramping_vus_quickpizza_two_requests_worked_example.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [VU ở các stage init ở phase nào](#13-vu-ở-các-stage-init-ở-phase-nào-có-phải-unplanned-vus-không)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Checklist core đã lọc](#39-checklist-core-đã-lọc-cho-ramping-vus)
- [Thêm nhầm field của executor khác](#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Bước nhảy giữa các VU trong 1 stage](#311-bước-nhảy-giữa-các-vu-trong-1-stage)
- [Vì sao không spawn hết VU ngay](#312-vì-sao-không-spawn-hết-vu-ngay-từ-đầu)
- [VU activate xong start iteration ngay](#313-vu-activate-xong-start-iteration-ngay-không-đợi-đủ-target)
- [Bước nhảy áp cho cả ramp up và ramp down](#314-bước-nhảy-áp-cho-cả-ramp-up-và-ramp-down)
- [Demo stage timeline](#4-demo-stage-timeline)
- [Demo VU nhanhchậm](#5-demo-vu-nhanhchậm)
- [Demo gracefulRampDown và interrupted](#6-demo-gracefulrampdown-và-interrupted)
- [Demo stage trùng target trùng duration duration=0s](#63-demo-stage-trùng-target--trùng-duration--duration0s)
- [Edge case startTime và stage 0 duration=0s](#635-edge-case-starttime-và-stage-0-duration0s)
- [Demo QuickPizza 2 requests / iteration](#7-demo-quickpizza-2-requests--iteration)
- [So sánh với constant-vus per-vu shared arrival-rate](#8-so-sánh-với-constant-vus-per-vu-shared-arrival-rate)
- [Cheat sheet](#9-cheat-sheet)

## 1. Ý tưởng chính

`ramping-vus` nghĩa là:

```text
k6 đổi số VU theo timeline stages
mỗi VU vẫn loop iteration kiểu closed model
VU chạy xong iteration thì mới chạy iteration kế
tổng iterations không biết trước
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 5 },
        { duration: "10s", target: 0 },
      ],
    },
  },
};
```

Hiểu là:

```text
ban đầu có 1 VU
10s đầu tăng dần lên 5 VU
20s tiếp theo giữ quanh mức 5 VU
10s cuối giảm dần về 0 VU
```

Không hiểu là:

```text
mỗi VU chạy đúng N iteration
tổng scenario chạy đúng N iteration
mỗi giây luôn start đúng X iteration
```

Điểm cốt lõi:

```text
ramping-vus = variable users over time
```

nhưng vẫn là:

```text
closed model
```

vì mỗi VU chỉ start iteration mới sau khi iteration trước kết thúc.

### 1.1. Khi nào dùng thực tế?

`ramping-vus` hợp khi câu hỏi là:

```text
nếu số user tăng dần rồi giảm dần theo thời gian thì hệ thống phản ứng ra sao?
```

Ví dụ thực tế:

```text
9h sáng user tăng dần từ 50 lên 500 trong 10 phút
giữ 500 user trong 20 phút
giảm dần về 100 user trong 10 phút
```

Hoặc:

```text
muốn test warm-up -> peak -> cool-down
muốn xem hệ thống chịu tải khi concurrency thay đổi liên tục
muốn mô phỏng traffic theo khung giờ, theo chiến dịch, theo event
```

Mapping sang k6:

```text
startVUs = số VU ở đầu timeline
stages = từng đoạn duration + target
```

Một vài case hợp:

- ramp-up từ ít user lên nhiều user
- giữ plateau một lúc rồi ramp-down
- spike nhẹ rồi hạ xuống
- mô phỏng traffic business theo giờ
- stress tăng tải dần để tìm vùng bắt đầu chậm

Không hợp khi mục tiêu là:

```text
chạy đúng 2000 iterations
mỗi account chạy đúng 5 vòng
luôn start đúng 100 iterations/s
```

Khi đó thường dùng:

```text
per-vu-iterations
shared-iterations
constant-arrival-rate
ramping-arrival-rate
```

### 1.2. Core chạy như nào?

Trong code executor:

```text
lib/executor/ramping_vus.go
lib/executor/vu_handle.go
```

Description của executor là:

```text
Up to N looping VUs for D over S stages
```

Ví dụ header:

```text
* ramping_timeline: Up to 4 looping VUs for 12s over 3 stages
```

Những điểm cần lưu ý khi đọc core:

- **config riêng**:
  ```go
  type RampingVUsConfig struct {
      BaseConfig
      StartVUs         null.Int           `json:"startVUs"`
      Stages           []Stage            `json:"stages"`
      GracefulRampDown types.NullDuration `json:"gracefulRampDown"`
  }
  ```

- **default config**:
  ```text
  startVUs = 1
  gracefulRampDown = 30s
  gracefulStop = default từ BaseConfig = 30s
  ```

- **validate**:
  ```text
  startVUs >= 0
  phải có ít nhất 1 stage
  ít nhất startVUs hoặc một target nào đó > 0
  duration stage không âm
  target không âm
  target không vượt maxConcurrentVUs
  ```

- **shortcut**:
  ```js
  export const options = {
    vus: 10,
    stages: [
      { duration: "10s", target: 20 },
      { duration: "20s", target: 20 },
      { duration: "10s", target: 0 },
    ],
  };
  ```

  được derive thành:

  ```js
  export const options = {
    scenarios: {
      default: {
        executor: "ramping-vus",
        startVUs: 10,
        stages: [
          { duration: "10s", target: 20 },
          { duration: "20s", target: 20 },
          { duration: "10s", target: 0 },
        ],
      },
    },
  };
  ```

- **core giữ hai timeline khác nhau**:

  1. `rawSteps`
     ```text
     số VU active theo đúng shape stages
     ```

  2. `gracefulSteps`
     ```text
     số VU tối đa phải reserve để VU đang ramp-down còn có thời gian finish iteration
     ```

- **`rawSteps` điều khiển scale up / graceful stop theo timeline**:
  `scheduledVUsHandlerStrategy()`:

  ```text
  tăng VU  -> start()
  giảm VU  -> gracefulStop()
  ```

- **`gracefulSteps` điều khiển hard stop nếu grace đã hết**:
  `maxAllowedVUsHandlerStrategy()`:

  ```text
  nếu số VU reserve cần giảm tiếp
  -> hardStop()
  ```

- **mỗi `vuHandle` có state machine riêng**:
  executor tạo `vuHandle` cho toàn bộ `maxVUs`.
  Mỗi handle có goroutine `runLoopsIfPossible()`.

  Hiểu đơn giản:

  ```text
  ramping-vus không chỉ start N goroutine cố định từ đầu như constant-vus
  mà tạo pool handle theo max planned VUs
  rồi bật/tắt từng VU theo timeline
  ```

- **`gracefulRampDown` khác `gracefulStop`**:

  `gracefulRampDown`:
  ```text
  áp cho mỗi lần giảm VU bên trong timeline
  ```

  `gracefulStop`:
  ```text
  áp ở cuối scenario
  ```

- **không có đường `dropped_iterations` riêng trong executor này**:
  `ramping-vus` có thể có:

  ```text
  interrupted iterations
  ```

  nhưng không có path emit `dropped_iterations` kiểu `per-vu-iterations` hay `shared-iterations`.

### 1.3. VU ở các stage init ở phase nào? Có phải unplanned VUs không?

Câu hỏi hay gặp:

```text
ban đầu chỉ có startVUs = 1
nhưng stage 1 ramp lên 4 VU
=> 3 VU mới đó được init lúc nào?
=> nó có phải unplanned VUs như arrival-rate không?
```

Trả lời ngắn:

```text
VU của các stage được init ở init phase, không phải runtime
ramping-vus không có khái niệm unplanned VUs
closed model nói chung không có unplanned VUs
```

Đi vào chi tiết core:

- **Init phase init đủ `maxVUs` instance một lần**:

  Trước khi `Run()` chạy, k6 gọi `GetExecutionRequirements()` để biết tổng số VU
  lớn nhất mà execution plan có thể cần. Với `ramping-vus`:

  ```text
  maxVUs = GetMaxPlannedVUs(gracefulSteps)
  ```

  `gracefulSteps` đã reserve thêm slot cho VU đang ramp-down còn finish iteration,
  nên `maxVUs` thường lớn hơn hoặc bằng target lớn nhất trong stages.

  k6 init đúng `maxVUs` VU instance: chạy file-level code (import, biến module-scope,
  `export const options`), tạo JS context cho từng VU, đẩy hết vào pool của
  `ExecutionState`. Bước này xong **trước** khi scenario bắt đầu chạy.

- **`Run()` chỉ tạo `vuHandle` ở state `stopped`**:

  Ở `ramping_vus.go:614-619`:

  ```text
  for i := 0; i < maxVUs; i++ {
      vuHandles[i] = newStoppedVUHandle(...)
      go vuHandles[i].runLoopsIfPossible(...)
  }
  ```

  Tức là tất cả `maxVUs` handle đều được tạo ngay từ đầu, ở state `stopped`.
  Chưa có VU nào active, chưa lấy VU instance nào ra khỏi pool.

- **Scale up = lấy VU đã init từ pool, không init lại**:

  Khi timeline yêu cầu tăng VU, `scheduledVUsHandlerStrategy()` gọi `vuHandle.start()`.
  Ở `vu_handle.go:128`:

  ```text
  vh.initVU, err = vh.getVU()
  vh.activeVU = vh.initVU.Activate(...)
  ```

  `getVU()` chỉ là `executionState.GetPlannedVU()` — lấy VU instance đã được
  init từ trước ra khỏi pool, rồi `Activate()` tạo runtime context.
  Không có bước init JS context lại.

- **Scale down = trả VU về pool, không destroy**:

  Khi timeline yêu cầu giảm VU, `vuHandle.gracefulStop()` cho iteration hiện tại
  finish (trong `gracefulRampDown`), rồi gọi `returnVU()` → `executionState.ReturnVU()`.
  VU instance về lại pool, sẵn sàng cho stage sau lấy ra dùng tiếp.

- **`startVUs` không phải số VU được init**:

  `startVUs` là số VU **active** ở `t=0`, không phải số VU được init.
  Ví dụ:

  ```text
  startVUs = 1
  stages = [{ duration: "4s", target: 4 }, ...]
  ```

  thì init phase vẫn init đủ `maxVUs` (ở demo này là 4) instance.
  Lúc `t=0` chỉ có 1 VU được `start()`, 3 VU còn lại nằm ở state `stopped`
  trong pool, chờ executor gọi `start()` ở các thời điểm sau.

- **So sánh nhanh với arrival-rate (open model)**:

  | Khái niệm | Closed model (`ramping-vus`, `constant-vus`, ...) | Open model (`*-arrival-rate`) |
  | --- | --- | --- |
  | Init thêm VU trong runtime? | không | có, nếu cần |
  | Field `preAllocatedVUs` | không có | có |
  | Field `maxVUs` (scenario) | không có | có |
  | Khái niệm unplanned VU | không tồn tại | `MaxUnplannedVUs = maxVUs - preAllocatedVUs` |
  | Vì sao? | iteration mới chỉ start sau khi iter cũ xong → biết trước số VU cần | rate cố định, có thể vượt năng lực preAllocated → cần spawn thêm |

  Grep core để tự kiểm tra:

  ```text
  unplannedVUs / preAllocatedVUs chỉ xuất hiện ở:
    constant_arrival_rate.go
    ramping_arrival_rate.go
  ```

  Hoàn toàn không có ở `ramping_vus.go`, `constant_vus.go`,
  `per_vu_iterations.go`, `shared_iterations.go`.

Tóm lại:

```text
VU của các stage trong ramping-vus = planned VUs đã pre-init từ init phase
không phải unplanned VUs
closed model không có khái niệm unplanned VUs
unplanned VUs là chuyện riêng của open model (arrival-rate)
```

## 2. Bảng tham số tiếng Việt

| Tên | Nghĩa tiếng Việt | Lấy ở đâu | Giá trị trong ví dụ | Ghi chú |
| --- | --- | --- | --- | --- |
| `executor` | kiểu executor | `options.scenarios.<name>.executor` | `"ramping-vus"` | Chọn chiến lược VU thay đổi theo thời gian. |
| `startVUs` | số VU lúc bắt đầu timeline | `options.scenarios.<name>.startVUs` | `1`, `4`, `10`... | Không phải max VU. |
| `stages` | các đoạn timeline | `options.scenarios.<name>.stages` | mảng stage | Mỗi stage có `duration` và `target`. |
| `stage.duration` | thời gian của đoạn | `stages[i].duration` | `"4s"` | Đây là thời gian đi từ mức hiện tại tới `target` của stage đó. |
| `stage.target` | số VU muốn đạt ở cuối đoạn | `stages[i].target` | `4`, `0`... | Không phải số VU cộng thêm. |
| `regular_duration` | tổng thời gian timeline chính | tổng `stage.duration` | `12s`, `14s`, `6s` | Đây là thời gian progress bar của scenario. |
| `gracefulRampDown` | thời gian cho VU finish khi bị scale xuống giữa timeline | `options.scenarios.<name>.gracefulRampDown` | `"2s"`, `"3s"` | Chỉ liên quan lúc giảm VU. |
| `gracefulStop` | thời gian grace ở cuối scenario | `options.scenarios.<name>.gracefulStop` | `"2s"` | Áp sau khi hết `regular_duration`. |
| `minIterationDuration` | thời gian tối thiểu mỗi iteration | global option | lấy trực tiếp | Nếu function chạy ngắn hơn min, k6 sleep bù sau function. Phần sleep bù không nằm trong `iteration_duration`, nhưng vẫn chiếm VU. |
| `effective_iteration_time` | thời gian VU bị bận cho 1 iteration | tự tính | không min: `iteration_duration`; có min: `max(iteration_duration, minIterationDuration)` | Dùng để ước lượng `per_vu_rate`. |
| `executor_wall_time_after_start_max` | trần wall-clock kể từ lúc scenario start | tính từ config | `regular_duration + gracefulStop` | Header `max duration (incl. graceful stop)` dùng công thức này. |
| `max_planned_vus` | số VU tối đa executor có thể cần reserve | header / core execution plan | `4`, `6` | Thường là target lớn nhất sau scaling/segment; khác với metric `vus_max` dù local run thường trùng số. |
| `active_vus_now` | số VU đang active ở một thời điểm | progress / metric `vus` | thay đổi theo thời gian | Đây là đại lượng lên xuống theo timeline. |
| `completed_iterations` | số iteration hoàn thành thật | summary `iterations` | chỉ biết sau khi chạy | Không có target cố định trước khi chạy. |
| `interrupted_iterations` | số iteration đã start nhưng bị cancel trước khi thành full iteration | progress cuối | thường do hard stop, hết grace, user abort, hoặc interrupt error | Demo interrupt sẽ thấy. |
| `http_requests_per_iteration` | số HTTP request trong 1 iteration | đọc từ code | `2` ở QuickPizza | Không phải builtin field. |
| `checks_per_iteration` | số check trong 1 iteration | đọc từ code | `2` ở QuickPizza | Không phải builtin field. |

## 3. Công thức nền

## 3.1. Tổng thời gian timeline chính

```text
regular_duration = sum(stage.duration)
```

Ví dụ:

```text
stages:
  4s -> 4
  4s -> 4
  4s -> 0

regular_duration = 4s + 4s + 4s = 12s
```

Khớp header:

```text
Up to 4 looping VUs for 12s over 3 stages
```

## 3.2. Trần wall-clock tối đa của scenario

```text
executor_wall_time_after_start_max = regular_duration + gracefulStop
```

Ví dụ:

```text
regular_duration = 12s
gracefulStop = 2s

executor_wall_time_after_start_max = 14s
```

Khớp header:

```text
14s max duration (incl. graceful stop)
```

Lưu ý:

```text
gracefulRampDown không cộng trực tiếp vào dòng max duration của header
```

Nó ảnh hưởng cách reserve/hard-stop VU trong lúc ramp-down.

## 3.3. `stage.target` không phải số VU cộng thêm

Ví dụ:

```text
startVUs = 1
stage 1: duration=4s, target=4
```

thì hiểu là:

```text
tăng từ 1 VU lên 4 VU trong 4s
```

không phải:

```text
1 + 4 = 5 VU
```

## 3.4. Throughput của `ramping-vus`

`ramping-vus` là closed model — quy tắc cốt lõi:

```text
1 VU chỉ start iteration MỚI sau khi iteration CŨ xong
```

→ throughput phụ thuộc 2 yếu tố:

```text
1) số VU đang active (do timeline điều khiển)
2) thời gian 1 iteration của VU (do code điều khiển)
```

### 3.4.1. Per-VU rate

Mỗi VU có iteration time `t_i` (thời gian từ lúc bắt đầu iter tới lúc kết thúc iter):

```text
per_vu_rate_i = 1 / t_i  (iter/giây/VU)
```

Ví dụ:

```text
VU=1 chạy iter mất 0.5s -> per_vu_rate_1 = 1/0.5 = 2 iter/s
VU=2 chạy iter mất 1.0s -> per_vu_rate_2 = 1/1.0 = 1 iter/s
VU=3 chạy iter mất 0.4s -> per_vu_rate_3 = 1/0.4 = 2.5 iter/s
```

### 3.4.2. Peak rate khi nhiều VU active

Tại 1 thời điểm có `active_vus` VU đang bận:

```text
peak_iteration_rate = sum(1 / t_i)  (cộng per-VU rate của tất cả VU active)
```

Ví dụ với 3 VU bên trên cùng active:

```text
peak_iteration_rate = 2 + 1 + 2.5 = 5.5 iter/s
```

Nếu tất cả VU **giống nhau** (cùng `t`):

```text
peak_iteration_rate ≈ active_vus / t

t ở đây = effective_iteration_time
       = iteration_duration                            nếu KHÔNG set minIterationDuration
       = max(iteration_duration, minIterationDuration) nếu CÓ set minIterationDuration
```

### 3.4.3. Vì sao `ramping-vus` không có peak cố định

Khác với `constant-vus` (số VU cố định), `ramping-vus` có `active_vus` thay đổi theo timeline:

```text
active_vus(t) phụ thuộc stage đang chạy
=> peak_rate(t) cũng thay đổi theo
=> không có 1 con số "peak rate" cho cả bài test
```

Phải nghĩ theo từng đoạn:

```text
đang ở stage nào?
lúc đó active_vus khoảng bao nhiêu?
iteration_duration trong code khoảng bao nhiêu?
```

### 3.4.4. Ví dụ đầy đủ

Config:

```js
scenarios: {
  demo_throughput: {
    executor: "ramping-vus",
    startVUs: 1,
    stages: [
      { duration: "3s", target: 3 },   // ramp 1 -> 3
      { duration: "5s", target: 3 },   // hold 3 VU
      { duration: "2s", target: 0 },   // ramp 3 -> 0
    ],
  },
},

// code: mỗi iter sleep 0.5s
export default function () { sleep(0.5); }
```

Bước nhảy stage 0 (ramp 1 → 3 trong 3s):

```text
step_interval = 3s / |3-1| = 1.5s
=> VU thứ 2 vào tại t=1.5s, VU thứ 3 vào tại t=3.0s
```

Throughput theo từng mốc (giả sử iter time đều ≈ 0.5s):

| t (scenario) | stage | active_vus | peak_rate |
| --- | --- | --- | --- |
| 0.0s | stage 0 | 1 | 1 / 0.5 = 2 iter/s |
| 1.5s | stage 0 | 2 | 2 / 0.5 = 4 iter/s |
| 3.0s | stage 0/1 | 3 | 3 / 0.5 = 6 iter/s |
| 5.0s | stage 1 | 3 | 6 iter/s (hold) |
| 8.0s | stage 1/2 | 3 | 6 iter/s (chưa giảm VU) |
| 8.67s | stage 2 | 2 | 2 / 0.5 = 4 iter/s |
| 9.33s | stage 2 | 1 | 1 / 0.5 = 2 iter/s |
| 10.0s | stage 2 | 0 | 0 (scenario hết) |

Diễn giải:

```text
- Stage 0 ramp up: rate tăng theo bước, mỗi 1.5s nhảy +2 iter/s
- Stage 1 hold:    rate giữ peak ổn định ở 6 iter/s suốt 5s
- Stage 2 ramp down: rate giảm theo bước (step = 2s/3 ≈ 0.67s)
                    nhưng vì gracefulRampDown, VU đang stop vẫn finish iter
                    -> rate thực tế hơi cao hơn công thức tại các mốc giảm
```

### 3.4.5. Thực tế khác lý thuyết một chút

Công thức `active_vus / iter_time` là **peak lý thuyết**. Thực tế thấp hơn vài %:

```text
- VU activate xong cần vài µs để vào iter đầu (channel signal, state change)
- console.log, http call có overhead nhỏ
- gracefulRampDown ở stage giảm: VU vẫn finish iter -> rate thực hơi cao
- nếu iter có biến động (http chậm), iter_time thực không đều
```

Verify bằng summary thật:

```text
iterations.........: 51   4.045744/s   <- average rate cả scenario
iteration_duration.: avg=700.32ms      <- iter_time thực

Tính lại từ summary:
  scenario_runtime = 51 / 4.045744 ≈ 12.61s
  với 4 VU peak, iter ~ 700ms -> peak rate lý thuyết = 4/0.7 ≈ 5.7 iter/s
  rate thật trung bình 4 iter/s vì có giai đoạn ramp ít VU
```

### 3.4.6. Tóm tắt công thức

```text
per_vu_rate_i      = 1 / t_i
peak_rate(t)       = sum(1 / t_i) trên các VU đang active tại t
                   ≈ active_vus(t) / effective_iteration_time

effective_iteration_time = max(iteration_duration, minIterationDuration)

active_vus(t) = số VU active theo timeline ramping-vus
              = đoạn ramp up:   fromVUs + floor((t - stageStart) / step_interval)
              = đoạn hold:      target của stage đó
              = đoạn ramp down: target_cũ - floor((t - stageStart) / step_interval)
                                (có grace nên thực tế hơi cao hơn)
```

## 3.5. Average iteration rate của toàn scenario

Từ summary:

```text
iterations...........: count rate/s
```

công thức là:

```text
average_iteration_rate = completed_iterations / summary_runtime_base
```

Ví dụ demo timeline:

```text
iterations = 51
iterations_rate = 4.045744/s
```

Suy ra:

```text
summary_runtime_base
  = 51 / 4.045744
  ≈ 12.61s
```

Khớp progress cuối:

```text
running (12.6s)
```

## 3.6. Average HTTP request rate của toàn scenario

Với Counter:

```text
http_reqs_rate = total_http_requests / summary_runtime_base
```

Ví dụ QuickPizza:

```text
http_reqs = 24
http_reqs_rate = 3.543856/s
```

Suy ra:

```text
summary_runtime_base
  = 24 / 3.543856
  ≈ 6.77s
```

Khớp progress cuối:

```text
running (6.8s)
```

Lưu ý:

```text
summary_runtime_base là mẫu số Counter summary dùng cho cột /s của cả test run
trong demo 1 scenario, startTime=0, không setup/teardown thì nó gần với runtime của scenario
```

## 3.7. Quan hệ giữa iteration và request ở demo QuickPizza

Trong code QuickPizza:

```text
1 iteration = 2 HTTP requests
1 iteration = 2 checks
```

nên:

```text
total_http_requests = completed_iterations * 2
total_checks = completed_iterations * 2
```

Công thức này đúng khi mỗi completed iteration chạy đủ 2 request và 2 check trên cùng code path. Nếu
code có nhánh điều kiện, request fail trước khi gọi request sau, hoặc iteration bị interrupt, phải đọc
`http_reqs`/`checks` thực tế từ summary/custom metric.

Ví dụ:

```text
completed_iterations = 12
```

suy ra:

```text
total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24
```

Khớp summary:

```text
http_reqs.....: 24
checks_total..: 24
```

## 3.8. `gracefulRampDown` và `gracefulStop` tính như nào?

Hai field nhìn giống nhau nhưng tác động ở 2 thời điểm khác nhau. Tách rõ:

```text
gracefulRampDown : grace giữa timeline, khi 1 stage giảm VU
gracefulStop     : grace cuối timeline, khi cả scenario hết
```

Tóm tắt 1 dòng cho từng cái:

```text
gracefulRampDown : "VU bị scale xuống được phép finish iteration đang chạy
                   thêm tối đa N giây trước khi bị hard-stop"

gracefulStop     : "khi cả scenario kết thúc (sum stages), iteration đang chạy
                   được phép tiếp tục thêm tối đa N giây trước khi bị cancel"
```

Default values:

```text
gracefulRampDown = 30s
gracefulStop     = 30s
```

Đọc từ `ramping_vus.go:42-57`. Cả 2 đều là `null.Duration`, có thể set 0s
hoặc tắt hẳn (set `0s` = no grace, hard-stop ngay).

### 3.8.1. `gracefulRampDown` — grace khi giảm VU giữa timeline

**Trước khi đọc tiếp: hai timeline độc lập**

Khi đọc các timeline ví dụ bên dưới, phải tách rõ 2 trục thời gian khác nhau:

```text
Trục 1 — STAGE timeline (do CONFIG quyết định):
  stage.duration cộng dồn -> mỗi stage chiếm 1 đoạn
  stage 0: 5s -> kéo dài t=0..5
  stage 1: 1s -> kéo dài t=5..6
  stage 2: 5s -> kéo dài t=6..11

Trục 2 — VU iteration timeline (do CODE quyết định):
  iter_duration = thời gian default function chạy xong (sleep, http, ...)
  với sleep(4): iter#0 = t=0..4, iter#1 = t=4..8, iter#2 = t=8..12

iter#N của VU = iteration thứ N của VU đó (counter __ITER riêng từng VU)
iter#0 = iteration đầu tiên ngay khi VU activate
```

Hai trục **không đồng bộ** với nhau:

```text
- VU finish iter#0 ở t=4s -> KHÔNG phải stage chuyển
  (stage 0 vẫn đang chạy, mới hết 4/5s)
  VU chỉ đơn giản vào iter#1 ngay lập tức

- Stage 0 hết ở t=5s -> KHÔNG cắt iter đang chạy
  (lúc này VU đang ở giữa iter#1, mới chạy 1s, còn 3s)
  VU tiếp tục iter#1 bình thường

- Stage chỉ điều khiển plannedVUs tại từng mốc
  không can thiệp vào dòng iter của từng VU đã active
```

Hình dung 2 trục song song:

```text
trục stage  : [-- stage 0 (5s) --|s1|-- stage 2 (5s) --]
              0                  5  6                 11

trục VU=1   : [iter#0|iter#1 |iter#2 |iter#3...]
              0      4       8       12
```

**Khi 1 stage giảm số VU** từ `N_cũ` xuống `N_mới` (với `N_mới < N_cũ`),
executor sẽ:

```text
1) emit step (timeOffset=stageEnd, plannedVUs=N_mới)
   "plannedVUs" = số VU active mới = target của stage giảm
   ví dụ stage 4 -> 2 thì plannedVUs=2

2) gọi gracefulStop() cho các VU "dư" (từ index N_mới đến N_cũ - 1)
   ví dụ N_cũ=4, N_mới=2 -> stop vuHandle[3] và vuHandle[2]
   (tức là __VU=4 và __VU=3, vì __VU là 1-based, vuHandle là 0-based)
   các VU này:
     - chuyển state sang toGracefulStop
     - không start iter mới
     - iter đang chạy được tiếp tục

3) reserve thêm gracefulRampDown giây cho các VU vừa stop kịp finish iter
   trong gracefulSteps

4) sau gracefulRampDown:
   - nếu VU đã finish iter -> ReturnVU về pool clean
   - nếu VU còn iter chưa xong -> hardStop() -> iter bị interrupt
```

##### Giải thích kỹ bước 3-4

**Bước 3 — "reserve trong gracefulSteps" là gì?**

Executor giữ 2 timeline song song (xem `ramping_vus.go:177-417`):

```text
rawSteps      : số VU active theo CONFIG stages
                ví dụ stage 4->2 thì rawSteps có step (t=stageEnd, plannedVUs=2)

gracefulSteps : số VU executor RESERVE để giữ cho VU đang finish iter
                = rawSteps + delay xuống VU theo gracefulRampDown
                ví dụ rawSteps có step (plannedVUs=2) tại t=6s
                  thì gracefulSteps có step (plannedVUs=2) tại t=6+3 = 9s
                  (delay đúng gracefulRampDown=3s)
```

`gracefulSteps` = "ngưỡng hard-stop". Trong khoảng `[t_scale, t_scale + gracefulRampDown]`:

```text
- rawSteps đã giảm        -> VU không start iter mới (đã ở toGracefulStop)
- gracefulSteps chưa giảm -> VU CHƯA bị hardStop, vẫn được phép finish iter
```

`reserveVUsForGracefulRampDowns()` (`ramping_vus.go:313-417`) là hàm sinh
`gracefulSteps` từ `rawSteps`. Mỗi lần `rawSteps` giảm VU, function này thêm
1 step tương ứng vào `gracefulSteps` nhưng dời về sau `gracefulRampDown` giây.

**Bước 4 — sau gracefulRampDown thì sao?**

Executor có 2 vòng lặp xử lý 2 timeline (`ramping_vus.go:548-562`):

```text
- scheduledVUsHandlerStrategy (theo rawSteps)
  -> khi rawSteps giảm: gọi vuHandle[i].gracefulStop()
  -> đây là bước 2 ở trên

- maxAllowedVUsHandlerStrategy (theo gracefulSteps)
  -> khi gracefulSteps giảm: gọi vuHandle[i].hardStop()
  -> đây là bước 4
```

Tại mốc `t_hard = t_scale + gracefulRampDown`, executor kiểm tra state của VU:

```text
case A: VU đã finish iter trước t_hard
        -> ReturnVU đã được gọi trong runLoopsIfPossible()
        -> handle về state = stopped
        -> hardStop() là no-op (xem vu_handle.go:165-181, switch case toHardStop, stopped)
        => không có gì xấu xảy ra, VU clean

case B: VU vẫn đang chạy iter tại t_hard
        -> hardStop() gọi vh.cancel() -> hủy context của iteration
        -> goroutine runIter trả về false (do context cancelled)
        -> iteration đếm vào interrupted_iterations metric
        -> VU về state = stopped
        => +1 interrupted iteration
```

Đọc cụ thể từ `vu_handle.go:165-181`:

```go
func (vh *vuHandle) hardStop() {
    switch vh.state {
    case toHardStop, stopped:
        return                          // case A: no-op
    case starting:
        vh.changeState(stopped)
    case running, toGracefulStop:
        vh.changeState(toHardStop)
    }
    vh.cancel()                         // case B: cancel context của iter
    vh.ctx, vh.cancel = context.WithCancel(vh.parentCtx)
}
```

**Ví dụ áp vào demo_rampdown**

Config: `gracefulRampDown=3s`, stage 1 ramp 4->2 trong 1s từ t=5s. Code `sleep(4)`.

```text
rawSteps:
  t=0s     plannedVUs=4
  t=5.0s   plannedVUs=4   (start stage 1, chưa giảm)
  t=5.5s   plannedVUs=3   <- VU=4 nhận gracefulStop
  t=6.0s   plannedVUs=2   <- VU=3 nhận gracefulStop

gracefulSteps:
  t=0s     plannedVUs=4
  t=5.0s   plannedVUs=4
  t=8.5s   plannedVUs=3   <- t=5.5 + 3s grace, mốc hardStop của VU=4
  t=9.0s   plannedVUs=2   <- t=6.0 + 3s grace, mốc hardStop của VU=3

VU=4:
  iter#1 chạy t=4..8 (sleep 4s)
  bị gracefulStop ở t=5.5s -> không start iter mới
  finish iter#1 tại t=8.0s -> ReturnVU clean
  tại t=8.5s executor gọi hardStop(): VU đã ở state=stopped -> NO-OP (case A)

VU=3:
  iter#1 chạy t=4..8
  bị gracefulStop ở t=6.0s
  finish iter#1 tại t=8.0s -> ReturnVU clean
  tại t=9.0s executor gọi hardStop(): NO-OP (case A)
```

Nếu code `sleep(5)` (lâu hơn):

```text
VU=4:
  iter#1 chạy t=4..9 (sleep 5s)
  bị gracefulStop ở t=5.5s
  tại t=8.5s grace hết, iter#1 vẫn còn 0.5s
  hardStop() vào case B: cancel context iter
  -> iter#1 bị cắt -> +1 interrupted

VU=3:
  iter#1 chạy t=4..9
  bị gracefulStop ở t=6.0s
  tại t=9.0s grace hết, iter#1 vừa xong (đúng lúc)
  có thể finish clean hoặc hardStop tùy race condition
```

Lưu ý index:

```text
vuHandle[i]  : 0-based, dùng trong code Go
__VU = i + 1 : 1-based, dùng trong JS
=> vuHandle[3] tương ứng __VU=4
```

Đọc từ core (`ramping_vus.go:313-417`, `vu_handle.go:147-181`):

```text
- reserveVUsForGracefulRampDowns() sinh ra gracefulSteps
  giữ chỗ VU đang ramp-down trong gracefulRampDown giây sau khi bị scale
- maxAllowedVUsHandlerStrategy() theo dõi gracefulSteps
  khi đến hạn -> hardStop() VU
```

#### Ví dụ đầy đủ

Config:

```js
scenarios: {
  demo_rampdown: {
    executor: "ramping-vus",
    startVUs: 4,
    stages: [
      { duration: "5s", target: 4 },   // hold 4 VU trong 5s đầu
      { duration: "1s", target: 2 },   // ramp 4 -> 2 trong 1s tiếp theo
      { duration: "5s", target: 2 },   // hold 2 VU trong 5s cuối
    ],
    gracefulRampDown: "3s",
    gracefulStop: "2s",
  },
},

// code: mỗi iter sleep 4s
export default function () { sleep(4); }
```

Tách 2 trục cho config này:

```text
stage 0: t=0..5  (hold 4 VU)
stage 1: t=5..6  (ramp 4 -> 2, step_interval = 1/2 = 0.5s)
stage 2: t=6..11 (hold 2 VU)

iter time = 4s (do sleep(4))
```

Timeline đầy đủ:

```text
t=0.0s   plannedVUs=4 (startVUs=4)
         4 VU activate, đồng loạt vào iter#0 (sẽ chạy đến t=4.0s)

t=4.0s   4 VU finish iter#0, lập tức vào iter#1 (sẽ đến t=8.0s)
         stage 0 vẫn đang chạy (4/5s)

t=5.0s   stage 0 kết thúc, stage 1 bắt đầu (4 -> 2 trong 1s)
         step_interval = 1s / |2-4| = 0.5s
         emit step (plannedVUs=4) tại t=5.0s -> không thay đổi

t=5.5s   emit step (plannedVUs=3)
         VU=4 nhận gracefulStop()
         VU=4 đang ở giữa iter#1 (đã chạy 1.5s, còn 2.5s)
         được phép tiếp tục, không vào iter mới

t=6.0s   emit step (plannedVUs=2)
         VU=3 nhận gracefulStop()
         VU=3 đang ở giữa iter#1 (đã chạy 2s, còn 2s)
         stage 1 kết thúc, stage 2 bắt đầu

t=8.0s   VU=4 finish iter#1 (2.5s đã trôi qua < grace 3s, finish clean)
         -> ReturnVU về pool
         VU=3 finish iter#1 (2s đã trôi qua < grace 3s, finish clean)
         -> ReturnVU về pool
         VU=1, VU=2 finish iter#1, vào iter#2 (đến t=12.0s)

t=11.0s  stage 2 kết thúc, regular_duration hết
         VU=1, VU=2 đang ở giữa iter#2 (đã chạy 3s, còn 1s)
         gracefulStop = 2s -> được phép tiếp tục đến t=13.0s

t=12.0s  VU=1, VU=2 finish iter#2 (1s < grace 2s, finish clean)
         scenario thật sự kết thúc
```

Nếu đổi `iter time = 5s` (lâu hơn grace):

```text
t=5.5s   VU=4 đang ở iter#1 (đã chạy 1.5s, còn 3.5s)
         reserve grace 3s, hạn cuối = t=8.5s
t=6.0s   VU=3 đang ở iter#1 (đã chạy 2s, còn 3s)
         reserve grace 3s, hạn cuối = t=9.0s
t=8.5s   grace VU=4 hết, vẫn còn 0.5s iter -> hardStop, +1 interrupted
t=9.0s   grace VU=3 hết, vẫn còn 0s iter -> đúng lúc hết, có thể clean
```

Nếu set `gracefulRampDown: "0s"`:

```text
t=5.5s   VU=4 bị hardStop NGAY -> iter#1 đang chạy bị cancel -> +1 interrupted
t=6.0s   VU=3 bị hardStop NGAY -> iter#1 đang chạy bị cancel -> +1 interrupted
```

#### VU sau khi gracefulStop đi đâu? Stage tăng lại có dùng lại không?

Câu trả lời ngắn:

```text
VU bị scale-down KHÔNG bị destroy
nó về pool của ExecutionState
stage sau cần tăng VU thì lấy từ pool ra dùng lại
__ITER counter của VU GIỮ NGUYÊN qua các lần activate
```

Lifecycle đầy đủ của 1 VU instance qua các stage:

```text
1) Init phase   : k6 init đủ maxVUs instance vào pool
                  mỗi instance đã có JS context, sandbox, biến module-scope

2) Stage tăng   : vuHandle[i].start()
                  -> gọi getVU() = executionState.GetPlannedVU()
                  -> lấy 1 InitializedVU từ pool
                  -> Activate() để tạo runtime context (ActiveVU)
                  -> handle về state = running
                  -> VU vào iter ngay

3) Stage giảm   : vuHandle[i].gracefulStop()
                  -> handle về state = toGracefulStop
                  -> iter đang chạy được phép finish
                  -> sau khi finish: returnVU() -> ReturnVU(initVU, false)
                  -> instance trở lại pool, KHÔNG destroy
                  -> handle về state = stopped

4) Stage tăng lại: vuHandle[i].start() lần nữa
                  -> getVU() lấy LẠI 1 instance từ pool
                  -> có thể là instance khác instance lần 1 (pool không order)
                  -> Activate() tạo runtime context mới
                  -> VU vào iter tiếp
```

Đọc từ core:

```text
ramping_vus.go:595-613   getVU/returnVU wrapper quanh ExecutionState
vu_handle.go:115-138     start() gọi getVU + Activate
vu_handle.go:147-181     gracefulStop / hardStop chuyển state
```

Hành vi chi tiết qua 1 lần activate-deactivate-activate:

```text
- Module-scope code (top of file) : chạy 1 LẦN duy nhất ở init phase
                                    không chạy lại khi activate
- Biến module-scope (let/const)   : giữ nguyên giá trị giữa các lần activate
- exec.vu.idInTest (__VU)         : pin cho 1 VU instance, không đổi
- __ITER (iterationInScenario)    : tăng monotonic, KHÔNG reset
                                    qua các lần activate
- Biến trong default function     : reset mỗi iter (scope của hàm)
```

Ví dụ: stages `[hold 4 -> ramp xuống 2 -> ramp lên 4 lại]` với code log `__ITER`.
VU=4 sau khi bị scale xuống rồi lên lại sẽ thấy `__ITER` tiếp tục từ chỗ cũ:

```text
t=0..6s   VU=4 chạy iter#0, iter#1
t=6s      VU=4 finish iter#1, ReturnVU
t=8s      stage tăng lại, VU=4 (hoặc 1 instance khác trong pool) start
          log: __ITER=2  <- KHÔNG reset về 0
```

Vì sao thiết kế thế?

```text
- Init JS context tốn (parse module, tạo runtime sandbox)
- Nếu destroy + init lại mỗi ramp -> spike latency, nhiễu test
- Pool reuse: chỉ trả về handle, instance sẵn dùng
- Init phase đã chuẩn bị đủ maxVUs instance từ đầu (xem 1.3, 3.12)
```

### 3.8.2. `gracefulStop` — grace ở cuối scenario

Khi `t = regular_duration` (sum tất cả stage.duration), scenario "kết thúc"
nhưng iteration đang chạy có thể được phép tiếp tục thêm `gracefulStop` giây
trước khi VU bị hard-stop.

**Hai trục độc lập (giống 3.8.1)**:

```text
Trục stage   : stage 0 chiếm t=0..5  (do duration=5s)
              regular_duration = 5s
              max_duration = regular_duration + gracefulStop = 5+3 = 8s

Trục VU iter : iter_duration = 4s (do code sleep(4))
              VU=1 iter#0 = t=0..4
              VU=1 iter#1 = t=4..8

VU finish iter#0 ở t=4 -> KHÔNG phải scenario hết
                          (stage 0 vẫn đang chạy, mới hết 4/5s)
                          VU vào iter#1 ngay
Stage 0 hết ở t=5      -> KHÔNG cắt iter đang chạy
                          (VU đang ở giữa iter#1)
                          VU tiếp tục iter#1 trong gracefulStop
```

Đọc từ core (`ramping_vus.go:494-563`):

```text
regularDuration, _ := lib.GetEndOffset(rawSteps)
maxDuration, _    := lib.GetEndOffset(gracefulSteps)
// progress bar bám regularDuration
// nhưng VU được phép chạy tới maxDuration
// step cuối bị cap ở sum(stages) + gracefulStop
```

#### Ví dụ đầy đủ

Config:

```js
scenarios: {
  demo_stop: {
    executor: "ramping-vus",
    startVUs: 2,
    stages: [
      { duration: "5s", target: 2 },   // hold 2 VU trong 5s
    ],
    gracefulStop: "3s",
  },
},

// code: mỗi iter sleep 4s
export default function () { sleep(4); }
```

Tách 2 trục:

```text
stage 0    : t=0..5 (hold 2 VU)
iter time  : 4s (do sleep(4))
grace cuối : 3s -> max_duration = 8s
```

Timeline đầy đủ:

```text
t=0.0s   plannedVUs=2 (startVUs=2)
         VU=1, VU=2 activate, đồng loạt vào iter#0 (đến t=4.0s)

t=4.0s   VU=1, VU=2 finish iter#0
         lập tức vào iter#1 (sẽ đến t=8.0s nếu không bị cắt)
         stage 0 vẫn đang chạy (mới hết 4/5s)

t=5.0s   stage 0 kết thúc -> regular_duration hết
         progress bar 100%
         VU đang ở iter#1 (đã chạy 1s, còn 3s)
         vào pha grace: gracefulStop = 3s
         max_duration = 5+3 = 8s

t=8.0s   VU=1, VU=2 finish iter#1 đúng lúc grace hết (3s = grace)
         scenario thật sự kết thúc, không có interrupted iter
```

Header in:

```text
* demo_stop: Up to 2 looping VUs for 5s over 1 stages (gracefulStop: 3s)
8s max duration (incl. graceful stop)
```

#### Biến thể 1: code `sleep(6)` (iter dài hơn 1 stage nhưng vẫn vừa grace)

```text
iter time = 6s
trục VU: iter#0 = t=0..6, iter#1 = t=6..12

t=0.0s   2 VU vào iter#0 (đến t=6.0s)
t=5.0s   stage 0 hết, vào pha grace
         VU đang ở iter#0 (đã chạy 5s, còn 1s)
t=6.0s   VU finish iter#0 (1s qua < grace 3s, finish clean)
         có vào iter#1 không? KHÔNG
         vì regular_duration đã hết, VU đang ở state toGracefulStop
         -> ReturnVU về pool
t=8.0s   không có gì xảy ra (đã exit từ t=6s)
```

#### Biến thể 2: code `sleep(10)` (iter dài hơn cả grace)

```text
iter time = 10s
trục VU: iter#0 = t=0..10

t=0.0s   2 VU vào iter#0 (sẽ đến t=10.0s nếu không bị cắt)
t=5.0s   stage 0 hết, vào pha grace
         VU đang ở iter#0 (đã chạy 5s, còn 5s)
t=8.0s   grace hết, VU vẫn còn 2s iter chưa xong
         -> hardStop -> 2 interrupted iterations
         summary: 0 complete, 2 interrupted
```

#### Biến thể 3: `gracefulStop: "0s"`

```text
t=5.0s   stage 0 hết, KHÔNG có grace
         VU đang ở iter#1 (đã 1s, còn 3s) -> hardStop ngay
         -> 2 interrupted iterations
```

### 3.8.3. Khi `gracefulRampDown` gặp `gracefulStop` ở cuối scenario

Caveat quan trọng từ core (`ramping_vus.go:437-451`):

```text
step cuối của gracefulSteps luôn bị cap ở sum(stages) + gracefulStop
```

Nghĩa là: nếu 1 VU bị scale-down quá sát cuối scenario, grace cuối thật của
nó **không phải** `gracefulRampDown` mà là phần còn lại tính theo
`sum(stages) + gracefulStop`.

#### Ví dụ minh chứng

Config:

```js
scenarios: {
  demo_combined: {
    executor: "ramping-vus",
    startVUs: 4,
    stages: [
      { duration: "8s", target: 4 },   // hold 4 VU trong 8s
      { duration: "1s", target: 0 },   // ramp 4 -> 0 trong 1s cuối
    ],
    gracefulRampDown: "10s",   // grace mid rất dài
    gracefulStop: "1s",        // grace end rất ngắn
  },
},

// code: mỗi iter sleep 5s
export default function () { sleep(5); }
```

Tách 2 trục:

```text
stage 0: t=0..8 (hold 4 VU)
stage 1: t=8..9 (ramp 4 -> 0, step_interval = 1/4 = 0.25s)

iter time = 5s

regular_duration = 9s
gracefulRampDown = 10s -> nếu áp riêng, grace có thể kéo đến t=8.25+10 = 18.25s
gracefulStop     = 1s   -> cap end của max_duration = 9+1 = 10s
```

Timeline:

```text
t=0.0s   4 VU activate, vào iter#0 (đến t=5.0s)

t=5.0s   4 VU finish iter#0, vào iter#1 (sẽ đến t=10.0s nếu không bị cắt)

t=8.0s   stage 1 bắt đầu (ramp 4 -> 0 trong 1s)
         step_interval = 1s / 4 = 0.25s
         emit step (plannedVUs=4) -> không thay đổi

t=8.25s  emit step (plannedVUs=3), VU=4 nhận gracefulStop()
         VU=4 đang ở iter#1 (đã chạy 3.25s, còn 1.75s)
         theo gracefulRampDown=10s, grace của VU=4 đến t=8.25+10 = 18.25s
         NHƯNG bị cap bởi sum(stages) + gracefulStop = 9+1 = 10s
         => grace thực của VU=4 = min(18.25, 10) = đến t=10.0s (còn 1.75s)

t=8.5s   emit step (plannedVUs=2), VU=3 nhận gracefulStop()
         grace VU=3 cap ở t=10.0s (còn 1.5s)

t=8.75s  emit step (plannedVUs=1), VU=2 nhận gracefulStop()
         grace VU=2 cap ở t=10.0s (còn 1.25s)

t=9.0s   emit step (plannedVUs=0), VU=1 nhận gracefulStop()
         regular_duration hết
         grace VU=1 cap ở t=10.0s (còn 1.0s)

t=10.0s  iter#1 của 4 VU đều cần đến t=10.0s mới xong (đã chạy 5s)
         vừa khớp grace cap -> tất cả finish clean
         scenario kết thúc
```

#### Nếu đổi `iter time = 8s`?

```text
t=8.25s  VU=4 nhận gracefulStop, đang ở iter#1 (đã 3.25s, còn 4.75s)
         grace cap ở t=10.0s (còn 1.75s)
t=10.0s  grace cap hết, VU=4 vẫn còn 3s iter
         -> hardStop -> 1 interrupted

t=10.0s  tương tự VU=3, VU=2, VU=1 đều bị hardStop
         => 4 interrupted iterations
```

Ngược lại, nếu đặt `gracefulStop` rất dài (ví dụ `15s`):

```text
gracefulStop = 15s -> cap end = 9+15 = 24s
gracefulRampDown = 10s

VU=4 bị scale tại t=8.25s
  grace VU=4 = min(8.25+10, 24) = min(18.25, 24) = 18.25s
  -> grace VU=4 thật = 10s (gracefulRampDown bind)
```

Lúc này `gracefulRampDown` mới bind. Cap chỉ kích hoạt khi
`gracefulStop < gracefulRampDown`.

#### Tóm gọn quy tắc

```text
grace_thực_của_VU_bị_scale_xuống_tại_t_scale
  = min(t_scale + gracefulRampDown, regular_duration + gracefulStop) - t_scale
  = min(gracefulRampDown, regular_duration + gracefulStop - t_scale)
```

3 case:

```text
1) VU scale ở giữa timeline, còn xa cuối:
   regular_duration + gracefulStop - t_scale > gracefulRampDown
   => grace = gracefulRampDown (case bình thường)

2) VU scale sát cuối:
   regular_duration + gracefulStop - t_scale < gracefulRampDown
   => grace = phần còn lại = ngắn hơn gracefulRampDown

3) VU scale đúng cuối (t_scale = regular_duration):
   => grace = gracefulStop
```

#### Khi nào cần để ý caveat này?

```text
- khi gracefulRampDown >> gracefulStop và stage cuối là ramp xuống
  (như demo trên: 10s vs 1s)
- khi muốn VU đang ở iter dài finish sạch ở cuối scenario
  -> phải set gracefulStop đủ lớn, không đủ nếu chỉ set gracefulRampDown

Quy tắc thực tế: nếu cuối scenario có ramp-down,
gracefulStop nên >= gracefulRampDown để tránh cap bind sớm
```



## 3.9. Checklist core đã lọc cho `ramping-vus`

| Nguồn core | Ý nghĩa | Ghi nhớ |
| --- | --- | --- |
| `ramping_vus.go:42-57` | Config riêng có `startVUs`, `stages`, `gracefulRampDown`; `gracefulStop` đến từ `BaseConfig`. | `ramping-vus` không có `vus`, `duration`, `iterations`, `maxDuration` trong explicit scenario. |
| `ramping_vus.go:85-96` | Validate bắt lỗi `startVUs < 0`, stage rỗng, target âm, không có VU nào > 0. | Phải có load shape hợp lệ. |
| `execution_config_shortcuts.go:28-36,78-82` | Top-level `stages` derive sang `ramping-vus`; top-level `vus` map sang `startVUs`. | `options = { vus, stages }` khác với explicit scenario dùng field `startVUs`. |
| `ramping_vus.go:177-247` | `rawSteps` là shape VU active theo timeline stage. | Đây là timeline logic chính của executor. |
| `ramping_vus.go:177-247` + `SegmentedIndex` | Trong execution segment/distributed run, timeline của mỗi instance được scale bằng segmented index. | Nếu đi vào distributed test, shape từng instance không nhất thiết giống hệt local run. |
| `ramping_vus.go:313-417` | `reserveVUsForGracefulRampDowns()` tạo `gracefulSteps` để giữ chỗ cho VU đang ramp-down finish iteration. | `gracefulRampDown` không đổi header max duration nhưng đổi reserve/hard-stop behavior. |
| `ramping_vus.go:437-451` | Step cuối bị cap ở `sum(stages) + gracefulStop`. | `gracefulStop` là trần wall-clock cuối. |
| `ramping_vus.go:494-561` | `Run()` tách `regularDuration` và `maxDuration`; progress bám `regularDuration`. | Progress 100% rồi nhưng có thể còn grace phase rất ngắn. |
| `vu_handle.go:115-181` | VU được `start()`, `gracefulStop()`, `hardStop()` qua state machine. | Scale-down mềm và hard-stop là hai chuyện khác nhau. |
| `helpers.go:77-113` | Interrupted iteration được đếm khi context bị cancel trong lúc iteration đang chạy; full iteration chỉ tăng ở `AddFullIterations(1)`. | `ramping-vus` có thể có interrupted vì hard stop, hết grace, abort, hoặc interrupt error; không chỉ riêng case `gracefulRampDown=0s`. |
| `internal/js/runner.go:RunOnce()` + `iterationSamples()` | `iteration_duration` được emit trước phần sleep bù `minIterationDuration`. | Nếu có min duration, throughput sizing dùng `effective_iteration_time`, không dùng riêng `iteration_duration`. |
| `ramping_vus.go` + grep metric paths | Không có path emit `dropped_iterations`. | Đừng dạy `ramping-vus` như per/shared về `dropped_iterations`. |

## 3.10. Thêm nhầm field của executor khác có lỗi không?

Có.

Explicit scenario config của `ramping-vus` parse rất strict.

Các run kiểm tra trực tiếp:

```text
executor: "ramping-vus" + duration    -> json: unknown field "duration"
executor: "ramping-vus" + vus         -> json: unknown field "vus"
executor: "ramping-vus" + iterations  -> json: unknown field "iterations"
executor: "ramping-vus" + maxDuration -> json: unknown field "maxDuration"
```

Bảng nhớ nhanh:

| Executor | Đúng | Sai hay bị nhầm | Lỗi |
| --- | --- | --- | --- |
| `ramping-vus` | `startVUs`, `stages`, `gracefulRampDown`, `gracefulStop` | `vus` | `json: unknown field "vus"` |
| `ramping-vus` | `startVUs`, `stages` | `duration` | `json: unknown field "duration"` |
| `ramping-vus` | `startVUs`, `stages` | `iterations` | `json: unknown field "iterations"` |
| `ramping-vus` | `startVUs`, `stages` | `maxDuration` | `json: unknown field "maxDuration"` |

Lưu ý:

```text
top-level shortcut options là chuyện khác
```

Ví dụ:

```js
export const options = {
  vus: 10,
  stages: [
    { duration: "10s", target: 20 },
  ],
};
```

thì hợp lệ, vì shortcut code sẽ derive thành:

```text
startVUs = 10
executor = ramping-vus
```

## 3.11. Bước nhảy giữa các VU trong 1 stage

Câu hỏi: trong stage `ramp 1 → 3 trong 3s`, các VU mới vào ở mốc nào?
Có phải đều 1s/VU không?

Trả lời ngắn:

```text
không phải hằng số 1s
bước nhảy = stageDuration / |target - fromVUs|
         = stageDuration / số VU phải thêm
```

### 3.11.1. Công thức từ core

Đọc `ramping_vus.go:225-230` (nhánh ramp up):

```go
for ; unscaled <= stageEndVUs; scaled, unscaled = index.Next() {
    addStep(
        timeTillEnd-time.Duration(int64(stageDuration)*(stageEndVUs-unscaled)/stageVUDiff),
        uint64(scaled),
    )
}
```

`timeOffset` của step thứ `n` được tính:

```text
timeOffset = timeTillEnd - stageDuration * (stageEndVUs - unscaled) / stageVUDiff
```

Khi `unscaled` tăng dần từ `fromVUs+1` tới `stageEndVUs`, `timeOffset` rải đều
cách nhau:

```text
step_interval = stageDuration / stageVUDiff
              = stageDuration / |target - fromVUs|
```

Mốc của VU thứ `n` thêm vào (với `n = 1..diff`):

```text
mốc_VU_thứ_n = stageStart + n * step_interval
            = stageStart + (n / diff) * stageDuration
```

### 3.11.2. Ví dụ áp dụng

Stage `ramp 1 → 3 trong 3s`:

```text
fromVUs = 1
target  = 3
diff    = 2
duration = 3s
step_interval = 3 / 2 = 1.5s

t=0s    plannedVUs=1   (fromVUs)
t=1.5s  plannedVUs=2   (VU thêm #1)
t=3.0s  plannedVUs=3   (VU thêm #2, đúng cuối stage)
```

Bảng nhanh các tỉ lệ thường gặp:

| Stage | fromVUs | target | diff | duration | step |
| --- | --- | --- | --- | --- | --- |
| ramp 1→3 / 3s | 1 | 3 | 2 | 3s | **1.5s** |
| ramp 1→5 / 4s | 1 | 5 | 4 | 4s | 1s |
| ramp 0→10 / 5s | 0 | 10 | 10 | 5s | 0.5s |
| ramp 5→105 / 10s | 5 | 105 | 100 | 10s | 0.1s |
| ramp 0→1000 / 1s | 0 | 1000 | 1000 | 1s | 1ms |

### 3.11.3. Hai trường hợp đặc biệt

```text
1) duration=0s (instant jump)
   step_interval = 0 / diff = 0
   -> tất cả VU mới vào cùng tại mốc đó (cuối stageStart)

2) target=fromVUs (hold)
   diff = 0, code thoát sớm: if stageVUDiff == 0 { continue }
   -> không sinh step nào trong stage này
```

### 3.11.4. Verify từ log thật

Demo `ramping_vus_starttime_demo.js` có stage 0 = `ramp 1 → 3 trong 3s`,
log thật:

```text
[iter] t=0.0s __VU=1 __ITER=0    <- scenario t=0
[iter] t=1.5s __VU=3 __ITER=0    <- scenario t=1.5s ✓
[iter] t=3.0s __VU=2 __ITER=0    <- scenario t=3.0s ✓
```

Khớp đúng công thức.

## 3.12. Vì sao không spawn hết VU ngay từ đầu?

Câu hỏi hợp lý: init phase đã init đủ `maxVUs` instance vào pool rồi. Vậy
sao không activate hết ngay tại t=0 cho gọn, mà phải rải đều theo timeline?

Trả lời ngắn:

```text
init phase init đủ instance VÀO POOL (sẵn sàng dùng)
nhưng "sẵn sàng dùng" khác với "phải dùng ngay"

ramping-vus là model "variable users over time"
mục đích chính là MÔ PHỎNG concurrency thay đổi theo thời gian

nếu spawn hết ngay -> không còn là ramp, mà là constant
```

### 3.12.1. Vì sao tách init phase và activate?

Init một VU instance là việc nặng:

```text
- chạy lại file-level code (import module, init biến module-scope)
- tạo JS runtime context riêng
- copy module registry, set up sandbox
```

Nếu phải init lúc runtime mỗi khi cần thêm VU, mỗi lần ramp sẽ có spike
latency vì k6 đang vừa init JS context vừa chạy iteration. Test result
sẽ bị nhiễu.

Vì vậy k6 chia làm 2 bước:

```text
1) Init phase  : init đủ maxVUs instance một lần, không tốn wall-clock của test
2) Run phase   : chỉ Activate() các handle theo timeline, không init lại
```

Activate là việc nhẹ — chỉ tạo `ActiveVU` wrapper trên `InitializedVU` có sẵn.

### 3.12.2. Vì sao stage ramp lại rải đều, không activate hết tại stageStart?

Đây là **ý nghĩa nghiệp vụ** của ramp, không phải giới hạn kỹ thuật.

Ví dụ stage `ramp 0 → 100 trong 10s`:

```text
mục đích: mô phỏng "load tăng dần từ 0 lên 100 user trong 10s"
=> tại t=5s, hệ thống đang chịu khoảng 50 user, không phải 100 user

nếu activate 100 VU ngay tại t=0:
  -> tại t=5s đã là 100 user
  -> không phải ramp, mà là constant 100 user trong 10s
  -> sai mục đích test
```

Cho nên rải đều VU theo `step_interval = duration / diff` là cách k6 mô
phỏng đúng quá trình "tăng dần". Đây là điểm phân biệt `ramping-vus` với
`constant-vus`:

```text
constant-vus  : N VU active suốt duration
ramping-vus   : VU active thay đổi theo timeline

nếu muốn jump tức thì -> dùng stage duration=0s (xem 3.11.3)
nếu muốn giữ nguyên N -> dùng constant-vus hoặc stage có target trùng
```

### 3.12.3. Liệt kê hành vi khi cần ramp

```text
- t < stageStart            : VU chưa được activate, ở state stopped
- t = stageStart             : kích hoạt step (timeOffset=stageStart, plannedVUs=fromVUs)
- t = stageStart + n*interval: kích hoạt step thứ n, VU thứ (fromVUs+n) được Activate()
- t = stageEnd               : đủ target VU active

VU đã activate sẽ loop iteration cho tới khi:
  + bị scale-down: gracefulStop() rồi ReturnVU() về pool
  + scenario kết thúc: tương tự
```

Pool VU trong `ExecutionState` không "rỗng" — luôn có đủ instance, chỉ là chưa
được Activate. Activate là cờ "VU này đang chạy", không phải "VU này tồn tại".

### 3.12.4. Kết luận

```text
"đã có sẵn VU trong pool" != "phải activate hết ngay"

init phase  -> chuẩn bị nguyên liệu (instance JS context)
activate    -> đưa nguyên liệu vào dùng theo nhịp timeline
ramp        -> nhịp đó là tăng dần để mô phỏng concurrency tăng dần
```

Nếu muốn test "100 user đột ngột vào hệ thống" thì dùng:

```text
- stage { duration: "0s", target: 100 }       (instant jump)
- hoặc executor: constant-vus với vus: 100   (giữ nguyên 100 từ đầu)
- hoặc startVUs: 100                          (bắt đầu ngay với 100)
```

Còn `ramp` mặc định luôn rải đều, đó chính là điểm khác biệt nghiệp vụ của nó.

## 3.13. VU activate xong start iteration ngay, không đợi đủ target

Câu hỏi: trong stage `ramp 1 → 3 trong 3s`, các VU vào ở `t=0, 1.5s, 3.0s`.
Vậy VU vào ở `t=1.5s` start iteration ngay tại `t=1.5s`, hay phải đợi đến
`t=3.0s` (lúc đủ 3 VU) mới bắt đầu chạy?

Trả lời ngắn:

```text
VU nào activate xong là start iteration NGAY tại mốc đó
không đợi VU khác, không đợi stage kết thúc
mỗi VU một dòng đời độc lập (đặc trưng của closed model)
```

### 3.13.1. Đọc từ core

`scheduledVUsHandlerStrategy()` (`ramping_vus.go:682-693`) — tại đúng mốc của
`rawSteps`, executor gọi `start()` từng handle:

```go
for ; cur < pv; cur++ {
    _ = rs.vuHandles[cur].start()   // gọi ngay tại timeOffset của step
}
```

`vuHandle.start()` (`vu_handle.go:115-138`):

```go
vh.initVU, _ = vh.getVU()                  // lấy VU instance từ pool
vh.activeVU = vh.initVU.Activate(...)      // tạo ActiveVU
close(vh.canStartIter)                      // mở cờ chạy
vh.changeState(starting)
```

`runLoopsIfPossible()` (`vu_handle.go:185-263`) đang chờ ở `<-canStartIter`.
Khi cờ mở:

```go
vu, ctx, cancel = vh.activeVU, vh.ctx, vh.cancel
vh.changeState(running)
// fast path: runIter(ctx, vu) chạy ngay
```

Tổng độ trễ từ "activate" đến "iter đầu start" = vài microsecond cho channel
signal + state change. Coi như **tức thì**.

### 3.13.2. Verify từ log thật

Demo `ramping_vus_starttime_demo.js`, stage 0 ramp 1→3 trong 3s:

```text
[iter] t=0.0s __VU=1 __ITER=0    <- VU 1 activate tại t=0,    chạy iter ngay
[iter] t=1.5s __VU=3 __ITER=0    <- VU 3 activate tại t=1.5s, chạy iter ngay
[iter] t=3.0s __VU=2 __ITER=0    <- VU 2 activate tại t=3.0s, chạy iter ngay
```

3 VU không đồng bộ. Mỗi VU có `__ITER=0` đúng tại mốc activate, không VU nào
đợi VU khác.

### 3.13.3. Snapshot tại các mốc trong stage

Stage 0 = `ramp 1 → 3 trong 3s`, sleep mỗi iter = 0.5s:

```text
t=0.0s   VU=1 activate, vào iter#0
t=0.5s   VU=1 vào iter#1
t=1.0s   VU=1 vào iter#2
t=1.5s   VU=1 vào iter#3, VU=3 activate vào iter#0
t=2.0s   VU=1 iter#4, VU=3 iter#1
t=2.5s   VU=1 iter#5, VU=3 iter#2
t=3.0s   VU=1 iter#6, VU=3 iter#3, VU=2 activate vào iter#0
```

Tại `t=2.0s`:

```text
VU=1: đã chạy 5 iter (iter#0..4)
VU=3: đã chạy 2 iter (iter#0..1)
VU=2: chưa active
```

→ Mỗi VU có counter `__ITER` riêng, đếm độc lập.

### 3.13.4. Throughput tăng dần theo số VU active

Iteration không bị "gom" lại đợi đủ target — nó được sinh đều theo số VU đang
chạy. Công thức peak rate trong stage:

```text
peak_iteration_rate(t) ≈ active_vus(t) / effective_iteration_time

trong đó:
  active_vus(t) = fromVUs + floor((t - stageStart) / step_interval)
  step_interval = stageDuration / |target - fromVUs|
```

Áp vào stage demo (`fromVUs=1, target=3, duration=3s, step_interval=1.5s`).
Code mỗi iter chỉ có `console.log(...)` (gần như tức thì) + `sleep(0.5)`,
nên `effective_iteration_time ≈ 0.5s` (verify từ summary:
`iteration_duration avg=500.33ms`):

| t (scenario) | active_vus | peak_rate = active_vus / 0.5s |
| --- | --- | --- |
| 0.0s | 1 | 1 / 0.5 = 2 iter/s |
| 1.5s | 2 | 2 / 0.5 = 4 iter/s |
| 3.0s | 3 | 3 / 0.5 = 6 iter/s |

Nếu code khác (ví dụ `sleep(1)` hoặc có HTTP request 200ms + sleep 0.5s),
mẫu số `0.5` đổi tương ứng:

```text
sleep(1)              -> effective_iteration_time ≈ 1s   -> rate = active_vus / 1
http 200ms + sleep(0.5) -> effective_iteration_time ≈ 0.7s -> rate = active_vus / 0.7
```

Throughput cứ 1.5s lại tăng 1 bậc. Nếu phải "đợi đủ target" mới chạy thì
throughput ở `0..3s` sẽ là 0 — sai hoàn toàn.

### 3.13.5. Khi VU đang ở giữa iteration thì stage chuyển sao?

Stage chuyển không cắt ngang iteration đang chạy của VU đã active.

Giả sử iter time = 0.7s, VU=3 activate ở scenario t=1.5s. Lifeline của VU=3:

```text
iter#0: 1.5s -> 2.2s
iter#1: 2.2s -> 2.9s
iter#2: 2.9s -> 3.6s   <- iter này "vắt qua" mốc t=3s
```

Tại scenario t=3.0s (giả sử stage chuyển):

```text
VU=3 đang chạy iter#2 (đã chạy 0.1s, còn 0.6s)
stage 1 bắt đầu (target=3 trùng -> không có VU mới activate)
VU=3 KHÔNG bị reset, tiếp tục iter#2 cho tới 3.6s rồi vào iter#3
```

Iteration đang chạy không bị cắt — VU chỉ đơn giản loop tiếp. Stage chuyển
chỉ ảnh hưởng đến `plannedVUs` (số VU active tại mỗi thời điểm), không động
tới iteration đang chạy của VU đã active.

Trường hợp duy nhất iter bị cắt là khi VU bị scale-down qua `gracefulStop()`
hoặc `hardStop()` — xem mục [6. Demo gracefulRampDown và interrupted](#6-demo-gracefulrampdown-và-interrupted).

### 3.13.6. Điểm dễ nhầm

```text
SAI : "đợi đủ target VU rồi mới start hàng loạt"
ĐÚNG: "VU nào activate trước, chạy trước; VU nào activate sau, chạy sau"

SAI : "iteration của các VU đồng bộ với nhau"
ĐÚNG: "mỗi VU loop iteration riêng, không sync với VU khác"

SAI : "phải đợi stage kết thúc mới có metric"
ĐÚNG: "iteration_duration, http_reqs, checks emit ngay từ iter đầu của VU đầu"

SAI : "stage chuyển làm reset iteration đang chạy"
ĐÚNG: "stage chuyển chỉ thay plannedVUs, iteration đang chạy tiếp tục"
```

### 3.13.7. Liên hệ với open model (arrival-rate)

Để tránh nhầm:

```text
ramping-vus (closed):
  - mỗi VU loop iteration của riêng nó
  - khi VU active, nó tự khởi động iter đầu, không cần ai "schedule"
  - rate iteration = sum(1/iter_time) của các VU đang active
  - không có target rate cố định

ramping-arrival-rate (open):
  - scheduler ép tốc độ start iteration theo target rate/timeUnit
  - VU không tự loop, mà chờ scheduler giao iter
  - rate cố định (đến mức cho phép)
  - có thể cần unplanned VU nếu rate vượt năng lực
```

## 3.14. Bước nhảy áp cho cả ramp up và ramp down

Section này tổng hợp 2 ý đã rải ở `3.8.1` và `3.11` thành 1 quy tắc gọn,
để tránh hiểu nhầm "ramp up có bước nhảy, ramp down chỉ có gracefulStop ở
cuối stage".

### 3.14.1. Quy tắc chung

```text
step_interval = stageDuration / |target - fromVUs|
```

Áp dụng **cho cả 2 chiều**:

```text
ramp 1 → 5 trong 4s : step = 4/4 = 1s, mỗi 1s thêm 1 VU
ramp 5 → 1 trong 4s : step = 4/4 = 1s, mỗi 1s bớt 1 VU
ramp 4 → 2 trong 1s : step = 1/2 = 0.5s, mỗi 0.5s bớt 1 VU
```

Ramp down **không phải "stop hết tại stageEnd"**. Mỗi VU bị stop lần lượt
theo bước nhảy, kèm grace để finish iter đang chạy.

### 3.14.2. Khác biệt là HÀNH ĐỘNG tại mỗi mốc

Đọc `scheduledVUsHandlerStrategy()` (`ramping_vus.go:682-693`):

```go
return func(raw lib.ExecutionStep) {
    pv := raw.PlannedVUs
    for ; cur < pv; cur++ {
        _ = rs.vuHandles[cur].start()         // ramp UP: activate
    }
    for ; pv < cur; cur-- {
        rs.vuHandles[cur-1].gracefulStop()    // ramp DOWN: stop dần
    }
}
```

Bảng:

| Hướng | Tại mỗi mốc bước nhảy | Hành động |
| --- | --- | --- |
| Ramp up | `vuHandle[cur].start()` | activate VU từ pool, vào iter ngay |
| Ramp down | `vuHandle[cur-1].gracefulStop()` | VU không nhận iter mới, finish iter hiện tại trong gracefulRampDown, rồi ReturnVU |

Cùng một concept "bước nhảy" — chỉ khác nội dung làm tại mỗi mốc.

### 3.14.3. Ví dụ ramp up

Stage `ramp 1 → 4 trong 3s`:

```text
step_interval = 3s / |4-1| = 1s

t=stageStart       emit step plannedVUs=1 (= fromVUs, không thay đổi)
t=stageStart+1s    emit step plannedVUs=2 -> vuHandle[1].start()
                                              -> __VU=2 vào iter ngay
t=stageStart+2s    emit step plannedVUs=3 -> vuHandle[2].start()
                                              -> __VU=3 vào iter ngay
t=stageStart+3s    emit step plannedVUs=4 -> vuHandle[3].start()
                                              -> __VU=4 vào iter ngay
```

### 3.14.4. Ví dụ ramp down

Stage `ramp 4 → 2 trong 1s, gracefulRampDown=3s`:

```text
step_interval = 1s / |2-4| = 0.5s

t=stageStart       emit step plannedVUs=4 (= fromVUs, không thay đổi)
t=stageStart+0.5s  emit step plannedVUs=3 -> vuHandle[3].gracefulStop()
                                              -> __VU=4 không nhận iter mới
                                              -> được finish iter hiện tại
                                                 trong gracefulRampDown=3s
t=stageStart+1.0s  emit step plannedVUs=2 -> vuHandle[2].gracefulStop()
                                              -> __VU=3 tương tự

VU=4 finish iter trong [stageStart+0.5s, stageStart+0.5s+3s]
   -> ReturnVU clean (nếu kịp)
   -> hardStop (nếu hết grace mà iter chưa xong)

VU=3 finish iter trong [stageStart+1.0s, stageStart+1.0s+3s]
   -> tương tự
```

### 3.14.5. Stage trùng target = no-op

Nếu `target = fromVUs`:

```text
diff = 0 -> step_interval = stageDuration / 0 = không xác định
core thoát sớm: if stageVUDiff == 0 { continue }
=> không emit step nào
=> không có start() và không có gracefulStop()
```

Đây là case "hold" (xem `3.3` và `6.3`). VU đang active tiếp tục loop iter
như bình thường, không có thay đổi.

### 3.14.6. Stage `duration: 0s` = instant jump

Nếu `duration = 0`:

```text
step_interval = 0 / diff = 0
=> mọi VU đổi state cùng lúc tại stageStart

ramp up:   tất cả VU mới start() đồng loạt
ramp down: tất cả VU dư gracefulStop() đồng loạt
```

Xem `6.3.4` (instant jump) và `6.3.5/B` (stage 0 duration=0s).

### 3.14.7. Tổng kết

```text
"bước nhảy" = đặc tính kỹ thuật của tất cả stages có diff != 0
              cả ramp up và ramp down đều có
"gracefulRampDown" = tham số RIÊNG cho ramp down
                     không phải thay thế cho bước nhảy
                     mà là TÀI NGUYÊN cho VU đang bị stop tại mỗi bước nhảy
```

Đọc kết hợp với:

```text
3.8.1 - chi tiết 5 bước executor làm khi giảm VU
3.11  - công thức step_interval
3.13  - VU activate xong start iter ngay (closed model)
6.3   - edge case stage trùng / duration=0s
```

## 4. Demo stage timeline

File:

```text
examples/ramping_vus_stage_timeline_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_stage_timeline_demo.js
```

Code:

```js
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    ramping_timeline: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "4s", target: 4 },
        { duration: "4s", target: 4 },
        { duration: "4s", target: 0 },
      ],
      gracefulRampDown: "2s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(
    `[iter] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(0.7);
}
```

Header thật:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 14s max duration (incl. graceful stop):
         * ramping_timeline: Up to 4 looping VUs for 12s over 3 stages (gracefulRampDown: 2s, gracefulStop: 2s)
```

Summary thật:

```text
iteration_duration...: avg=700.32ms min=700.06ms med=700.31ms max=700.6ms p(90)=700.54ms p(95)=700.56ms
iterations...........: 51  4.045744/s
vus..................: 1   min=1      max=4
vus_max..............: 4   min=4      max=4

running (12.6s), 0/4 VUs, 51 complete and 0 interrupted iterations
```

Điểm cần đọc:

```text
startVUs = 1
target cao nhất = 4
regular_duration = 12s
gracefulStop = 2s
header max duration = 14s
```

Nhưng runtime thật chỉ:

```text
12.6s
```

vì không phải lúc nào cũng phải dùng hết `gracefulStop`.

## 5. Demo VU nhanh/chậm

File:

```text
examples/ramping_vus_vu_speed_count_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_vu_speed_count_demo.js
```

Ý tưởng:

```text
VU nhanh sẽ có __ITER tăng nhanh hơn VU chậm
đến khi ramp up, VU mới tham gia sẽ bắt đầu đếm từ __ITER=0 của chính nó
```

Summary thật:

```text
iteration_duration...: avg=491.09ms min=200.01ms med=500.13ms max=801.15ms p(90)=800.28ms p(95)=800.5ms
iterations...........: 130 9.023909/s
vus..................: 1   min=1      max=6
vus_max..............: 6   min=6      max=6

running (14.4s), 0/6 VUs, 130 complete and 0 interrupted iterations
```

Cách đọc:

```text
min ~ 200ms  -> có VU rất nhanh
med ~ 500ms  -> nhiều iteration rơi quanh nhóm 0.5s
max/p95 ~ 800ms -> có nhóm VU chậm 0.8s
```

Log thật cho thấy:

```text
__VU=1 sleep=0.2s
__VU=2 sleep=0.4s
__VU=3/4 sleep=0.8s
__VU=5/6 sleep=0.5s
```

nên việc `iteration_duration` ra nhiều cụm khác nhau là đúng với code.

## 6. Demo `gracefulRampDown` và interrupted

## 6.1. Graceful ramp-down cho finish iteration

File:

```text
examples/ramping_vus_graceful_rampdown_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_graceful_rampdown_demo.js
```

Ý tưởng:

```text
timeline bắt đầu ramp-down ở 1.0s
nhưng mỗi iteration sleep 2.2s
gracefulRampDown = 3s
=> VU vẫn được finish iteration dù đã bị scale xuống
```

Summary thật:

```text
iteration_duration...: avg=2.2s min=2.2s med=2.2s max=2.2s p(90)=2.2s p(95)=2.2s
iterations...........: 2   0.908824/s
vus..................: 2   min=2      max=2
vus_max..............: 2   min=2      max=2

running (2.2s), 0/2 VUs, 2 complete and 0 interrupted iterations
```

Log thật:

```text
[iter-start] ... sleep=2.2s rampDownStartsAt=1.0s
[iter-end]   ... finishedAfterRampDownStarted=yes
```

Hiểu là:

```text
ramp-down đã bắt đầu từ 1.0s
nhưng vì gracefulRampDown đủ dài
iteration vẫn kết thúc sạch ở 2.2s
```

Đừng đọc ví dụ này thành quy tắc tuyệt đối:

```text
cứ có gracefulRampDown = 3s thì luôn được finish đủ 3s
```

Không đúng ở cuối scenario.
Nếu VU bị scale-down quá sát mốc `sum(stages) + gracefulStop`, thì trần cuối cùng vẫn là
`gracefulStop` của cả scenario, không phải toàn bộ `gracefulRampDown`.

## 6.2. Hard stop khi `gracefulRampDown = 0s`

File:

```text
examples/ramping_vus_interrupt_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_interrupt_demo.js
```

Summary thật:

```text
running (3.0s), 0/1 VUs, 0 complete and 1 interrupted iterations
```

Điểm quan trọng:

```text
không có iteration nào finish
có 1 interrupted iteration
```

Và k6 còn cảnh báo:

```text
No script iterations fully finished, consider making the test duration longer
```

Đây là case rất tốt để nhớ:

```text
ramping-vus có interrupted iterations
nhưng không có dropped_iterations theo đường code bình thường
```

## 6.3. Demo stage trùng target / trùng duration / duration=0s

Câu hỏi hay gặp:

```text
nếu hai stage có cùng target thì sao?
nếu hai stage có cùng duration thì sao?
nếu duration = 0s thì sao?
liệu có chuyện hai stage chạy song song / xung đột không?
```

Trả lời ngắn (đọc từ core `ramping_vus.go:194-233`):

```text
trong 1 scenario, stages luôn tuần tự
stage i+1 bắt đầu đúng lúc stage i kết thúc
không có chuyện 2 stage chạy song song

stage trùng target  -> hold (không có VU change)
stage trùng duration -> không sao, chỉ là độ dài giống nhau
stage duration=0s   -> instant jump tới target ngay tại mốc đó
```

Core minh chứng "1 thời điểm chỉ có đúng 1 stage chạy":

**1) Stages tuần tự, không song song**

`getRawExecutionSteps()` (`ramping_vus.go:177-240`) duyệt `for _, stage := range vlvc.Stages`
và cộng dồn:

```go
timeTillEnd += stageDuration
```

`timeTillEnd` là biến tích lũy, mỗi stage chỉ ghi `ExecutionStep` vào khoảng
`[timeTillEnd_trước, timeTillEnd_sau]`. Không có code nào cho 2 stage ghi step cùng
một khoảng thời gian → không thể chạy song song.

**2) Runtime chỉ đọc 1 step tại 1 thời điểm**

`iterateSteps()` (`ramping_vus.go:625-647`) là vòng lặp `for` đọc từng step theo thứ tự
`TimeOffset` tăng dần:

```go
wait(r.TimeOffset)        // chờ tới mốc thời gian của step
handleNewScheduledVUs(r)  // áp dụng số VU của step đó
i++                       // sang step tiếp theo
```

Tại mọi thời điểm, executor chỉ đang xử lý đúng 1 `ExecutionStep` thuộc đúng 1 stage.

**3) Stage không có "thời gian riêng"**

Stage chỉ là input để sinh ra `rawSteps`. Sau khi sinh xong, executor không còn biết
khái niệm "stage" nữa — chỉ thấy danh sách step theo timeline. Không có cách nào 2 stage
"đè" lên nhau.

Nhớ nhanh:

```text
Stage là khái niệm của config
Step là khái niệm của runtime
1 stage  -> N step trên 1 đoạn timeline liên tục
2 stage  -> 2 đoạn timeline nối đuôi nhau, không bao giờ chồng nhau
```

### 6.3.1. File demo

```text
examples/ramping_vus_stage_overlap_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_stage_overlap_demo.js
```

Code:

```js
export const options = {
  scenarios: {
    stage_overlap: {
      executor: "ramping-vus",
      startVUs: 2,
      stages: [
        { duration: "3s", target: 4 },  // stage 0: ramp 2 -> 4
        { duration: "3s", target: 4 },  // stage 1: target trùng -> hold
        { duration: "0s", target: 6 },  // stage 2: instant jump 4 -> 6
        { duration: "3s", target: 6 },  // stage 3: hold (duration trùng)
        { duration: "3s", target: 0 },  // stage 4: ramp 6 -> 0
      ],
      gracefulRampDown: "2s",
      gracefulStop: "2s",
    },
  },
};
```

### 6.3.2. Header và summary thật

Header:

```text
scenarios: (100.00%) 1 scenario, 6 max VUs, 14s max duration (incl. graceful stop):
         * stage_overlap: Up to 6 looping VUs for 12s over 5 stages (gracefulRampDown: 2s, gracefulStop: 2s)
```

Summary:

```text
iteration_duration...: avg=500.33ms min=500ms med=500.25ms max=502.41ms p(90)=500.5ms p(95)=500.54ms
iterations...........: 96  7.994377/s
vus..................: 1   min=1      max=6
vus_max..............: 6   min=6      max=6

running (12.0s), 0/6 VUs, 96 complete and 0 interrupted iterations
```

Tính nhanh:

```text
regular_duration = 3 + 3 + 0 + 3 + 3 = 12s
header max duration = 12s + gracefulStop 2s = 14s
max VUs trong header = 6 (= target lớn nhất sau ramp)
```

Chi tiết hơn — k6 tính các con số trên bằng cách nào?

**1) `regular_duration`**:

```text
công thức: regular_duration = sum(stage.duration)

stage 0: 3s
stage 1: 3s
stage 2: 0s   <- duration=0 vẫn cộng vào, chỉ là cộng 0
stage 3: 3s
stage 4: 3s
-----------
regular_duration = 12s
```

Lấy từ `ramping_vus.go:495`: `regularDuration, _ := lib.GetEndOffset(rawSteps)`.
`rawSteps` là dãy `ExecutionStep` theo timeline; offset của step cuối chính là
`sum(stage.duration)`.

**2) `max_planned_vus` (số trong header `Up to N looping VUs`)**:

```text
công thức: max(rawSteps[i].PlannedVUs) trên toàn timeline

duyệt qua stages, lấy target lớn nhất từng đạt:
  startVUs = 2
  stage 0 -> 4
  stage 1 -> 4   (trùng, không tăng)
  stage 2 -> 6   (đạt 6 ở t=6s)
  stage 3 -> 6   (trùng, hold ở 6)
  stage 4 -> 0   (giảm)
-----------
max_planned_vus_raw = 6
```

Sau đó cộng thêm reserve cho `gracefulRampDown` (xem `gracefulSteps` trong
`reserveVUsForGracefulRampDowns()`). Trong demo này không có ramp-down giữa
timeline nào tạo thêm reserve, nên:

```text
max VUs = GetMaxPlannedVUs(gracefulSteps) = 6
```

Khớp header: `Up to 6 looping VUs`.

**3) `executor_wall_time_after_start_max` (header `max duration (incl. graceful stop)`)**:

```text
công thức: regular_duration + gracefulStop
        = 12s + 2s
        = 14s
```

Khớp header: `14s max duration (incl. graceful stop)`.

**4) Tại sao `vus_max = 6` mà không phải 4?**:

```text
vus_max là Gauge phản ánh số VU instance được k6 init ở init phase
init phase init đủ max_planned_vus = 6 instance
nên vus_max = 6 ngay từ đầu, không thay đổi
```

Khác với `vus` (Gauge số VU đang active): số này lên xuống theo timeline,
ở demo này min=1 (lúc gần cuối ramp-down), max=6 (lúc plateau ở stage 3).

**5) Stage trùng target ảnh hưởng gì tới các số trên?**:

```text
không ảnh hưởng max_planned_vus
không ảnh hưởng regular_duration (duration của stage trùng vẫn cộng vào)
chỉ là không sinh ExecutionStep mới trong rawSteps
```

Đọc từ `getRawExecutionSteps()` (`ramping_vus.go:194-208`):

```text
stageVUDiff := stageEndVUs - fromVUs
if stageVUDiff == 0 {
    continue   // <- skip step, nhưng timeTillEnd vẫn đã += stageDuration
}
```

Nghĩa là k6 **vẫn cộng `stageDuration` vào `timeTillEnd`** trước khi `continue`.
Stage trùng target chỉ "biến mất" khỏi danh sách `ExecutionStep`, không biến mất
khỏi `regular_duration`.

### 6.3.3. Đọc log theo mốc thời gian

Stage 0 (`t=0..3s`, ramp 2 → 4):

```text
t=0.0s  __VU=2,3            (startVUs=2, lấy đúng 2 handle ra)
t=1.5s  __VU=1 vào          (handle thứ 3 start)
t=3.0s  __VU=4 vào          (handle thứ 4 start, đúng cuối stage 0)
```

Stage 1 (`t=3..6s`, target=4 **trùng** stage 0):

```text
chỉ thấy __VU=1,2,3,4 tiếp tục loop
không có VU mới vào, không có VU nào bị stop
=> hold ở 4 VU đúng 3s
```

Stage 2 (`t=6s`, `duration=0s`, jump 4 → 6):

```text
t=6.0s  __VU=5,6 vào ngay tại mốc 6.0s
```

Stage 3 (`t=6..9s`, hold ở 6, **duration "3s" trùng** stage 0/1/4):

```text
t=6..9s  __VU=1..6 loop đều
=> trùng duration với stage khác không gây xung đột gì
```

Stage 4 (`t=9..12s`, ramp 6 → 0):

```text
t=10.0s  còn 5 VU active
t=11.0s  còn 3 VU active
t=12.0s  còn 1 VU active
running (12.0s), 0/6 VUs, 96 complete
```

### 6.3.4. Kết luận

Nhớ 4 ý:

1. **Stage trong 1 scenario luôn tuần tự**:
   ```text
   stage[i+1] bắt đầu đúng lúc stage[i] kết thúc
   không bao giờ có 2 stage cùng chạy song song trong 1 scenario
   ```

2. **Trùng `target` = hold**:
   ```text
   stage 0: 3s -> 4
   stage 1: 3s -> 4   (trùng target)
   => stage 1 chỉ là plateau 3s ở mức 4 VU
   không có VU mới start, không có VU bị stop
   ```

   Nhìn từ `getRawExecutionSteps()`: `stageVUDiff = stageEndVUs - fromVUs = 0`
   nên executor `continue` luôn, không sinh `ExecutionStep` mới cho stage này.

3. **Trùng `duration` không sao**:
   ```text
   nhiều stage có cùng "3s" chỉ là độ dài bằng nhau
   k6 cộng dồn: timeTillEnd += stageDuration
   không có khái niệm "stage cùng chạy"
   ```

4. **`duration: "0s"` = instant jump**:
   ```text
   stage 2: 0s -> 6
   tại mốc t=6s, k6 emit step (timeOffset=6s, plannedVUs=6) ngay
   2 VU mới (__VU=5, __VU=6) start tại đúng t=6.0s
   ```

   Đây là cách hợp pháp để "nhảy bậc" mà không cần ramp dần.

5. **Muốn 2 load shape chạy song song thật**:
   ```text
   không phải bằng 2 stage trùng giờ trong 1 scenario
   mà là 2 scenario riêng biệt trong options.scenarios
   mỗi scenario có timeline ramping-vus của chính nó
   chúng chạy song song theo startTime của từng scenario
   ```

### 6.3.5. Edge case: `startTime` và stage 0 `duration=0s`

Hai biến thể hay gây nhầm:

```text
A. scenario.startTime > 0     -> dịch toàn bộ timeline về sau N giây
B. stage[0].duration = 0s     -> instant jump VU ngay tại t=0 nội bộ
```

Cả hai không "phá" model `ramping-vus`, chỉ thay đổi mốc thời gian. Đọc kỹ
từng case bên dưới để không nhầm với khái niệm khác.

#### A. `scenario.startTime`: dịch timeline

`startTime` là field của scenario (thuộc `BaseConfig`), default `0s`. Nó nói
scenario này chờ bao lâu sau khi test bắt đầu mới được "active".

File demo:

```text
examples/ramping_vus_starttime_demo.js
```

Code:

```js
export const options = {
  scenarios: {
    delayed_scenario: {
      executor: "ramping-vus",
      startTime: "3s",
      startVUs: 1,
      stages: [
        { duration: "3s", target: 3 },
        { duration: "3s", target: 3 },
        { duration: "2s", target: 0 },
      ],
      gracefulRampDown: "1s",
      gracefulStop: "2s",
    },
  },
};
```

Header thật:

```text
scenarios: (100.00%) 1 scenario, 3 max VUs, 12s max duration (incl. graceful stop):
         * delayed_scenario: Up to 3 looping VUs for 8s over 3 stages (gracefulRampDown: 1s, startTime: 3s, gracefulStop: 2s)
```

Đọc header:

```text
"Up to 3 looping VUs for 8s over 3 stages"
  -> regular_duration nội bộ scenario = 3 + 3 + 2 = 8s
  -> max planned VUs = 3 (target lớn nhất)

"12s max duration (incl. graceful stop)"
  -> startTime + regular_duration + gracefulRampDown
  -> 3s + 8s + 1s = 12s ✓
```

Vì sao `+gracefulRampDown` chứ không phải `+gracefulStop`?

Đọc `ramping_vus.go:494-499`:

```go
maxDuration, _ := lib.GetEndOffset(vlv.gracefulSteps)
```

`gracefulSteps` là timeline đã reserve thêm chỗ cho VU đang ramp-down kịp finish
iteration. Stage cuối ramp `4 -> 0`, k6 reserve thêm `gracefulRampDown = 1s` sau
khi ramp kết thúc, nên end offset của `gracefulSteps` =
`regular_duration + gracefulRampDown`.

Có cap ở `gracefulStop`: `step cuối bị cap ở sum(stages) + gracefulStop`
(`ramping_vus.go:437-451`). Trong demo này `gracefulRampDown=1s < gracefulStop=2s`,
nên cap không bind. Nếu `gracefulRampDown > gracefulStop`, kết quả sẽ bị cap
xuống `regular_duration + gracefulStop`.

Tóm lại công thức:

```text
header max duration = startTime + regular_duration + min(gracefulRampDown, gracefulStop_cap)
                    ≈ startTime + regular_duration + gracefulRampDown (case thường gặp)
```

Output thật theo mốc thời gian (mốc đo từ lúc test start, không phải scenario start):

```text
t=1.0s   waiting  2.0s     <- progress bar đếm ngược tới khi scenario start
t=2.0s   waiting  1.0s
t=3.0s   waiting  0.0s     <- scenario sắp start
t=3.0s   __VU=1 __ITER=0   <- iteration đầu tiên, đúng tại test t=3s
t=4.5s   __VU=3 vào        (scenario nội bộ t=1.5s, ramp từ 1 lên 3 trong 3s -> bước 1.5s)
t=6.0s   __VU=2 vào        (scenario nội bộ t=3s, kết thúc stage 0)
t=11.0s  scenario end      (test t=11s = scenario nội bộ t=8s)
```

Bước nhảy giữa các VU mới không phải lúc nào cũng 1s. k6 rải đều theo công thức
trong core (`ramping_vus.go:225-230`):

```text
step_interval = stageDuration / |target - fromVUs|
              = stageDuration / số_VU_phải_thêm

mốc_VU_thứ_n = stageStart + (n / stageVUDiff) * stageDuration
```

Áp vào stage 0 demo này (`duration=3s, target=3, fromVUs=1`):

```text
diff = 3 - 1 = 2 VU phải thêm
step_interval = 3s / 2 = 1.5s

VU thêm #1 (n=1) -> scenario t = 1.5s
VU thêm #2 (n=2) -> scenario t = 3.0s
```

Nếu bạn đổi sang `duration=4s, target=5, fromVUs=1` thì:

```text
diff = 4 VU
step_interval = 4s / 4 = 1.0s
=> đúng 1s/VU. Đây mới là case "1s 1 VU".
```

Cụ thể trong log:

```text
running (01.0s) ... [   0% ] waiting  2.0s
running (02.0s) ... [   0% ] waiting  1.0s
running (03.0s) ... [   0% ] waiting  0.0s
[iter] t=0.0s __VU=1 __ITER=0    <- scenario t=0  (test t=3.0s)
[iter] t=1.5s __VU=3 __ITER=0    <- scenario t=1.5s (test t=4.5s)
[iter] t=3.0s __VU=2 __ITER=0    <- scenario t=3.0s (test t=6.0s)
running (11.0s) ... [ 100% ]
```

`elapsedSeconds()` trong code dùng `exec.scenario.startTime`, không phải test start
time, nên log in `t=0.0s` ngay cả khi test đã chạy được 3s. Đây là tham chiếu
tốt khi muốn đo "VU vào ở giây thứ mấy của scenario".

Tác động của `startTime` lên các con số:

```text
1) regular_duration scenario (sum stages)        : KHÔNG đổi (vẫn 8s)
2) max_planned_vus scenario                       : KHÔNG đổi (vẫn 3)
3) Wall-clock test end                            : DỊCH về sau startTime giây
4) exec.scenario.startTime trong JS               : trả về Date thật khi scenario start
5) Stage 0 vẫn bắt đầu ở "scenario nội bộ t=0"    : đúng tại wall-clock = startTime
```

Nói cách khác: `startTime` không thay đổi cách `ramping-vus` hoạt động, chỉ
"đặt scenario vào vị trí nào trên trục test wall-clock". Đây là cách dùng để
stagger nhiều scenario chạy lệch giờ trong cùng 1 file.

##### A.1. `startTime` đo từ mốc nào?

`startTime` đo từ **mốc 0 của Run phase**, không phải từ lúc gõ `k6 run`.
Thứ tự các phase trong 1 lần chạy k6:

```text
1. Init phase     : k6 init đủ maxVUs instance vào pool
                    chạy file-level code (import, biến module-scope)
                    -> KHÔNG tính vào wall-clock của scenario

2. Setup phase    : nếu có setup() function thì chạy ở đây
                    -> KHÔNG tính vào wall-clock của scenario

3. Run phase      : scheduler bắt đầu đếm wall-clock từ t=0
                    mỗi scenario bắt đầu tại t = scenario.startTime
                    progress bar và "running (X.Xs)" đếm từ đây

4. Teardown phase : nếu có teardown() function
```

Hệ quả thực tế:

```text
- init/setup chậm không "ăn vào" startTime
  ví dụ setup() mất 5s, startTime="3s" vẫn là 3s sau khi setup xong

- VU instance đã sẵn sàng khi scenario start
  init phase init đủ maxVUs rồi, scenario tới startTime
  chỉ cần Activate() các VU handle có sẵn

- exec.scenario.startTime (Date) trong JS = test_run_phase_start + scenario.startTime
- progress bar "waiting X.Xs" cũng đếm từ Run phase t=0
```

Tóm lại: `startTime` hoàn toàn nằm **sau** pha init VUs.

##### A.2. Granularity của `startTime` và bước nhảy progress bar

Hai chuyện khác nhau, đừng lẫn:

```text
1) Giá trị startTime parse được tới nanosecond
2) Progress bar "waiting X.Xs" tick theo updateFreq, không phải startTime
```

`startTime` parse thành `time.Duration` của Go, nhận mọi đơn vị/độ phân giải:

```js
startTime: "500ms"     // hợp lệ
startTime: "1.5s"      // hợp lệ
startTime: "3s"        // hợp lệ
startTime: "1m30s"     // hợp lệ
startTime: "250ms"     // hợp lệ
```

Còn dòng `waiting 2.0s -> 1.0s -> 0.0s` mà bạn thấy trong log là tốc độ
**refresh** của progress bar, không phải bước nhảy của `startTime`. Đọc từ
`internal/cmd/ui.go:339-343`:

```go
updateFreq := 1 * time.Second              // default (non-TTY)
if gs.Stdout.IsTTY {
    updateFreq = 100 * time.Millisecond    // TTY
}
ticker := time.NewTicker(updateFreq)
```

Bảng:

| Output mode | Refresh rate | Bạn thấy `waiting` đếm ngược |
| --- | --- | --- |
| Non-TTY (pipe vào file/CI log/Bash tool) | 1s | `2.0s -> 1.0s -> 0.0s` |
| TTY (chạy trực tiếp terminal) | 100ms | `2.9s -> 2.8s -> ... -> 0.1s` |

Demo `ramping_vus_starttime_demo.js` ở trên chạy non-TTY (qua Bash tool), nên
log in 1s/lần. Nếu set `startTime: "2.5s"`:

```text
non-TTY:
  t=0s wait...
  t=1.0s waiting 1.5s
  t=2.0s waiting 0.5s
  t=2.5s scenario start <- vẫn start đúng 2.5s, dù không có dòng "waiting 0.0s"

TTY:
  waiting 2.5s -> 2.4s -> ... -> 0.1s -> start
```

Nói gọn:

```text
startTime granularity: nanosecond (parse Go time.Duration)
progress bar tick:     1s non-TTY, 100ms TTY
=> "nhảy 1s" chỉ là artifact của log non-TTY, không phải giới hạn của startTime
```

#### B. Stage 0 có `duration: 0s`: instant jump tại t=0

Đọc `getRawExecutionSteps()` (`ramping_vus.go:194-208`):

```go
timeTillEnd += stageDuration   // += 0 = không đổi, vẫn ở mốc 0

stageVUDiff := stageEndVUs - fromVUs
if stageVUDiff == 0 {
    continue                   // target trùng startVUs -> skip luôn
}
if stageDuration == 0 {
    addStep(timeTillEnd, ...)  // emit step ngay tại t=0
    fromVUs = stageEndVUs
    continue
}
```

Hai nhánh chính:

```text
1) duration=0 và target == startVUs -> không sinh step nào (no-op)
2) duration=0 và target != startVUs -> emit 1 step (timeOffset=0, plannedVUs=target)
                                       jump VU tức thì tại t=0
```

File demo:

```text
examples/ramping_vus_stage0_zero_duration_demo.js
```

Code:

```js
export const options = {
  scenarios: {
    stage0_zero: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "0s", target: 4 },  // stage 0: instant jump 1 -> 4
        { duration: "5s", target: 4 },  // stage 1: hold 4 VU
        { duration: "2s", target: 0 },  // stage 2: ramp down
      ],
      gracefulRampDown: "1s",
      gracefulStop: "2s",
    },
  },
};
```

Header thật:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 8s max duration (incl. graceful stop):
         * stage0_zero: Up to 4 looping VUs for 7s over 3 stages (gracefulRampDown: 1s, gracefulStop: 2s)
```

Đọc header:

```text
regular_duration = 0 + 5 + 2 = 7s
max_planned_vus  = 4 (target lớn nhất, đạt ngay tại t=0)
header max duration = regular_duration + min(gracefulRampDown, gracefulStop_cap)
                    = 7s + min(1s, 2s) = 7s + 1s = 8s ✓
```

Cùng logic như case A.1: `gracefulSteps` reserve thêm `gracefulRampDown=1s` sau
ramp-down stage cuối, end offset = `7s + 1s = 8s`, không cap bởi `gracefulStop=2s`.

Output thật theo mốc thời gian:

```text
t=0.0s   __VU=1, __VU=2, __VU=3, __VU=4 đều có iteration đầu tiên
         <- 4 VU active luôn từ giây đầu, không có ramp dần
t=0.5s   cả 4 VU vào iteration thứ 2
t=1.0s   running 4/4 VUs, 4 complete

t=5.0s   bắt đầu stage 2 (ramp down 4 -> 0)
t=6.0s   3/4 VUs (1 VU đã hoàn thành iter cuối, không start iter mới)
t=7.0s   scenario end
```

Đối chiếu với core: tại `t=0`, executor đã có sẵn step
`(timeOffset=0, plannedVUs=4)`, nên `scheduledVUsHandlerStrategy()` start ngay
4 VU handle. Không có quá trình "ramp từ 1 lên 4" nào xảy ra.

So sánh với form viết trực tiếp `startVUs: 4`:

```js
// Form 1: stage 0 duration=0 jump
startVUs: 1,
stages: [
  { duration: "0s", target: 4 },
  { duration: "5s", target: 4 },
  { duration: "2s", target: 0 },
],

// Form 2: dùng startVUs trực tiếp
startVUs: 4,
stages: [
  { duration: "5s", target: 4 },
  { duration: "2s", target: 0 },
],
```

Hai form tương đương về behavior: cùng `regular_duration = 7s`,
cùng `max_planned_vus = 4`, cùng pattern VU theo timeline.

Khi nào dùng Form 1?

```text
- khi build options động bằng JS, startVUs đã pin = 1 từ logic chung
  nhưng scenario này muốn jump lên N ngay
- khi muốn nhấn mạnh "đoạn jump" trong stages cho dễ đọc
- khi reuse template stages giữa nhiều scenario có startVUs khác nhau
```

Bình thường viết `startVUs` trực tiếp gọn hơn.

#### C. Kết hợp `startTime` và stage 0 `duration=0s`

Nếu cùng dùng cả hai:

```js
startTime: "5s",
startVUs: 1,
stages: [
  { duration: "0s", target: 10 },
  { duration: "10s", target: 10 },
  { duration: "2s", target: 0 },
],
```

Diễn giải timeline:

```text
t=0..5s   : scenario chưa start (waiting)
t=5.0s    : scenario start, stage 0 emit ngay step (timeOffset=0_nội_bộ, plannedVUs=10)
            -> 10 VU active đúng tại wall-clock t=5.0s
t=5..15s  : stage 1 hold ở 10 VU
t=15..17s : stage 2 ramp down
```

Hai field độc lập với nhau:

```text
startTime    -> dịch wall-clock của cả timeline
duration=0s  -> jump VU tại "t=0 nội bộ" (= wall-clock startTime)
```



File:

```text
examples/ramping_vus_quickpizza_two_requests_demo.js
```

Command:

```powershell
rtk k6 run .\examples\ramping_vus_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
export const options = {
  scenarios: {
    quickpizza_ramping_vus: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "2s", target: 4 },
        { duration: "2s", target: 4 },
        { duration: "2s", target: 0 },
      ],
      gracefulRampDown: "2s",
      gracefulStop: "2s",
    },
  },
};

export default function () {
  const home = http.get("https://quickpizza.grafana.com/");
  const quotes = http.get("https://quickpizza.grafana.com/api/quotes");

  check(home, {
    "home status is 200": (res) => res.status === 200,
  });
  check(quotes, {
    "quotes status is 200": (res) => res.status === 200,
  });

  sleep(1);
}
```

Header thật:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 8s max duration (incl. graceful stop):
         * quickpizza_ramping_vus: Up to 4 looping VUs for 6s over 3 stages (gracefulRampDown: 2s, gracefulStop: 2s)
```

Summary thật:

```text
checks_total.......: 24      3.543856/s
http_req_duration..: avg=264.76ms min=245.36ms med=265.13ms max=304.27ms p(90)=276.55ms p(95)=278.82ms
http_req_failed....: 0.00% 0 out of 24
http_reqs..........: 24    3.543856/s

iteration_duration.: avg=1.71s min=1.51s med=1.54s max=2.17s p(90)=2.04s p(95)=2.1s
iterations.........: 12    1.771928/s
vus................: 2     min=2       max=4
vus_max............: 4     min=4       max=4

running (6.8s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Đừng đọc nhầm 3 dòng sau thành cùng một loại số:

```text
4 looping VUs trong header
  = trần planned VU theo execution plan của executor này

running ... 0/4 VUs
  = snapshot ở cuối lúc progress in ra
  = lúc đó không còn VU nào đang bận, nhưng plan tối đa của executor là 4

vus: 2 min=2 max=4
  = Gauge summary của các sample active VUs trong lúc chạy
  = không phải snapshot cuối
```

### 7.1. Từ output suy ra gì?

Vì code có:

```text
1 iteration = 2 requests
1 iteration = 2 checks
```

nên:

```text
total_http_requests = completed_iterations * 2 = 12 * 2 = 24
total_checks = completed_iterations * 2 = 12 * 2 = 24
```

Khớp summary:

```text
http_reqs....: 24
checks_total.: 24
```

### 7.2. Mẫu số `summary_runtime_base` của Counter summary

Từ Counter:

```text
summary_runtime_base = count / rate
```

Từ `iterations`:

```text
summary_runtime_base
  = 12 / 1.771928
  ≈ 6.77s
```

Từ `http_reqs`:

```text
summary_runtime_base
  = 24 / 3.543856
  ≈ 6.77s
```

Khớp progress cuối:

```text
running (6.8s)
```

### 7.3. Vì sao `vus` cuối summary là `2`, không phải `4` hay `0`?

Với Gauge:

```text
value = sample cuối còn giữ
min = sample nhỏ nhất đã thấy
max = sample lớn nhất đã thấy
```

Nên:

```text
vus: 2 min=2 max=4
```

đọc là:

```text
sample cuối k6 giữ được là 2 VU active
trong run có lúc thấp nhất là 2
cao nhất là 4
```

Không nên đọc nhầm thành:

```text
scenario kết thúc mà vẫn còn đúng 2 VU sống
```

## 8. So sánh với `constant-vus`, `per-vu-iterations`, `shared-iterations`, `arrival-rate`

| Điểm so sánh | `ramping-vus` | `constant-vus` | `per-vu-iterations` | `shared-iterations` | `arrival-rate` |
| --- | --- | --- | --- | --- | --- |
| Kiểu model | closed | closed | closed | closed | open |
| Số VU | thay đổi theo timeline | cố định | cố định | cố định | pre-allocated/max VUs |
| Tổng iteration biết trước? | không | không | có | có | không |
| Tốc độ start iteration cố định? | không | không | không | không | có target rate |
| Có đường emit `dropped_iterations` bình thường? | không | không | có thể có | có thể có | có |
| Có interrupted iteration? | có thể có | có thể có | có thể có | có thể có | có thể có |
| Hợp để mô phỏng user theo thời gian? | rất hợp | vừa | ít hợp | ít hợp | chỉ hợp nếu muốn fixed arrival |

Tách ý ngắn:

```text
constant-vus = giữ concurrency cố định
ramping-vus = thay đổi concurrency theo timeline
per-vu-iterations = quota iteration cho từng VU
shared-iterations = quota iteration cho cả pool
arrival-rate = ép tốc độ start iteration
```

## 9. Cheat sheet

```text
ramping-vus = variable VUs over time
```

Công thức hay dùng:

```text
regular_duration = sum(stage.duration)

executor_wall_time_after_start_max = regular_duration + gracefulStop

per_vu_rate_i = 1 / effective_iteration_time

peak_iteration_rate_if_all_active ~= active_vus / effective_iteration_time

average_iteration_rate = completed_iterations / summary_runtime_base

average_http_request_rate = total_http_requests / summary_runtime_base

estimated_http_requests_if_fixed_path = completed_iterations * http_requests_per_iteration

estimated_checks_if_fixed_path = completed_iterations * checks_per_iteration
```

Nhớ nhanh:

```text
stage.target = mức VU ở cuối stage
không phải số VU cộng thêm
```

```text
gracefulRampDown = grace khi giảm VU giữa timeline
gracefulStop = grace ở cuối scenario
```

```text
ramping-vus không có đường emit dropped_iterations bình thường
nhưng có thể có interrupted iterations
```
