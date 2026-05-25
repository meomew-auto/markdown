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

Vì `ramping-vus` là closed model:

```text
1 VU chỉ start iteration mới sau khi iteration cũ xong
```

nên nếu một VU có iteration time trung bình là `t_i`:

```text
per_vu_rate_i = 1 / t_i
```

Tại một thời điểm, nếu đang có `active_vus` VU bận:

```text
peak_iteration_rate_if_all_active
  = sum(1 / t_i)
```

Nếu đơn giản hóa mọi VU gần như giống nhau:

```text
peak_iteration_rate_if_all_active
  ~= active_vus / effective_iteration_time
```

Trong đó:

```text
effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
```

Lưu ý:

```text
active_vus thay đổi theo timeline
```

nên `ramping-vus` không có một peak cố định cho cả bài test.

Bạn phải nghĩ theo từng đoạn:

```text
đang ở đoạn nào
lúc đó khoảng bao nhiêu VU active
iteration_duration khoảng bao nhiêu
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

Nên tách thành 2 câu:

1. `gracefulRampDown`
   ```text
   khi timeline giảm VU
   VU bị scale xuống không start iteration mới
   nhưng iteration đang chạy có thể finish thêm tối đa gracefulRampDown
   ```

2. `gracefulStop`
   ```text
   khi hết toàn bộ timeline
   iteration đang chạy ở cuối scenario có thể finish thêm tối đa gracefulStop
   ```

Nếu `gracefulRampDown = 0s`:

```text
VU bị scale xuống có thể bị interrupt ngay
```

Nếu `gracefulRampDown > thời gian iteration còn lại`:

```text
iteration có thể finish sạch dù timeline đã giảm VU
```

Nhưng có một caveat rất quan trọng ở gần cuối scenario:

```text
gracefulStop vẫn là trần wall-clock cuối cùng của executor
```

Nói đời thường:

```text
gracefulRampDown = thời gian nới thêm khi bị giảm VU giữa timeline
gracefulStop     = thời gian nới thêm khi cả scenario đi tới đoạn kết
```

Nếu một VU bị scale-down quá sát cuối scenario thì thời gian finish thật của nó có thể bị
`gracefulStop` cắt ngắn. Nghĩa là:

```text
gracefulStop < gracefulRampDown
=> grace cuối thực tế có thể ngắn hơn gracefulRampDown
```

Đây là đúng với comment trong core `ramping_vus.go`: step cuối luôn bị chặn ở
`sum(stages) + gracefulStop`.

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
  -> startTime + regular_duration + gracefulStop
  -> 3s + 8s + 2s = 13s? -> nhưng header in 12s
```

Lưu ý nhỏ: với 1 scenario duy nhất, k6 có thể tính `max duration` của test theo
`max(startTime + regular_duration + gracefulStop)` qua các scenario, và khi
chỉ có 1 scenario thì hiển thị có thể khác chút tùy phiên bản. Quan trọng nhất
là đọc đúng phần nội bộ scenario `8s` và phần `startTime: 3s` được k6 ghi rõ
trong dòng dưới.

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
header max duration nội bộ = 7s + gracefulStop 2s = 9s
header thực in 8s -> tùy phiên bản, đọc dòng "for 7s over 3 stages" là chuẩn nhất
```

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
