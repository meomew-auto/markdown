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
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Checklist core đã lọc](#39-checklist-core-đã-lọc-cho-ramping-vus)
- [Thêm nhầm field của executor khác](#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Demo stage timeline](#4-demo-stage-timeline)
- [Demo VU nhanhchậm](#5-demo-vu-nhanhchậm)
- [Demo gracefulRampDown và interrupted](#6-demo-gracefulrampdown-và-interrupted)
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

## 7. Demo QuickPizza `2 requests / iteration`

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

### 7.2. Runtime thật của scenario

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
