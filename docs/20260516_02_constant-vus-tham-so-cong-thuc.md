# `constant-vus`: tham số, ý nghĩa và công thức

File này là bài song song với:

```text
docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md
docs/20260515_02_shared-iterations-tham-so-cong-thuc.md
```

nhưng dành cho executor:

```text
constant-vus
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-vus/>

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260516_01_constant-vus-quick-index.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [VU init phase và closed model](#13-vu-init-phase-và-closed-model)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Checklist core đã lọc](#39-checklist-core-đã-lọc-cho-constant-vus)
- [Thêm nhầm field của executor khác](#310-thêm-nhầm-field-của-executor-khác-có-lỗi-không)
- [Vì sao không có ramp trong constant-vus](#311-vì-sao-không-có-ramp-trong-constant-vus)
- [VU activate xong start iteration ngay](#312-vu-activate-xong-start-iteration-ngay-không-đợi-vu-khác)
- [Bước nhảy của iteration trong 1 VU](#313-bước-nhảy-của-iteration-trong-1-vu)
- [gracefulStop chi tiết với hai trục độc lập](#314-gracefulstop-chi-tiết-với-hai-trục-độc-lập)
- [Lifecycle VU sau khi hết duration](#315-lifecycle-vu-sau-khi-hết-duration)
- [Vì sao constant-vus spawn đủ VU ngay tại t=0](#316-vì-sao-constant-vus-spawn-đủ-vu-ngay-tại-t0)
- [Demo loop theo duration](#4-demo-loop-theo-duration)
- [Demo VU nhanh/chậm](#5-demo-vu-nhanhchậm)
- [Demo interrupt và edge case](#6-demo-interrupt-và-edge-case)
- [Edge case duration rất ngắn so với iter_duration](#62-edge-case-duration-rất-ngắn-so-với-iter_duration)
- [Edge case VU đột nhiên chậm](#63-edge-case-vu-đột-nhiên-chậm-trong-lúc-chạy)
- [Edge case gracefulStop interaction](#64-edge-case-gracefulstop-interaction-với-iteration-đang-chạy)
- [Demo QuickPizza 2 requests / iteration](#7-demo-quickpizza-2-requests--iteration)
- [So sánh với per-vu và shared](#8-so-sánh-với-per-vu-và-shared)
- [Cheat sheet — Công thức cần nhớ nhất](#9-cheat-sheet--công-thức-cần-nhớ-nhất)
  - [9.0 Config chung](#90-config-chung-của-constant-vus)
  - [9.1 5 công thức TOP](#91-5-công-thức-top-cho-constant-vus)
  - [9.2 Bảng tra theo tình huống](#92-bảng-tra-nhanh-gặp-tình-huống-nào-dùng-công-thức-nào)
  - [9.3 Hành động khi gặp vấn đề](#93-hành-động-khi-gặp-vấn-đề)
  - [9.4 Bảng từ vựng](#94-bảng-từ-vựng-ký-hiệu-nào-nghĩa-là-gì)
  - [9.5 3 công thức "1 dòng"](#95-3-công-thức-1-dòng-để-nhớ-vĩnh-viễn)
  - [9.6 Đọc output sau test](#96-đọc-output-sau-test-tìm-số-ở-đâu)
  - [9.7 Quy trình 5 bước phân tích](#97-quy-trình-5-bước-phân-tích-output)

## 1. Ý tưởng chính

`constant-vus` nghĩa là:

```text
k6 giữ cố định N VU đang chạy
mỗi VU chạy xong một iteration thì chạy tiếp iteration mới
scenario dừng theo thời gian duration
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "constant-vus",
      vus: 3,
      duration: "10s",
    },
  },
};
```

Hiểu là:

```text
3 VU chạy song song trong 10 giây
mỗi VU tự loop nhiều iteration nhất có thể
```

Không hiểu là:

```text
mỗi VU chạy đúng N iteration
```

vì `constant-vus` không có field `iterations`.

Điểm cốt lõi:

```text
constant-vus = fixed users over time
```

không phải:

```text
fixed total work
fixed request rate
```

### 1.1. Khi nào dùng thực tế?

`constant-vus` hợp khi câu hỏi là:

```text
Nếu luôn có N user ảo hoạt động trong X phút thì hệ thống chạy ra sao?
```

Ví dụ thực tế:

```text
200 user chạy flow login -> xem dashboard -> logout trong 10 phút
500 user liên tục browse sản phẩm trong 30 phút
50 user giữ đều để kiểm tra memory leak / stability
```

Mapping sang k6:

```text
vus = số user ảo muốn giữ
duration = thời gian muốn giữ mức tải đó
```

Một vài case hợp:

- smoke load ngắn với số user cố định
- baseline test trước khi tăng tải
- soak/stability test với số user giữ đều
- so sánh version A/B dưới cùng mức concurrency
- mô phỏng nhóm user luôn quay vòng thao tác

Không hợp khi mục tiêu là:

```text
chạy đúng tổng 1000 iteration
mỗi account chạy đúng 5 vòng
luôn bắt đầu đúng 100 iteration/s
luôn đạt đúng 500 request/s
```

Khi đó thường dùng:

```text
per-vu-iterations       fixed work per user
shared-iterations       fixed total work
constant-arrival-rate   fixed iteration start rate
ramping-arrival-rate    ramping iteration start rate
```

### 1.2. Core chạy như nào?

Trong code executor:

```text
lib/executor/constant_vus.go
```

Description của executor là:

```text
N looping VUs for D
```

Ví dụ header:

```text
* constant_loop: 2 looping VUs for 3s (gracefulStop: 2s)
```

Những điểm cần lưu ý khi đọc core:

- **config**:
  ```go
  type ConstantVUsConfig struct {
      BaseConfig
      VUs      null.Int           `json:"vus"`
      Duration types.NullDuration `json:"duration"`
  }
  ```

- **default config**:
  ```text
  vus = 1
  duration = không có default, bắt buộc khai báo
  gracefulStop = default từ BaseConfig, thường là 30s nếu không override
  ```

- **validate**:
  ```text
  vus > 0
  duration phải được khai báo
  duration >= 1s
  ```

- **shortcut**:
  ```js
  export const options = {
    vus: 10,
    duration: "30s",
  };
  ```

  được derive thành:

  ```js
  export const options = {
    scenarios: {
      default: {
        executor: "constant-vus",
        vus: 10,
        duration: "30s",
      },
    },
  };
  ```

- **planned VUs được reserve sẵn**:
  `GetExecutionRequirements()` reserve:

  ```text
  t = 0                         PlannedVUs = vus
  t = duration + gracefulStop    PlannedVUs = 0
  ```

  Nghĩa là scheduler biết cần init bao nhiêu VU trước khi executor chạy.

- **executor mới bắt đầu tính thời gian khi `Run()` gọi `getDurationContexts()`**:
  helper này set `startTime = time.Now()`.
  Đây là mốc dùng cho:

  ```text
  duration
  gracefulStop
  exec.scenario.startTime
  ```

- **khi Run() thì executor lấy đủ `vus` ra chạy song song**:

  ```go
  for range numVUs {
      initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)
      activeVUs.Add(1)
      go handleVU(initVU)
  }
  ```

  Ví dụ:

  ```text
  vus = 4
  -> scheduler init đủ 4 planned VUs
  -> executor lấy 4 VUs ra khỏi pool
  -> start 4 goroutine load VU
  -> 4 VU chạy concurrent/song song
  ```

- **mỗi VU loop tuần tự trong chính nó**:

  ```go
  for {
      select {
      case <-regDurationDone:
          return // don't make more iterations
      default:
      }
      runIteration(maxDurationCtx, activeVU)
  }
  ```

  Nghĩa là:

  ```text
  VU 1: iter 0 -> iter 1 -> iter 2 -> ...
  VU 2: iter 0 -> iter 1 -> iter 2 -> ...
  ```

  Một VU không chạy 2 iteration song song bên trong nó. Song song đến từ nhiều VU.

- **hết duration thì không start iteration mới nữa**:
  `regDurationDone` đóng sau `duration`.
  Trước khi start iteration mới, vòng lặp check `regDurationDone`.

- **iteration đang chạy dở được phép finish trong gracefulStop**:
  `runIteration()` nhận `maxDurationCtx`, mà context này sống tới:

  ```text
  duration + gracefulStop
  ```

- **hết duration + gracefulStop thì iteration đang chạy bị interrupt**.

### Dropped iterations có xuất hiện trong constant-vus không?

Thông thường: **không**.

Lý do:

```text
constant-vus không có tổng iteration mục tiêu
constant-vus cũng không có lịch start slot cố định như arrival-rate
```

Nó chỉ có vòng lặp:

```text
while chưa hết duration:
  VU nào rảnh thì chạy iteration tiếp theo
```

Vì không có quota, nên khi hết `duration`, các iteration "có thể đã chạy thêm nếu thời gian dài hơn"
không được xem là `dropped`.

Trong core:

```text
per_vu_iterations.go      có droppedIterationMetric
shared_iterations.go      có DroppedIterations
constant_arrival_rate.go  có DroppedIterations
ramping_arrival_rate.go   có DroppedIterations
constant_vus.go           không push dropped_iterations
```

Với `constant-vus`, case cần nhìn là:

```text
iteration đã start nhưng chưa finish trước duration + gracefulStop
=> interrupted iteration
```

### 1.3. VU init phase và closed model

Câu hỏi hay gặp:

```text
constant-vus có vus = N
N VU đó được init ở phase nào?
có khái niệm unplanned VUs như arrival-rate không?
```

Trả lời ngắn:

```text
N VU được init ở init phase, không phải runtime
constant-vus không có khái niệm unplanned VUs
closed model nói chung không có unplanned VUs
N VU đó được activate đồng loạt tại t=0 (khác ramping-vus)
```

Đi vào chi tiết core:

- **Init phase init đủ `vus` instance một lần**:

  Trước khi `Run()` chạy, k6 gọi `GetExecutionRequirements()` để biết tổng số VU
  lớn nhất mà execution plan có thể cần. Với `constant-vus` (`constant_vus.go:87-98`):

  ```go
  func (clvc ConstantVUsConfig) GetExecutionRequirements(et *lib.ExecutionTuple) []lib.ExecutionStep {
      return []lib.ExecutionStep{
          {
              TimeOffset: 0,
              PlannedVUs: uint64(clvc.GetVUs(et)),
          },
          {
              TimeOffset: clvc.Duration.TimeDuration() + clvc.GracefulStop.TimeDuration(),
              PlannedVUs: 0,
          },
      }
  }
  ```

  Đây là execution plan đơn giản nhất trong các executor:

  ```text
  t = 0                       PlannedVUs = vus
  t = duration + gracefulStop PlannedVUs = 0
  ```

  Không có step trung gian, không có ramp. k6 init đúng `vus` VU instance ở init
  phase: chạy file-level code (import, biến module-scope, `export const options`),
  tạo JS context cho từng VU, đẩy hết vào pool của `ExecutionState`. Bước này
  xong **trước** khi scenario bắt đầu chạy.

- **`Run()` lấy đúng `numVUs` instance ra khỏi pool tại t=0**:

  Khác `ramping-vus` (tạo `vuHandle` ở state `stopped` rồi bật/tắt theo timeline),
  `constant-vus` lấy đủ VU ngay (`constant_vus.go:195-203`):

  ```go
  for range numVUs {
      initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)
      if err != nil {
          cancel()
          return err
      }
      activeVUs.Add(1)
      go handleVU(initVU)
  }
  ```

  `GetPlannedVU(..., true)` lấy 1 instance đã được init từ pool, đồng thời tăng
  `activeVUs` counter (metric `vus`). `handleVU` `Activate()` VU rồi vào loop.

- **Không có scale-down giữa duration**:

  Khác `ramping-vus` có 2 timeline (`rawSteps`/`gracefulSteps`) và state machine
  `vuHandle` (start/gracefulStop/hardStop), `constant-vus` không cần `vuHandle`.
  `constant_vus.go` không import `vu_handle.go`, không có chuyển state runtime.

  N VU active xuyên suốt từ `t=0` đến `t=duration`. Hết duration thì cả N VU
  cùng nhận tín hiệu `regDurationDone` qua `regDurationCtx` đóng, dừng start
  iteration mới.

- **So sánh nhanh với các executor khác**:

  | Khái niệm | `constant-vus` | `ramping-vus` | `*-arrival-rate` (open) |
  | --- | --- | --- | --- |
  | Số VU init ở init phase | đúng `vus` | đúng `maxVUs` (= max planned) | `preAllocatedVUs` |
  | Có thể init thêm runtime? | không | không | có, tới `maxVUs - preAllocatedVUs` |
  | Khái niệm unplanned VU | không có | không có | có |
  | VU goroutine model | direct goroutine cho từng VU | `vuHandle` + state machine | `vuHandle` + state machine |
  | Có scale up/down không? | không | có (qua stages) | không (về số VU active runtime) |

  Grep core để tự kiểm tra:

  ```text
  unplannedVUs / preAllocatedVUs chỉ xuất hiện ở:
    constant_arrival_rate.go
    ramping_arrival_rate.go

  Hoàn toàn không có ở:
    constant_vus.go
    ramping_vus.go
    per_vu_iterations.go
    shared_iterations.go
  ```

- **Đặc trưng của `constant-vus`: số VU pin cố định suốt scenario**:

  Đây là điểm phân biệt rõ nhất:

  ```text
  constant-vus     : N VU active từ t=0 tới t=duration, không đổi
  ramping-vus      : số VU thay đổi theo stages
  per-vu-iterations: N VU active đến khi mỗi VU chạy đủ iterations
  shared-iterations: N VU active đến khi pool tổng hết iteration
  ```

  Vì pin cố định, metric `vus` của `constant-vus` thường thấy:

  ```text
  vus..................: N   min=N      max=N
  vus_max..............: N   min=N      max=N
  ```

  Nếu thấy `min < N` ở giữa run, tức là có VU đã ReturnVU sớm (do test bị abort,
  iteration bị interrupt từ ngoài, hoặc bug). Trong run sạch, `min = max = N`
  trong toàn bộ regular phase.

Tóm lại:

```text
constant-vus VU init = pre-init đủ N instance ở init phase
runtime chỉ activate, không bao giờ init thêm
không có unplanned VUs, không có scale up/down
N VU active xuyên suốt duration
```

## 2. Bảng tham số tiếng Việt

| Tên trong k6 / ký hiệu | Dịch tiếng Việt | Lấy ở đâu | Cách tính / quy đổi | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | kiểu chạy | `options.scenarios.<name>.executor` | `"constant-vus"` | Chọn executor constant VUs. |
| `vus` | số VU cố định | config/header | lấy trực tiếp | Số VU chạy song song trong regular duration. |
| `effective_vus` | số VU thật sau khi scale | core / header | local thường `effective_vus = vus`; execution segment dùng `ScaleInt64(vus)` | Công thức capacity nên dùng số này. |
| `duration` | thời gian giữ VU | config/header | lấy trực tiếp | Hết mốc này k6 không start iteration mới. |
| `startTime` | thời điểm scenario bắt đầu so với test | `BaseConfig` / config | lấy trực tiếp, default `0s` | Scheduler chờ tới mốc này rồi mới gọi executor `Run()`. |
| `gracefulStop` | thời gian chờ dừng mềm | config/base | lấy trực tiếp | Cho iteration đang chạy dở thêm thời gian finish. |
| `executor_wall_time_after_start` | trần thời gian sau khi scenario bắt đầu | header / tự tính | `duration + gracefulStop` | Header thường ghi `max duration (incl. graceful stop)` khi `startTime=0`. |
| `scenario_end_from_test_start` | mốc kết thúc tính từ đầu test | tự tính | `startTime + duration + gracefulStop` | Dùng khi có nhiều scenario hoặc có `startTime`. |
| `minIterationDuration` | thời gian tối thiểu mỗi iteration | global option | lấy trực tiếp | Nếu JS iteration ngắn hơn min, k6 sleep bù sau function. Phần sleep bù này không nằm trong `iteration_duration`, nhưng vẫn chiếm VU trước iteration tiếp theo. |
| `js_iteration_time_i` | thời gian JS thật của 1 iteration | đo/ước lượng | HTTP + check + sleep tự viết + JS code | Đây là phần `iteration_duration` đo được nếu iteration hoàn tất. |
| `t_i` | thời gian chiếm VU cho 1 iteration | ký hiệu mình dùng | không min: `t_i = js_iteration_time_i`; có min: `t_i = max(js_iteration_time_i, minIterationDuration)` | Dùng để ước lượng tốc độ VU. |
| `per_vu_rate_i` | tốc độ 1 VU | tự tính | `1 / t_i` | Một VU trung bình chạy được bao nhiêu iteration/s. |
| `peak_iteration_rate_if_all_vus_active` | peak lý thuyết khi toàn bộ VU còn active | tự tính | `sum(1 / t_i)` hoặc `vus / t` nếu đều nhau | Không phải metric core k6. Dùng để dự đoán. |
| `completed_iterations` | số iteration hoàn thành thật | summary/progress | clean run thường đọc từ `iterations` hoặc progress `complete` | Với constant-vus, số này không biết trước. Edge case context chết trong sleep bù `minIterationDuration` có thể làm summary `iterations` và progress `complete` không hoàn toàn trùng. |
| `interrupted_iterations` | số iteration bị cắt giữa chừng | progress cuối | đọc từ `interrupted iterations` | Có khi iteration dài hơn `duration + gracefulStop`. |
| `actual_scenario_runtime` | thời gian scenario chạy thật theo trực giác của bài | summary / tự tính | thường gần `duration`, hoặc dài hơn nếu có iteration finish trong grace | Hữu ích để hiểu executor, nhưng không phải lúc nào cũng trùng mẫu số `/s` của summary. |
| `average_iteration_rate` | tốc độ iteration trung bình nhìn từ summary | summary | `completed_iterations / summary_runtime_base` | Trong demo 1 scenario sạch, `summary_runtime_base` thường gần `actual_scenario_runtime`. |
| `http_requests_per_iteration` | số request trong 1 iteration | code | đếm `http.get/post/...` | Dùng để map `iterations` sang `http_reqs`. |
| `checks_per_iteration` | số check trong 1 iteration | code | đếm check name / check expression | Dùng để map `iterations` sang `checks_total`. |
| `http_reqs_rate` | tốc độ HTTP request nhìn từ summary | summary | `http_reqs_count / summary_runtime_base` | Đây là RPS theo HTTP request. |
| `iteration_duration` | thời gian 1 iteration hoàn chỉnh | summary | Trend `avg/min/med/max/p...` | Đo từ lúc bắt đầu gọi JS function đến lúc function trả về. |
| `vus` metric | số VU active tại sample | summary/progress | Gauge `value/min/max` | Với constant-vus thường min=max=`vus` trong lúc chạy. |
| `vus_max` metric | số VU initialized/reserved | summary/header | Gauge `value/min/max` | Thường bằng `vus` với constant-vus. |

Ghi nhớ nhanh:

```text
constant-vus:
  effective_vus = vus trong local run thường
  run_until = duration
  total_iterations = không biết trước

W_effective = effective_iteration_time_avg
            = thời gian trung bình 1 iteration chiếm 1 VU
            ~= iteration_duration_avg nếu không có minIterationDuration
            ~= max(iteration_duration_avg, minIterationDuration) nếu có minIterationDuration
```

## 3. Công thức nền

### 3.1. Thời gian scenario

```text
D = duration
G = gracefulStop
S = startTime

executor_wall_time_after_start = D + G

scenario_end_from_test_start = S + D + G
```

Ví dụ:

```text
startTime = 0s
duration = 3s
gracefulStop = 2s

header:
2 max VUs, 5s max duration (incl. graceful stop)
```

Nghĩa là:

```text
3s regular phase
2s graceful stop phase
5s trần wall-clock tối đa
```

Nếu có `startTime`:

```text
startTime = 10s
duration = 3s
gracefulStop = 2s

scenario bắt đầu chạy ở t=10s
scenario có thể kết thúc muộn nhất ở t=10 + 3 + 2 = 15s tính từ đầu test
```

Trong core:

```text
constant_vus.go GetExecutionRequirements()
  trả về offset tương đối với executor start:
    0
    duration + gracefulStop

ScenarioConfigs.GetFullExecutionRequirements()
  cộng thêm config.GetStartTime() vào từng offset

Scheduler.runExecutor()
  chờ startTime rồi mới gọi executor.Run()
```

### 3.2. Tổng iteration

Với `constant-vus`, không có công thức chính xác trước khi chạy:

```text
total_iterations_target = ?
```

vì executor này không có `iterations`.

Sau khi chạy:

```text
completed_iterations = summary iterations count
```

Nếu muốn ước lượng trước, cần biết thời gian chiếm VU của một iteration:

```text
t_i = thời gian chiếm VU của 1 iteration ở VU i
```

Nếu các VU gần giống nhau:

```text
t_i = t
```

Nếu muốn viết ngắn hơn, có thể đặt:

```text
W_effective = effective_iteration_time_avg
            = thời gian trung bình 1 iteration chiếm 1 VU
            ~= iteration_duration_avg nếu không có minIterationDuration
            ~= max(iteration_duration_avg, minIterationDuration) nếu có minIterationDuration

khi các VU gần giống nhau:
W_effective ~= t
```

thì có thể ước lượng:

```text
iterations_per_vu_started_approx ~= ceil(D / W_effective)
completed_iterations_approx ~= vus * ceil(D / W_effective)
```

Nếu dùng execution segment/distributed run, thay `vus` bằng `effective_vus`:

```text
effective_vus = ExecutionTuple.ScaleInt64(vus)

completed_iterations_approx ~= effective_vus * ceil(D / W_effective)
```

Trong local run bình thường:

```text
effective_vus = vus
```

Vì sao dùng `ceil(D / t)`?

Vì VU có thể start iteration cuối trước khi hết `duration`, rồi finish trong `gracefulStop`.

Ví dụ:

```text
D = 3s
t = 0.7s

start times:
0.0s, 0.7s, 1.4s, 2.1s, 2.8s

2.8s < 3s nên iteration cuối vẫn được start
finish khoảng 3.5s trong gracefulStop
```

Do đó:

```text
ceil(3 / 0.7) = 5 iteration/VU
```

Nếu `gracefulStop` quá ngắn, iteration cuối có thể bị interrupt, lúc đó completed thấp hơn ước lượng.

### 3.3. Runtime và rate

Với metric `Counter`, core summary dùng:

```text
rate = count / summary_runtime_base
summary_runtime_base = count / rate
```

Ví dụ từ demo loop:

```text
iterations.........: 10  2.828882/s

summary_runtime_base
  = 10 / 2.828882
  = 3.535s
```

Lưu ý:

```text
đây là mẫu số mà summary Counter dùng cho cột /s của cả test run
trong demo 1 scenario, startTime=0, không setup/teardown thì nó thường gần runtime của scenario
```

Khớp với:

```text
running (3.5s)
```

### 3.4. Một VU chạy được bao nhiêu iteration/s?

Tốc độ một VU:

```text
per_vu_rate_i = 1 / t_i
```

Vì nếu một iteration chiếm VU `t_i` giây, thì trong 1 giây VU đó làm được:

```text
1 / t_i iteration
```

Ví dụ:

```text
t_i = 0.7s
per_vu_rate_i = 1 / 0.7 = 1.43 iter/s
```

Nếu mọi VU gần giống nhau:

```text
peak_iteration_rate_if_all_vus_active
  ~= vus * (1 / t)
  ~= vus / t
```

Ví dụ:

```text
vus = 2
t = 0.703s

peak_iteration_rate_if_all_vus_active
  ~= 2 / 0.703
  ~= 2.84 iter/s
```

Output thật:

```text
iterations.........: 10  2.828882/s
```

Gần khớp vì iteration đều và test ngắn.

### 3.5. Nếu VU nhanh/chậm khác nhau

Với `constant-vus`, mỗi VU tự loop theo tốc độ của nó.

Nếu VU i có `t_i` khác nhau:

```text
peak_iteration_rate_if_all_vus_active
  ~= (1 / t_1) + (1 / t_2) + ... + (1 / t_n)
```

Ví dụ:

```text
VU 1: t_1 = 0.2s => 1 / 0.2 = 5.00 iter/s
VU 2: t_2 = 0.4s => 1 / 0.4 = 2.50 iter/s
VU 3: t_3 = 0.8s => 1 / 0.8 = 1.25 iter/s
VU 4: t_4 = 0.8s => 1 / 0.8 = 1.25 iter/s

peak lý thuyết khi cả 4 VU active:
5 + 2.5 + 1.25 + 1.25 = 10 iter/s
```

Nhưng summary `iterations/s` là **average total rate** trên `summary_runtime_base`:

```text
average_iteration_rate = completed_iterations / summary_runtime_base
```

Nó có thể thấp hơn peak lý thuyết vì:

- test ngắn
- iteration cuối finish trong gracefulStop
- runtime dùng tới lúc toàn bộ complete
- scheduling/overhead

### 3.6. HTTP requests, checks và iterations

Nếu code có:

```text
1 iteration = R HTTP requests
1 iteration = C checks
```

thì:

```text
estimated_http_requests_if_fixed_path = completed_iterations * R
estimated_checks_if_fixed_path = completed_iterations * C

estimated_http_reqs_rate_if_fixed_path = estimated_http_requests_if_fixed_path / summary_runtime_base
estimated_checks_rate_if_fixed_path = estimated_checks_if_fixed_path / summary_runtime_base
```

Và:

```text
estimated_http_reqs_rate ~= iterations_rate * R
estimated_checks_rate ~= iterations_rate * C
```

Chỉ dùng cách nhân này khi mỗi completed iteration thật sự chạy đủ `R` HTTP requests và `C`
checks trên cùng code path. Nếu có branch, lỗi trước khi gọi request sau, hoặc iteration bị
interrupt, đọc `http_reqs`/`checks` thực tế từ summary hoặc custom metric.

Ví dụ:

```text
iterations_rate = 2.333723 iter/s
R = 2 HTTP requests / iteration

estimated_http_reqs_rate ~= 2.333723 * 2
                         ~= 4.667446 req/s
```

Khớp output:

```text
http_reqs..........: 24  4.667445/s
```

### 3.7. `iteration_duration` và `minIterationDuration`

`iteration_duration` đo thời gian JS function chạy thật:

```text
start JS function -> end JS function
```

Trong core, `iterationSamples(startTime, endTime, ...)` được push trước đoạn sleep bù của
`minIterationDuration`.

Vì vậy:

```text
iteration_duration
  = JS + HTTP + checks + sleep() tự viết trong function
```

Nếu có:

```js
export const options = {
  minIterationDuration: "2s",
};
```

và JS function chạy 0.5s, k6 sẽ sleep bù khoảng 1.5s sau function. Phần này:

```text
không làm iteration_duration thành 2s
nhưng vẫn chiếm VU trước khi VU start iteration tiếp theo
```

Nên khi tính capacity:

```text
t_i = max(iteration_duration_i, minIterationDuration)
```

chứ không chỉ lấy `iteration_duration`.

### 3.8. Interrupted vs dropped

Với `constant-vus`:

```text
dropped_iterations
  thường không có
```

Vì không có quota iteration chưa start.

Nhưng có thể có:

```text
interrupted iterations
```

khi:

```text
iteration đã start
nhưng không finish trước duration + gracefulStop
```

### 3.9. Checklist core đã lọc cho `constant-vus`

Bảng này gom các điểm đọc trực tiếp từ core để tránh sót:

| Core location | Lưu ý | Đưa vào công thức / cách đọc |
| --- | --- | --- |
| `constant_vus.go:36-40` | Config riêng chỉ có `VUs` và `Duration`; các field như `startTime`, `gracefulStop`, `exec`, `env`, `tags` đến từ `BaseConfig`. | `constant-vus` không có `iterations`; tổng iteration chỉ biết sau khi chạy. |
| `constant_vus.go:43-48` | Default `vus = 1`, `duration` không có default. | Thiếu `duration` là lỗi config. |
| `base_config.go:40-46` | Default `gracefulStop = 30s`. | Nếu không set, header có thể cộng thêm 30s vào max duration. |
| `base_config.go:85-99` | `startTime` là delay trước khi executor bắt đầu; `gracefulStop` là thời gian chờ iteration đang chạy. | `scenario_end_from_test_start = startTime + duration + gracefulStop`. |
| `constant_vus.go:54-56` | `GetVUs()` dùng `ExecutionTuple.ScaleInt64()`. | Trong local thường `effective_vus = vus`; trong segmented/distributed run phải dùng số đã scale. |
| `constant_vus.go:65-78` | Validate `vus > 0`, `duration` phải có, `duration >= 1s`; `BaseConfig` validate `startTime >= 0`, `gracefulStop >= 0`, `exec` không rỗng. | Các input âm hoặc thiếu duration không chạy được. |
| `constant_vus.go:87-98` | Execution requirements: `PlannedVUs = effective_vus` từ `0` đến `duration + gracefulStop`. | Planned VUs được init trước; không có unplanned VUs cho executor này. |
| `lib/executors.go:249-260` | Khi gom plan nhiều scenario, core cộng `startTime` vào execution steps. | Header/test plan tổng có thể dài hơn `duration + gracefulStop` nếu có `startTime`. |
| `scheduler.go:329-363` | Scheduler chờ `startTime` rồi mới gọi `executor.Run()`. | `exec.scenario.startTime` là lúc scenario thật sự bắt đầu, không phải lúc test command bắt đầu. |
| `constant_vus.go:131` + `helpers.go:141-152` | `getDurationContexts()` tạo `regDurationCtx` cho `duration`, `maxDurationCtx` cho `duration + gracefulStop`. | Hết `duration` không start iteration mới; hết `duration + gracefulStop` thì interrupt. |
| `constant_vus.go:178-192` | Mỗi VU chạy loop tuần tự: check `regDurationDone`, rồi `runIteration()`. | 1 VU không chạy nhiều iteration song song; parallelism đến từ nhiều VUs. |
| `constant_vus.go:195-202` | Executor gọi `GetPlannedVU(..., true)` đúng `effective_vus` lần và `go handleVU`. | Active load goroutine xấp xỉ số VU của executor, ngoài ra process còn nhiều goroutine nội bộ. |
| `helpers.go:224-238` | Activation params truyền `Scenario`, `Exec`, `Env`, `Tags`, callback trả VU, counter iteration. | `exec` chọn function chạy; default là `default`. Tags/env đi vào VU activation. |
| `execution.go:462-481`, `execution.go:544-550` | `GetPlannedVU(..., true)` tăng active VU count; `ReturnVU(..., true)` giảm active VU count. | Metric `vus` phản ánh active VU count được core track. |
| `scheduler.go:199-224` | Scheduler emit `vus` và `vus_max` định kỳ từ active/initialized counters. | `vus`/`vus_max` là Gauge samples, không phải Counter. |
| `helpers.go:77-112` | `getIterationRunner()` tăng full iterations nếu iteration hoàn tất; tăng interrupted nếu context done/interrupt. | `iterations` chỉ là completed iterations; interrupted không vào `iterations`. |
| `runner.go:885-899`, `runner.go:977-998` | `iteration_duration` sample được emit trước sleep bù `minIterationDuration`. | Capacity phải dùng `t_i = max(iteration_duration_i, minIterationDuration)` nếu có min. |
| `per_vu_iterations.go`, `shared_iterations.go`, arrival-rate files | Các executor kia có push `DroppedIterations`; `constant_vus.go` không có. | Với `constant-vus`, hết thời gian thường là stop-new-iterations/interrupted, không phải dropped. |
| `constant_vus.go:135-150` | Progress bar tính `%` theo `spent / duration`, sau `duration` thì giữ 100%. | Progress regular phase không có nghĩa gracefulStop đã xong. |

### 3.10. Thêm nhầm field của executor khác có lỗi không?

Có. Với `options.scenarios` explicit, k6 parse config bằng `StrictJSONUnmarshal()` và bật
`DisallowUnknownFields()`. Nghĩa là field không thuộc struct config của executor sẽ lỗi ngay khi load script,
không bị bỏ qua âm thầm.

Core liên quan:

```text
lib/helpers.go
  StrictJSONUnmarshal() -> dec.DisallowUnknownFields()

constant_vus.go
  ConstantVUsConfig: vus, duration

per_vu_iterations.go
  PerVUIterationsConfig: vus, iterations, maxDuration

shared_iterations.go
  SharedIterationsConfig: vus, iterations, maxDuration
```

Bảng nhớ nhanh:

| Executor | Field đúng riêng của executor | Field dễ thêm nhầm | Kết quả |
| --- | --- | --- | --- |
| `constant-vus` | `vus`, `duration` | `iterations` | lỗi `json: unknown field "iterations"` |
| `constant-vus` | `vus`, `duration` | `maxDuration` | lỗi `json: unknown field "maxDuration"` |
| `per-vu-iterations` | `vus`, `iterations`, `maxDuration` | `duration` | lỗi `json: unknown field "duration"` |
| `shared-iterations` | `vus`, `iterations`, `maxDuration` | `duration` | lỗi `json: unknown field "duration"` |

Ví dụ sai:

```js
export const options = {
  scenarios: {
    c: {
      executor: "constant-vus",
      vus: 3,
      duration: "10s",
      iterations: 5,
    },
  },
};
```

Kết quả chạy thật:

```text
json: unknown field "iterations"
```

Với `constant-vus`, nếu muốn chạy 3 VUs trong 10s thì chỉ viết:

```js
export const options = {
  scenarios: {
    c: {
      executor: "constant-vus",
      vus: 3,
      duration: "10s",
    },
  },
};
```

Nếu muốn tổng iteration hoặc iteration mỗi VU thì đổi executor:

```js
// Mỗi VU chạy 5 vòng
export const options = {
  scenarios: {
    p: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 5,
      maxDuration: "10s",
    },
  },
};

// 3 VU chia nhau tổng 9 vòng
export const options = {
  scenarios: {
    s: {
      executor: "shared-iterations",
      vus: 3,
      iterations: 9,
      maxDuration: "10s",
    },
  },
};
```

Lưu ý riêng về **shortcut top-level**:

```js
export const options = {
  vus: 3,
  iterations: 5,
  duration: "10s",
};
```

không giống explicit scenario ở trên. Shortcut này được derive thành:

```text
shared-iterations
vus = 3
iterations = 5
maxDuration = 10s
```

vì trong `DeriveScenariosFromShortcuts()`, nhánh `iterations` được xử lý trước nhánh `duration`.
Do đó:

```text
explicit scenario:
  field sai -> lỗi unknown field

top-level shortcut:
  iterations + duration -> shared-iterations, duration thành maxDuration
```

## 3.11. Vì sao không có ramp trong `constant-vus`

`constant-vus` không có concept "stage" hay "ramp". Khi bạn khai báo:

```js
{
  executor: "constant-vus",
  vus: 4,
  duration: "10s",
}
```

`constant-vus` hiểu là:

```text
N VU active liên tục từ t=0 tới t=duration
không có giai đoạn warm-up
không có giai đoạn cool-down
không có thay đổi concurrency
```

### 3.11.1. Đọc từ core: chỉ có 2 step

`GetExecutionRequirements()` (`constant_vus.go:87-98`):

```go
return []lib.ExecutionStep{
    {TimeOffset: 0, PlannedVUs: uint64(clvc.GetVUs(et))},
    {TimeOffset: clvc.Duration.TimeDuration() + clvc.GracefulStop.TimeDuration(), PlannedVUs: 0},
}
```

Đây là 1 trong những execution plan đơn giản nhất trong toàn bộ k6:

```text
step 0: t=0,                  plannedVUs = vus
step 1: t=duration+grace,    plannedVUs = 0
```

Không có step ramp up, không có step ramp down. Số VU "nhảy" từ 0 lên `vus`
ngay tại `t=0`, rồi giữ nguyên đến `t=duration`, rồi `t=duration+gracefulStop`
mới về 0.

So sánh với `ramping-vus` (cùng config kích thước):

```js
// ramping-vus tương đương về tổng số VU đỉnh
{
  executor: "ramping-vus",
  startVUs: 0,
  stages: [
    { duration: "0s", target: 4 },   // jump 0 -> 4 ngay
    { duration: "10s", target: 4 },  // hold 4 VU
  ],
}
```

`ramping-vus` ở config trên có timeline phẳng tương tự constant-vus, nhưng vẫn
là `ramping-vus` (có vuHandle, có state machine, có gracefulSteps). Nói chung,
nếu shape là "N VU phẳng suốt X giây", `constant-vus` là cách gọn nhất.

### 3.11.2. Khi nào bạn KHÔNG nên ép constant-vus thành "ramping"

Nếu thấy mình đang viết:

```js
// hold 4 VU trong 10s
{
  executor: "constant-vus",
  vus: 4,
  duration: "10s",
}

// rồi trong code dùng global state để "fake ramp"
let activeFlag = false;
export default function () {
  if (Date.now() - startedAt < 5000 && __VU > 2) {
    return;  // VU 3, 4 không làm gì trong 5s đầu
  }
  // ...
}
```

Thì đây là dấu hiệu sai executor. `constant-vus` không phù hợp khi muốn thay đổi
concurrency. Đổi sang `ramping-vus`:

```js
{
  executor: "ramping-vus",
  startVUs: 2,
  stages: [
    { duration: "5s", target: 2 },  // hold 2 VU
    { duration: "0s", target: 4 },  // jump lên 4
    { duration: "5s", target: 4 },  // hold 4 VU
  ],
}
```

Tổng quát:

```text
muốn fixed N VU             -> constant-vus
muốn N VU thay đổi theo time -> ramping-vus
muốn fixed iter rate         -> constant-arrival-rate
muốn iter rate thay đổi      -> ramping-arrival-rate
muốn quota iter mỗi VU       -> per-vu-iterations
muốn quota tổng iter         -> shared-iterations
```

## 3.12. VU activate xong start iteration ngay, không đợi VU khác

Câu hỏi: với `vus = 4`, `duration = 10s`, 4 VU đó start iteration đồng loạt
hay tuần tự?

Trả lời ngắn:

```text
4 VU start iteration song song NGAY tại t=0
không VU nào đợi VU khác
mỗi VU một dòng đời độc lập (đặc trưng của closed model)
```

### 3.12.1. Đọc từ core

`Run()` (`constant_vus.go:195-203`):

```go
for range numVUs {
    initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)
    if err != nil {
        cancel()
        return err
    }
    activeVUs.Add(1)
    go handleVU(initVU)
}
```

Vòng `for range numVUs` chạy đồng bộ trong goroutine của `Run()`, nhưng mỗi
iteration chỉ:

1. `GetPlannedVU()` — lấy 1 instance từ pool (đã init sẵn) — O(1).
2. `go handleVU(initVU)` — fire-and-forget goroutine cho VU đó.

Cả 2 thao tác này gần như tức thì. Khoảng cách thời gian giữa VU 1 và VU N
chỉ vài microsecond cho channel signal + goroutine scheduling.

`handleVU` (`constant_vus.go:178-193`) làm:

```go
handleVU := func(initVU lib.InitializedVU) {
    ctx, cancel := context.WithCancel(maxDurationCtx)
    defer cancel()

    activeVU := initVU.Activate(
        getVUActivationParams(ctx, clv.config.BaseConfig, returnVU, clv.nextIterationCounters))

    for {
        select {
        case <-regDurationDone:
            return // don't make more iterations
        default: // continue looping
        }
        runIteration(maxDurationCtx, activeVU)
    }
}
```

Sau khi `Activate()` xong, VU vào ngay `for { ... runIteration(...) }`.
Không có rendez-vous nào cho VU khác, không có barrier sync.

### 3.12.2. Khác gì với `ramping-vus`?

`ramping-vus` dùng `vuHandle` với state machine (`vu_handle.go:14-22`):

```go
const (
    stopped stateType = iota
    starting
    running
    toGracefulStop
    toHardStop
)
```

VU `ramping-vus` chỉ chạy iteration sau khi `start()` chuyển state qua
`starting` rồi `running` theo timeline `rawSteps`.

`constant-vus` đơn giản hơn: không có `vuHandle`, không có state machine.
Goroutine `handleVU` chạy thẳng từ `Activate()` vào `runIteration()`, không
qua trung gian.

Khác biệt cụ thể:

```text
ramping-vus:
  init phase: tạo maxVUs vuHandle ở state stopped
  runtime:    timeline gọi vuHandle.start() -> chuyển state -> goroutine runLoopsIfPossible
              chờ canStartIter, mới vào runIter

constant-vus:
  init phase: chỉ init VU instance vào pool
  runtime:    Run() lấy đúng numVUs ra khỏi pool, mỗi VU 1 goroutine, vào loop ngay
```

Vì không qua state machine, `constant-vus` có overhead thấp hơn `ramping-vus`
ở mặt activation.

### 3.12.3. Verify từ log thật

Demo `constant_vus_loop_demo.js` (`vus=2`, `duration=3s`, `sleep(0.7)`),
log từ summary:

```text
t=0.0s  VU1 iter 0 start, VU2 iter 0 start
t=0.7s  VU1 iter 1 start, VU2 iter 1 start
t=1.4s  VU1 iter 2 start, VU2 iter 2 start
```

VU 1 và VU 2 đều có `__ITER=0` cùng tại `t=0`. Hoàn toàn song song. Nếu phải
"đợi đủ N VU rồi mới đồng loạt start" hoặc "VU 2 đợi VU 1 xong iter#0 mới start"
thì pattern log sẽ khác — không phải vậy.

### 3.12.4. Throughput từ giây đầu tiên

Vì VU không đợi nhau:

```text
peak_iteration_rate (từ t=0) ~= vus / effective_iteration_time
```

Iteration được sinh đều ngay từ giây đầu, không có giai đoạn warm-up
"throughput tăng dần". Đây là điểm khác `ramping-vus`:

```text
ramping-vus với startVUs=1, ramp 1->4 trong 4s:
  t=0s  rate ~= 1/iter_time
  t=1s  rate ~= 2/iter_time
  t=2s  rate ~= 3/iter_time
  t=3s  rate ~= 4/iter_time
  -> rate tăng dần

constant-vus với vus=4:
  t=0s  rate ~= 4/iter_time
  t=1s  rate ~= 4/iter_time
  t=10s rate ~= 4/iter_time
  -> rate phẳng
```

### 3.12.5. Điểm dễ nhầm

```text
SAI : "constant-vus warm-up từ 0 lên N rồi mới start"
ĐÚNG: "constant-vus pin N VU active ngay từ t=0"

SAI : "iteration đồng bộ giữa các VU"
ĐÚNG: "mỗi VU loop riêng, __ITER mỗi VU đếm độc lập"

SAI : "phải đợi VU 1 xong rồi VU 2 mới chạy"
ĐÚNG: "N VU chạy song song, độc lập"
```

## 3.13. Bước nhảy của iteration trong 1 VU

Câu hỏi: trong 1 VU, iteration kế tiếp bắt đầu khi nào?

Trả lời ngắn:

```text
iter#(k+1) bắt đầu ngay khi iter#k kết thúc
khoảng cách giữa 2 iteration kế tiếp = effective_iteration_time
                                     = max(JS_function_time, minIterationDuration)
```

### 3.13.1. Đọc từ core

`handleVU` (`constant_vus.go:185-192`):

```go
for {
    select {
    case <-regDurationDone:
        return // don't make more iterations
    default: // continue looping
    }
    runIteration(maxDurationCtx, activeVU)
}
```

Vòng `for` không có `sleep`, không có `time.Sleep`. Sau khi `runIteration()`
trả về, vòng lặp check `regDurationDone` (1 channel select) rồi vào `runIteration()`
tiếp. Khoảng nghỉ giữa 2 iteration thực tế = chi phí channel select + 1 hàm
gọi, gần như 0.

Cho nên thời gian giữa start của iter#k và iter#(k+1) chính là thời gian
`runIteration()` mất, mà cái đó chính là `effective_iteration_time`.

### 3.13.2. Công thức

Trong 1 VU:

```text
t_start[k] = thời điểm bắt đầu iter#k
t_start[k+1] = t_start[k] + t[k]

trong đó:
  t[k] = thời gian chiếm VU của iter#k
       = max(JS_function_time[k], minIterationDuration)
```

Nếu các iteration đều nhau (`t[k] = t` cho mọi k):

```text
iteration_count_per_vu = floor(duration / t) hoặc ceil(duration / t)
                       (xem 3.2 và đặc biệt 3.13.3)
per_vu_rate = 1 / t
```

### 3.13.3. Vì sao `ceil` không phải `floor`?

Vì VU có thể start iteration cuối ngay trước khi `duration` hết, rồi finish
trong `gracefulStop`:

```text
duration = 3s, t = 0.7s

iter starts in 1 VU:
  iter#0: t=0.0s, end=0.7s
  iter#1: t=0.7s, end=1.4s
  iter#2: t=1.4s, end=2.1s
  iter#3: t=2.1s, end=2.8s
  iter#4: t=2.8s, end=3.5s   <- start trước duration=3s, finish trong grace

iter started before duration: 5 = ceil(3 / 0.7) = ceil(4.28)
iter would finish strictly within duration: 4 = floor(3 / 0.7)
```

Cho nên `ceil(D / t)` đúng khi `gracefulStop` đủ dài để iteration cuối finish.

### 3.13.4. Verify từ demo

Demo `constant_vus_loop_demo.js`:

```text
vus = 2
duration = 3s
gracefulStop = 2s
sleep mỗi iter = 0.7s
```

Log:

```text
t=0.0s  VU1 iter 0 start, VU2 iter 0 start
t=0.7s  VU1 iter 1 start, VU2 iter 1 start
t=1.4s  VU1 iter 2 start, VU2 iter 2 start
t=2.1s  VU1 iter 3 start, VU2 iter 3 start
t=2.8s  VU1 iter 4 start, VU2 iter 4 start
t=3.5s  iter 4 finish trong gracefulStop
```

Khoảng cách giữa các start trong 1 VU đều đúng `0.7s`:

```text
iter#0 -> iter#1: 0.7s
iter#1 -> iter#2: 0.7s
iter#2 -> iter#3: 0.7s
iter#3 -> iter#4: 0.7s
```

Tổng iteration trong 1 VU: 5 = `ceil(3 / 0.7) = ceil(4.28) = 5`.
Tổng cả 2 VU: 10. Khớp summary `iterations: 10`.

### 3.13.5. Tác động của `minIterationDuration`

Nếu code:

```js
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    c: { executor: "constant-vus", vus: 2, duration: "10s" },
  },
};

export default function () {
  // function chạy 0.5s
  http.get("https://example.com");  // ~250ms
  sleep(0.25);
}
```

thì:

```text
JS function time = 0.5s
minIterationDuration = 2s
effective_iteration_time = max(0.5, 2.0) = 2.0s

iteration count per VU = ceil(10 / 2) = 5
iterations_per_vu = 5
total = 2 * 5 = 10
```

Lưu ý: `iteration_duration` summary metric vẫn báo `~0.5s` (chỉ tính JS function).
Phần sleep bù 1.5s không nằm trong metric, nhưng vẫn chiếm VU. Cho nên capacity
sizing phải dùng `effective_iteration_time = 2s`, không phải `iteration_duration = 0.5s`.

## 3.14. `gracefulStop` chi tiết với hai trục độc lập

`constant-vus` không có `gracefulRampDown` (vì không có ramp), chỉ có
`gracefulStop` áp ở cuối scenario.

Tóm tắt 1 dòng:

```text
gracefulStop : "khi duration hết, iteration đang chạy được phép tiếp tục
                thêm tối đa N giây trước khi bị cancel"
```

Default value:

```text
gracefulStop = 30s (lấy từ BaseConfig)
```

Đọc từ `base_config.go:40-46`. Là `null.Duration`, có thể set 0s
(no grace, hard-stop ngay) hoặc tăng lên tùy ý.

### 3.14.1. Trước khi đọc tiếp: hai trục độc lập

Khi đọc các timeline ví dụ bên dưới, phải tách rõ 2 trục thời gian khác nhau:

```text
Trục 1 — SCENARIO timeline (do CONFIG quyết định):
  duration kéo dài liên tục từ t=0 tới t=D
  gracefulStop kéo từ t=D tới t=D+G
  sau t=D+G mọi iteration đều bị hard-stop

Trục 2 — VU iteration timeline (do CODE quyết định):
  iter_duration = thời gian default function chạy xong (sleep, http, ...)
  với sleep(0.7): iter#0 = t=0..0.7, iter#1 = t=0.7..1.4, ...

iter#N của VU = iteration thứ N của VU đó (counter __ITER riêng từng VU)
iter#0 = iteration đầu tiên ngay khi VU activate
```

Hai trục **không đồng bộ** với nhau:

```text
- VU finish iter#k ở t=k*0.7 -> KHÔNG phải scenario hết
  (duration vẫn đang chạy, mới hết k*0.7/D)
  VU chỉ đơn giản vào iter#(k+1) ngay lập tức

- duration hết ở t=D -> KHÔNG cắt iter đang chạy
  (lúc này VU có thể đang ở giữa iter#k, mới chạy 1 phần)
  VU tiếp tục iter#k cho tới khi xong, hoặc grace hết

- duration chỉ điều khiển "có start iter mới được không"
  không can thiệp vào iter đang chạy của VU
```

Hình dung 2 trục song song (`vus=2, duration=3s, sleep(0.7)`):

```text
trục scenario : [-- regular duration (3s) --|-- grace (2s) --]
                0                            3                5

trục VU=1     : [iter#0|iter#1|iter#2|iter#3|iter#4|]
                0      0.7    1.4    2.1    2.8    3.5

trục VU=2     : [iter#0|iter#1|iter#2|iter#3|iter#4|]
                0      0.7    1.4    2.1    2.8    3.5
```

### 3.14.2. Đọc từ core

`Run()` (`constant_vus.go:131`):

```go
startTime, maxDurationCtx, regDurationCtx, cancel := getDurationContexts(parentCtx, duration, gracefulStop)
```

`getDurationContexts()` (`helpers.go:141-153`):

```go
startTime = time.Now()
maxEndTime := startTime.Add(regularDuration + gracefulStop)

maxDurationCtx, maxDurationCancel = context.WithDeadline(parentCtx, maxEndTime)
if gracefulStop == 0 {
    return startTime, maxDurationCtx, maxDurationCtx, maxDurationCancel
}
regDurationCtx, _ = context.WithDeadline(maxDurationCtx, startTime.Add(regularDuration))
return startTime, maxDurationCtx, regDurationCtx, maxDurationCancel
```

Hai context được tạo:

```text
regDurationCtx : deadline = startTime + duration
                 -> dùng làm trigger "không start iter mới"
maxDurationCtx : deadline = startTime + duration + gracefulStop
                 -> dùng làm trigger "cancel iter đang chạy"
```

Trong `handleVU` (`constant_vus.go:185-192`):

```go
for {
    select {
    case <-regDurationDone:
        return // don't make more iterations
    default: // continue looping
    }
    runIteration(maxDurationCtx, activeVU)
}
```

Logic:

```text
1) Trước mỗi vòng for, check regDurationDone (= regDurationCtx.Done())
   - đóng -> return, kết thúc goroutine (VU không start iter mới)
   - chưa đóng -> vào runIteration

2) runIteration(maxDurationCtx, activeVU) chạy iter
   - activeVU đã được Activate với context = maxDurationCtx (qua handleVU)
   - khi maxDurationCtx hết deadline (= start + duration + grace),
     context bị cancel, iter bị interrupt
```

Cho nên:

```text
t = duration         : VU không start iter mới (regDurationCtx done)
t = duration + grace : iter đang chạy bị cancel (maxDurationCtx done)
```

### 3.14.3. Ví dụ đầy đủ

Config:

```js
scenarios: {
  demo_grace: {
    executor: "constant-vus",
    vus: 2,
    duration: "5s",
    gracefulStop: "3s",
  },
},

// code: mỗi iter sleep 4s
export default function () { sleep(4); }
```

Tách 2 trục:

```text
Trục scenario:
  regular phase: t=0..5s
  grace phase:   t=5..8s
  hard end:      t=8s

Trục VU iter (sleep 4s):
  iter#0 = t=0..4s
  iter#1 = t=4..8s (nếu được start)
  iter#2 = t=8..12s (nếu được start)
```

Timeline đầy đủ:

```text
t=0.0s   2 VU activate (đồng loạt từ t=0, không ramp)
         VU=1, VU=2 vào iter#0 (sẽ đến t=4.0s)

t=4.0s   VU=1, VU=2 finish iter#0
         check regDurationDone -> CHƯA đóng (5s mới đóng)
         lập tức vào iter#1 (sẽ đến t=8.0s nếu không bị cắt)

t=5.0s   regDurationDone đóng -> regular phase hết
         progress bar 100%
         VU đang ở giữa iter#1 (đã chạy 1s, còn 3s)
         -> tiếp tục chạy, vì context iter chưa cancel
         vào pha grace: gracefulStop = 3s
         maxDurationCtx deadline = 5+3 = 8s

t=8.0s   maxDurationCtx hết deadline (đúng lúc iter#1 vừa xong, race)
         3 case xảy ra tùy timing:
         a) iter#1 finish trước cancel -> AddFullIterations(1), clean
         b) cancel trước finish        -> AddInterruptedIterations(1)
         c) đúng lúc trùng             -> tùy race condition

t=8.0s+  goroutine handleVU return
         ReturnVU đã được gọi qua deactivateCallback
         scenario thật sự kết thúc
```

Header in:

```text
* demo_grace: 2 looping VUs for 5s (gracefulStop: 3s)
8s max duration (incl. graceful stop)
```

### 3.14.4. Biến thể 1: iter_duration ngắn hơn duration

Code `sleep(0.7)`, `duration=3s`, `gracefulStop=2s` (giống demo loop):

```text
trục VU: iter#0=0..0.7, iter#1=0.7..1.4, ..., iter#4=2.8..3.5

t=2.8s   VU vào iter#4 (chưa hết duration)
         check regDurationDone -> CHƯA đóng (3s mới đóng)
         lập tức vào iter#4

t=3.0s   regDurationDone đóng
         VU đang ở iter#4 (đã 0.2s, còn 0.5s)
         tiếp tục iter#4 trong grace

t=3.5s   iter#4 finish (0.5s qua < grace 2s, finish clean)
         goroutine return
         tổng: 5 iter/VU * 2 VU = 10 complete, 0 interrupted
```

Đây là case bình thường, không có interrupted iteration.

### 3.14.5. Biến thể 2: iter_duration dài hơn grace

Code `sleep(10)`, `duration=3s`, `gracefulStop=1s`:

```text
trục VU: iter#0 = t=0..10s

t=0.0s   VU vào iter#0 (sẽ đến t=10s nếu không bị cắt)
t=3.0s   regDurationDone đóng
         VU đang ở iter#0 (đã 3s, còn 7s)
         tiếp tục iter#0 trong grace
t=4.0s   maxDurationCtx hết deadline (3+1=4s)
         VU vẫn còn 6s iter chưa xong
         -> hard cancel context iter
         -> AddInterruptedIterations(1)
         tổng: 0 complete, 1 interrupted (per VU)
```

Đây chính là case demo `constant_vus_interrupt_demo.js`.

### 3.14.6. Biến thể 3: `gracefulStop = 0s`

Code `sleep(2)`, `duration=3s`, `gracefulStop=0s`:

```text
trục VU: iter#0=0..2, iter#1=2..4

t=2.0s   VU finish iter#0, vào iter#1 (sẽ đến t=4s)
t=3.0s   duration hết, gracefulStop=0s
         -> regDurationCtx và maxDurationCtx có cùng deadline
         -> cả 2 cùng done tại t=3s
         -> VU đang ở iter#1 (đã 1s, còn 1s)
         -> hard cancel ngay, không có grace
         -> AddInterruptedIterations(1)
         tổng: 1 complete, 1 interrupted (per VU)
```

Đọc từ `helpers.go:148-150`:

```go
if gracefulStop == 0 {
    return startTime, maxDurationCtx, maxDurationCtx, maxDurationCancel
}
```

Khi `gracefulStop = 0s`, `regDurationCtx` và `maxDurationCtx` là **cùng 1 context**.
Cả 2 timeline trùng nhau, không có pha grace.

## 3.15. Lifecycle VU sau khi hết duration

Câu hỏi: hết `duration`, VU đi đâu? Có bị destroy không? `__ITER` có reset không?

Trả lời ngắn:

```text
VU sau khi hết duration -> ReturnVU() về pool
KHÔNG bị destroy
__ITER counter tiếp tục tăng monotonic, KHÔNG reset
nhưng vì không có scenario sau dùng VU này nữa, __ITER coi như "đóng băng"
```

### 3.15.1. Đọc từ core

`Run()` (`constant_vus.go:173-176`):

```go
returnVU := func(u lib.InitializedVU) {
    clv.executionState.ReturnVU(u, true)
    activeVUs.Done()
}
```

`returnVU` được truyền vào `getVUActivationParams()` làm `DeactivateCallback`.
Khi VU goroutine kết thúc (qua `defer cancel()` trong `handleVU`), context cancel
gây `RunOnce()` trả về, sau đó VU framework gọi `DeactivateCallback` =
`returnVU`.

`returnVU` làm 2 việc:

```text
1) ExecutionState.ReturnVU(u, true)
   - đẩy VU instance về pool
   - giảm active VU counter (metric `vus`)
   - VU instance KHÔNG bị destroy

2) activeVUs.Done()
   - counter sync.WaitGroup giảm 1
   - khi tất cả VU done, Run() return
```

Xem `execution.go:462-481, 544-550`:

```text
GetPlannedVU(..., true): tăng activeVU count
ReturnVU(..., true)    : giảm activeVU count, đẩy instance về pool
```

VU instance ở trong pool có thể được tái sử dụng nếu có scenario sau cần. Trong
`constant-vus`, vì chỉ có 1 scenario (đa số case), VU không được dùng lại. Test
process kết thúc, JS runtime cleanup.

### 3.15.2. `__ITER` qua các iteration

Trong 1 VU, `__ITER` (= `iterationInScenario`) tăng monotonic theo mỗi
iteration thành công:

```text
iter#0: __ITER = 0
iter#1: __ITER = 1
iter#2: __ITER = 2
...
```

Counter này không reset khi:

- VU finish iter rồi vào iter mới (cùng VU, cùng scenario)
- iter bị interrupt rồi VU vào iter mới (nếu iter#k bị interrupt, iter#(k+1)
  vẫn `__ITER = k+1`)

Counter này do `nextIterationCounters` (`constant_vus.go:183`) cấp:

```go
activeVU := initVU.Activate(
    getVUActivationParams(ctx, clv.config.BaseConfig, returnVU, clv.nextIterationCounters))
```

`clv.nextIterationCounters` là method trên `BaseExecutor` (chung cho mọi
executor), không reset trong scope `constant-vus`.

### 3.15.3. So sánh với `ramping-vus`

Khác biệt rõ với `ramping-vus`:

```text
ramping-vus với VU bị scale-down rồi scale-up lại:
  stage 1: VU=4 chạy iter#0, iter#1
  stage 2: VU=4 bị gracefulStop -> ReturnVU
  stage 3: VU=4 (hoặc instance khác từ pool) start lại
            __ITER tiếp tục từ chỗ cũ (= 2)

constant-vus:
  VU không bị scale-down giữa duration
  __ITER chỉ "đóng băng" khi duration hết
  không có chuyện activate-deactivate-activate
```

Hệ quả thực tế:

```text
- ramping-vus có thể có cùng 1 VU instance chạy trên nhiều stage,
  __ITER có thể nhảy bậc qua các lần activate
- constant-vus mỗi VU 1 dòng đời thẳng, __ITER tăng đều từ 0..K rồi dừng
```

### 3.15.4. Pool VU trong test multi-scenario

Nếu có nhiều scenario chạy cùng test (qua `options.scenarios`):

```text
- mỗi scenario có thể "claim" VU pool riêng tùy executor
- ExecutionState pool là shared
- 1 VU instance có thể được dùng bởi nhiều scenario nối tiếp nhau
- exec.scenario.name giúp code phân biệt đang chạy scenario nào
```

Với `constant-vus`, k6 dùng `GetPlannedVU(..., true)` ở `Run()` đầu mới activate
VU. Nếu scenario `constant-vus` chạy sau 1 scenario khác đã ReturnVU, VU
instance được tái sử dụng — JS context có sẵn, không init lại.

`exec.vu.idInTest` (= `__VU`) pin với 1 instance, không đổi qua các lần activate.
Còn `__ITER` (= `iterationInScenario`) reset về 0 khi vào scenario mới, vì
nó scope theo scenario.

## 3.16. Vì sao `constant-vus` spawn đủ VU ngay tại t=0?

Câu hỏi quan trọng để hiểu rõ khác biệt với `ramping-vus`:

```text
ramping-vus với startVUs=0, target=4 trong 4s thì rải đều 1 VU/s
sao constant-vus với vus=4 không rải, mà spawn cả 4 ngay tại t=0?
```

Trả lời ngắn:

```text
constant-vus = "fixed VUs over time"
mục đích: giữ N VU active CỐ ĐỊNH trong toàn bộ duration
nếu rải dần thì sẽ là ramp, không phải constant
```

### 3.16.1. Đọc từ core: chỉ có 1 step ở t=0

`GetExecutionRequirements()` (`constant_vus.go:87-98`) trả về đúng 2 step:

```go
return []lib.ExecutionStep{
    {TimeOffset: 0, PlannedVUs: uint64(clvc.GetVUs(et))},
    {TimeOffset: clvc.Duration.TimeDuration() + clvc.GracefulStop.TimeDuration(), PlannedVUs: 0},
}
```

Step đầu tại `t=0` đã là `PlannedVUs = vus`. Không có cơ chế nào để rải VU
giữa `t=0` và `t=duration`.

`Run()` (`constant_vus.go:195-203`) dùng vòng `for range numVUs` để spawn
goroutine, vòng này chạy trong block goroutine của `Run()`, hoàn tất gần như
tức thì:

```go
for range numVUs {
    initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)
    if err != nil {
        cancel()
        return err
    }
    activeVUs.Add(1)
    go handleVU(initVU)
}
```

So với `ramping-vus.scheduledVUsHandlerStrategy()` chờ timeOffset của từng
step rồi mới `start()` từng VU theo timeline, `constant-vus` không có vòng
chờ nào — tất cả N VU đều được spawn liên tiếp ngay tại `t=0`.

### 3.16.2. Khác biệt nghiệp vụ với `ramping-vus`

`ramping-vus` rải VU theo timeline để **mô phỏng concurrency tăng dần**:

```text
ramping 0 -> 100 trong 10s
=> tại t=5s, hệ thống chịu khoảng 50 user
=> tại t=10s, đạt 100 user
=> mô phỏng đúng quá trình tăng dần
```

`constant-vus` không có concept "tăng dần". Mục đích là:

```text
N user ảo hoạt động liên tục trong X giây
=> tại MỌI thời điểm trong [0, duration), số user = N
=> không có giai đoạn warm-up
```

Cho nên hành vi đúng là spawn cả N VU ngay tại `t=0`. Nếu muốn warm-up, dùng
executor khác (`ramping-vus`).

### 3.16.3. Có race condition không?

Câu hỏi: vòng `for range numVUs` vẫn cần thời gian (dù rất ngắn). Có rủi ro
VU 1 chạy iter#0 trong khi VU N còn chưa được activate?

Trả lời: trên lý thuyết có. Trong thực tế:

```text
- vòng for chạy trên main goroutine của Run(), không yield
- mỗi vòng làm 2 việc: GetPlannedVU (O(1)) + go handleVU (fire-and-forget)
- chi phí < 1ms cho hàng trăm VU

- VU goroutine bắt đầu execution tùy Go scheduler
- với GOMAXPROCS > 1, nhiều VU chạy thật sự song song
- với 1 CPU, các VU goroutine xen kẽ nhau theo Go scheduler
```

Trong demo `constant_vus_loop_demo.js` (`vus=2`):

```text
t=0.0s  VU1 iter 0 start, VU2 iter 0 start
```

Cả 2 VU đều được log với `t=0.0s` (precision của log là 0.1s, đủ để 2 VU
"khớp" tại t=0). Nếu zoom vào microsecond, có thể VU 1 start trước VU 2 vài
microsecond, nhưng không có ý nghĩa với load test.

Với `vus = 1000`:

```text
spawn time = 1000 * (~10us per goroutine) = ~10ms
tức là VU 1000 vào iter#0 chậm hơn VU 1 khoảng 10ms
```

Nếu `iteration_duration` ~ 1s thì 10ms là 1% — không đáng kể. Nếu iteration
quá ngắn (< 100ms) thì 10ms có thể thấy được, nhưng đó là dấu hiệu bạn cần
dùng `*-arrival-rate` thay vì `*-vus`.

### 3.16.4. So sánh trực tiếp constant-vus vs ramping-vus

| Khía cạnh | `constant-vus` | `ramping-vus` |
| --- | --- | --- |
| VU spawn tại t=0 | đủ N | chỉ `startVUs` (có thể = 0) |
| Số VU active theo thời gian | constant N | thay đổi theo stages |
| Có timeline phức tạp không | không, chỉ 2 step | có rawSteps + gracefulSteps |
| Có vuHandle state machine | không | có |
| Có gracefulRampDown | không | có |
| Init phase init bao nhiêu VU | đúng `vus` | đúng `maxVUs` (= max planned) |
| Mục đích | giữ tải đều | mô phỏng tải biến đổi |

### 3.16.5. Thử thay constant-vus bằng ramping-vus

Nếu bạn muốn shape "N VU phẳng X giây" mà cứ phải dùng `ramping-vus`:

```js
// constant-vus form (gọn nhất)
{
  executor: "constant-vus",
  vus: 4,
  duration: "10s",
}

// ramping-vus form tương đương (verbose hơn)
{
  executor: "ramping-vus",
  startVUs: 4,
  stages: [
    { duration: "10s", target: 4 },
  ],
}
```

Behavior:

```text
- cả 2 đều spawn 4 VU ngay tại t=0 (ramping-vus với startVUs=4 cũng vậy)
- cả 2 đều giữ 4 VU active trong 10s
- cả 2 đều có gracefulStop ở cuối

khác biệt nhỏ:
- constant-vus đơn giản hơn (không có vuHandle overhead)
- ramping-vus reserve gracefulRampDown cho stage cuối nếu có ramp-down
- header in khác: "Up to 4 looping VUs ..." vs "4 looping VUs ..."
```

Nếu shape là "N VU phẳng", `constant-vus` là form gọn nhất và rõ ràng nhất.
Dùng `ramping-vus` chỉ khi shape thay đổi theo timeline.

### 3.16.6. Kết luận

```text
constant-vus spawn đủ N VU ngay tại t=0
   = ý nghĩa nghiệp vụ "fixed users over time"

ramping-vus rải VU theo step_interval = stageDuration / |target - fromVUs|
   = ý nghĩa nghiệp vụ "variable users over time"

cả 2 đều là closed model
cả 2 đều pre-init VU ở init phase, không có unplanned VUs
khác biệt ở chỗ "khi nào activate" — constant: ngay; ramping: theo timeline
```

## 4. Demo loop theo duration

Command:

```powershell
rtk k6 run .\examples\constant_vus_loop_demo.js
```

Config:

```text
executor = constant-vus
vus = 2
duration = 3s
gracefulStop = 2s
sleep trong mỗi iteration = 0.7s
```

Output chính đã chạy:

```text
scenarios:
  * constant_loop: 2 looping VUs for 3s (gracefulStop: 2s)

iteration_duration...: avg=703.15ms min=700.22ms med=701.23ms max=716.87ms p(90)=705.53ms p(95)=711.2ms
iterations...........: 10  2.828882/s
vus..................: 2   min=2      max=2
vus_max..............: 2   min=2      max=2

running (3.5s), 0/2 VUs, 10 complete and 0 interrupted iterations
```

Timeline từ log:

```text
t=0.0s  VU1 iter 0 start, VU2 iter 0 start
t=0.7s  VU1 iter 1 start, VU2 iter 1 start
t=1.4s  VU1 iter 2 start, VU2 iter 2 start
t=2.1s  VU1 iter 3 start, VU2 iter 3 start
t=2.8s  VU1 iter 4 start, VU2 iter 4 start
t=3.5s  iter 4 finish trong gracefulStop
```

Tính:

```text
V = 2
D = 3s
G = 2s
W ~= 0.70315s

executor_wall_time_after_start = D + G = 5s

iterations_per_vu_started_approx
  ~= ceil(D / W_effective)
  ~= ceil(3 / 0.70315)
  ~= ceil(4.27)
  = 5

completed_iterations_approx
  ~= V * 5
  = 2 * 5
  = 10
```

Khớp:

```text
iterations...........: 10
```

Rate:

```text
per_vu_rate ~= 1 / 0.70315 = 1.422 iter/s/VU
peak_iteration_rate ~= 2 / 0.70315 = 2.844 iter/s

summary_runtime_base ~= 10 / 2.828882 = 3.535s
average_iteration_rate = 10 / 3.535 = 2.828882 iter/s
```

## 5. Demo VU nhanh/chậm

File:

```text
examples/constant_vus_vu_speed_count_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_vus_vu_speed_count_demo.js
```

Nếu muốn lọc log trên PowerShell:

```powershell
rtk k6 run .\examples\constant_vus_vu_speed_count_demo.js 2>&1 | Select-String "vu-progress"
```

Config:

```text
executor = constant-vus
vus = 4
duration = 2s
gracefulStop = 2s

VU 1 sleep 0.2s
VU 2 sleep 0.4s
VU 3 sleep 0.8s
VU 4 sleep 0.8s
```

Output chính đã chạy:

```text
iteration_duration...: avg=419.49ms min=200.08ms med=400.15ms max=800.8ms p(90)=800.59ms p(95)=800.8ms
iterations...........: 21  8.744211/s
vus..................: 4   min=4      max=4
vus_max..............: 4   min=4      max=4

running (2.4s), 0/4 VUs, 21 complete and 0 interrupted iterations
```

Từ log:

```text
VU 1 chạy __ITER=0..9  => 10 iterations
VU 2 chạy __ITER=0..4  => 5 iterations
VU 3 chạy __ITER=0..2  => 3 iterations
VU 4 chạy __ITER=0..2  => 3 iterations
```

Tổng:

```text
10 + 5 + 3 + 3 = 21
```

Tự tính `iteration_duration.avg`:

```text
10 iterations * 0.2s = 2.0s
5 iterations  * 0.4s = 2.0s
3 iterations  * 0.8s = 2.4s
3 iterations  * 0.8s = 2.4s

total iteration duration samples = 8.8s

avg = 8.8 / 21
    = 0.419s
    = 419ms
```

Khớp:

```text
iteration_duration avg=419.49ms
```

Tốc độ lý thuyết khi cả 4 VU active:

```text
VU 1: 1 / 0.2 = 5.00 iter/s
VU 2: 1 / 0.4 = 2.50 iter/s
VU 3: 1 / 0.8 = 1.25 iter/s
VU 4: 1 / 0.8 = 1.25 iter/s

peak ~= 10 iter/s
```

Tốc độ trung bình summary:

```text
summary_runtime_base ~= 21 / 8.744211 = 2.402s
average_iteration_rate = 21 / 2.402 = 8.744211 iter/s
```

Vì run kéo dài tới `2.4s` để các iteration cuối finish trong gracefulStop, nên average rate thấp hơn peak lý thuyết trong regular phase.

Điểm quan trọng:

```text
constant-vus không chia quota iteration
VU nhanh tự chạy được nhiều iteration hơn
```

Nhưng khác `shared-iterations`:

```text
shared-iterations có tổng pool cố định
constant-vus không có pool tổng, chỉ loop tới hết duration
```

## 6. Demo interrupt và edge case

### 6.1. Demo interrupt cơ bản

File:

```text
examples/constant_vus_interrupt_demo.js
```

Command:

```powershell
rtk k6 run .\examples\constant_vus_interrupt_demo.js
```

Config:

```text
executor = constant-vus
vus = 1
duration = 3s
gracefulStop = 1s
iteration muốn chạy 10s
```

Output chính đã chạy:

```text
scenarios:
  * interrupted_constant_vus: 1 looping VUs for 3s (gracefulStop: 1s)

running (4.0s), 0/1 VUs, 0 complete and 1 interrupted iterations
```

Log:

```text
[iter-start] t=0.0s __VU=1 __ITER=0
[tick] t=0.0s i=0
[tick] t=1.0s i=1
[tick] t=2.0s i=2
[tick] t=3.0s i=3
No script iterations fully finished, consider making the test duration longer
```

Tính:

```text
D = 3s
G = 1s
executor_wall_time_after_start = 4s
iteration_time_wanted = 10s
```

Iteration đầu start lúc `0s`, nhưng tới `4s` chưa finish, nên bị interrupt.
Dòng `[iter-end]` không in ra vì code sau `sleep()` không chạy tiếp sau khi context bị cancel.

### 6.2. Edge case: `duration` rất ngắn so với `iter_duration`

Câu hỏi: nếu `duration` ngắn hơn `iter_duration`, điều gì xảy ra?

Phân tích theo 2 case:

#### 6.2.1. `iter_duration` < `duration + gracefulStop`

```text
duration = 1s
gracefulStop = 5s
iter_duration = 3s

trục scenario : [-- 1s regular --|------ 5s grace ------]
                0                 1                       6

trục VU iter  : [---- iter#0 (3s) ----|]
                0                      3
```

Timeline:

```text
t=0.0s   N VU activate, vào iter#0 (sẽ đến t=3s)
t=1.0s   regDurationCtx done -> không start iter mới
         VU đang ở iter#0 (đã 1s, còn 2s)
         tiếp tục iter#0 trong grace
t=3.0s   VU finish iter#0 (2s qua < grace 5s, finish clean)
         check regDurationDone -> đã đóng -> return
         goroutine end, ReturnVU
         tổng: 1 complete/VU, 0 interrupted
```

Vậy run sẽ có:

```text
completed_iterations = vus * 1
duration thật của test = ~iter_duration (3s)
```

Dù `duration = 1s`, test thật vẫn chạy `iter_duration = 3s` để iter#0 finish.
Header có thể nói `running (3.x s)` thay vì 1s.

#### 6.2.2. `iter_duration` > `duration + gracefulStop`

```text
duration = 1s
gracefulStop = 1s
iter_duration = 10s

trục scenario : [-- 1s regular --|-- 1s grace --]
                0                 1               2

trục VU iter  : [-------- iter#0 (10s) -----------------|]
                0                                        10
```

Timeline:

```text
t=0.0s   N VU activate, vào iter#0 (sẽ đến t=10s nếu không cắt)
t=1.0s   regDurationCtx done
t=2.0s   maxDurationCtx done
         VU đang ở iter#0 (đã 2s, còn 8s)
         -> hard cancel context
         -> AddInterruptedIterations(1)
         tổng: 0 complete/VU, 1 interrupted/VU
```

Vậy run sẽ có:

```text
completed_iterations = 0
interrupted_iterations = vus
warning: "No script iterations fully finished, consider making the test duration longer"
```

Đây chính là case demo `constant_vus_interrupt_demo.js`. Khi thấy 0 complete,
warning đó là dấu hiệu rõ.

#### 6.2.3. Nguyên tắc tránh

Khi tuning, đặt `duration` sao cho:

```text
duration >= 2-3 * effective_iteration_time
```

Để có ít nhất 2-3 iteration thành công per VU, đảm bảo statistic có ý nghĩa.
Nếu `effective_iteration_time` không biết trước, cứ:

```text
- chạy thử 1 lần với duration = 30s
- đọc iteration_duration.avg
- tính lại duration phù hợp cho run chính
```

### 6.3. Edge case: VU đột nhiên chậm trong lúc chạy

Câu hỏi: nếu giữa run, hệ thống bị backend chậm, network spike, hay GC pause,
một số VU có `iter_duration` đột ngột tăng. Điều gì xảy ra?

Phân tích:

#### 6.3.1. VU chậm vẫn pin (không bị scale-down)

`constant-vus` không có cơ chế scale-down giữa duration. Nếu VU chậm:

```text
- VU không bị thay thế bằng VU khác
- VU chậm tự xử lý iter dài hơn của nó
- iteration_duration.max của summary phản ánh lúc chậm nhất
- iteration_duration.avg bị kéo lên một chút
```

Cụ thể:

```text
config: vus=4, duration=30s, iter_duration bình thường = 1s
giả sử t=10..15s, backend chậm 5x -> iter mất 5s

trục VU=1 (giả sử VU=1 bị ảnh hưởng):
  iter#0..9 (t=0..10s): mỗi iter 1s
  iter#10 (t=10..15s): 5s do backend chậm
  iter#11..14 (t=15..30s): mỗi iter 1s

VU=1 tổng iter completed: 14
VU=2,3,4 nếu cũng bị: tương tự ~14
nếu chỉ VU=1 bị: VU=2,3,4 mỗi cái ~30 iter
```

Tổng iteration giảm so với run "đẹp" nhưng `constant-vus` vẫn pin 4 VU đến hết.

#### 6.3.2. VU chậm có làm `vus` metric thay đổi không?

Không. `vus` metric phản ánh số VU đang được active (counter của
`ExecutionState`), không phản ánh tốc độ. VU chậm vẫn được tính là active.

Trong run sạch:

```text
vus..................: N   min=N      max=N
```

VU chậm không làm `min < N`. Để `min < N` cần có VU bị ReturnVU sớm (test
abort, error code chết VU, iteration bị error trầm trọng).

#### 6.3.3. VU chậm ảnh hưởng iteration_rate

Vì `constant-vus` không có target rate, throughput thật phụ thuộc tốc độ
mỗi VU:

```text
average_iteration_rate = sum(iter_count_per_vu) / summary_runtime_base
```

Nếu VU=1 chậm 5x trong 5s:

```text
trong 5s đó, VU=1 chỉ làm 1 iter thay vì 5 iter
=> mất 4 iter của VU=1 trong 5s đó
=> total iter giảm 4
=> average_iteration_rate giảm tương ứng
```

Nếu là spike ngắn (~5s) trên test 30s, mức ảnh hưởng nhỏ. Nếu chậm cả run,
phải xem `iteration_duration.avg` để hiểu tốc độ thật.

#### 6.3.4. Khác biệt với `*-arrival-rate`

`constant-arrival-rate` xử lý chậm khác: nếu VU không kịp meet rate target,
k6 spawn unplanned VUs (tới `maxVUs`) hoặc emit `dropped_iterations`. Đây là
cách open model đối phó với hệ thống chậm.

`constant-vus` (closed model) không có cơ chế này. Iteration mới chỉ start
sau khi iter cũ xong. Nếu chậm thì rate giảm, không có drop, không có spawn
thêm.

### 6.4. Edge case: `gracefulStop` interaction với iteration đang chạy

3 case quan trọng tóm tắt:

#### 6.4.1. iter ngắn hơn duration (case bình thường)

```text
config: duration=10s, gracefulStop=2s, iter=0.5s

t=9.5s   VU vào iter cuối (sẽ đến 10s)
t=10.0s  iter cuối finish (vừa kịp), regDurationDone đóng
         VU return, không vào iter mới
         tổng: ceil(10/0.5) = 20 iter/VU
         interrupted = 0
```

Hoặc lệch một chút:

```text
t=9.6s   VU vào iter cuối (sẽ đến 10.1s)
t=10.0s  regDurationDone đóng
         VU đang ở iter cuối (đã 0.4s, còn 0.1s)
t=10.1s  iter cuối finish (0.1s qua < grace 2s, clean)
         tổng: 20 complete, 0 interrupted
```

#### 6.4.2. iter dài hơn duration nhưng ngắn hơn duration + grace

```text
config: duration=5s, gracefulStop=5s, iter=8s

t=0.0s   VU vào iter#0 (sẽ đến 8s)
t=5.0s   regDurationDone đóng
         VU đang ở iter#0 (đã 5s, còn 3s)
t=8.0s   iter#0 finish (3s qua < grace 5s, clean)
         tổng: 1 complete, 0 interrupted (per VU)
```

Đây là case "iter dài nhưng vẫn finish". `gracefulStop` đủ để cứu iter cuối.

#### 6.4.3. iter dài hơn duration + grace

```text
config: duration=3s, gracefulStop=1s, iter=10s

t=0.0s   VU vào iter#0
t=3.0s   regDurationDone đóng
t=4.0s   maxDurationCtx done
         VU vẫn còn 6s iter -> hard cancel
         tổng: 0 complete, 1 interrupted (per VU)
```

Case này chính là demo interrupt đã chạy. `gracefulStop` không đủ để cứu.

#### 6.4.4. Race condition tại `t = duration + grace`

Ở đúng mốc `t = duration + gracefulStop`, có race giữa:

- iter finish trước cancel: `AddFullIterations(1)` (`helpers.go:110`)
- cancel trước iter finish: `AddInterruptedIterations(1)` (`helpers.go:90`)

Đọc từ `getIterationRunner()` (`helpers.go:80-113`):

```go
err := vu.RunOnce()

select {
case <-ctx.Done():
    executionState.AddInterruptedIterations(1)
    return false
default:
    if err != nil {
        if handleInterrupt(ctx, err) {
            executionState.AddInterruptedIterations(1)
            return false
        }
        // ...
    }
    executionState.AddFullIterations(1)
    return true
}
```

Logic:

```text
1) RunOnce() chạy iter (có thể bị cancel giữa chừng do ctx done)
2) Sau khi RunOnce() trả về, check ctx.Done() bằng select non-blocking
   - nếu ctx done -> interrupted
   - không -> full iteration
```

Cho nên ngay cả khi iter "vừa kịp" finish trước cancel, kết quả vẫn dựa vào
`select ... case <-ctx.Done()`. Race này thường không quan trọng trong load
test (1 iter trong tổng N iter).

#### 6.4.5. Tóm gọn quy tắc

```text
nếu effective_iteration_time + max_jitter < duration + gracefulStop:
   -> iter cuối luôn finish, 0 interrupted
nếu không:
   -> có rủi ro interrupted ở iter cuối
   -> tăng gracefulStop để cứu
   -> hoặc giảm effective_iteration_time
```

Quy tắc thực tế:

```text
gracefulStop >= 2 * effective_iteration_time
```

Đảm bảo có buffer cho jitter và iter cuối. Default `30s` thường đủ cho test
HTTP bình thường.

## 7. Demo QuickPizza `2 requests / iteration`

File:

```text
examples/constant_vus_quickpizza_two_requests_demo.js
```

Worked example chi tiết nằm ở:

```text
docs/20260516_03_constant-vus-quickpizza-two-requests-worked-example.md
```

Output chính đã chạy:

```text
checks_total.......: 24      4.667445/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24

http_req_duration..: avg=261.43ms min=259.74ms med=260.93ms max=264.65ms
http_reqs..........: 24    4.667445/s

iteration_duration.: avg=1.7s min=1.52s med=1.52s max=2.07s
iterations.........: 12    2.333723/s
vus................: 4     min=4       max=4
vus_max............: 4     min=4       max=4

running (05.1s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Bóc nhanh:

```text
completed_iterations = 12
http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

summary_runtime_base ~= 12 / 2.333723 = 5.142s
http_reqs_rate ~= 24 / 5.142 = 4.667445 req/s
```

Vì:

```text
1 iteration = 2 HTTP requests
```

nên:

```text
estimated_http_reqs_rate ~= 2 * iterations/s
```

Cách nhân này đúng cho run sạch này vì mỗi completed iteration chạy đủ 2 HTTP requests. Nếu code
có branch/error/interrupt làm số request không cố định, đọc `http_reqs` thực tế.

## 8. So sánh với per-vu và shared

| Điểm so sánh | `constant-vus` | `per-vu-iterations` | `shared-iterations` |
| --- | --- | --- | --- |
| Điều khiển chính | thời gian + số VU | số vòng mỗi VU | tổng số vòng chung |
| Field chính | `vus`, `duration` | `vus`, `iterations` | `vus`, `iterations` |
| `iterations` nghĩa là gì? | không có | số vòng mỗi VU | tổng toàn scenario |
| Tổng iteration biết trước? | Không | Có: `vus * iterations` | Có: `iterations` |
| VU nhanh làm gì? | tự loop nhiều hơn trong cùng duration | xong quota thì idle | lấy thêm việc từ kho iteration chung của scenario |
| Dropped do hết thời gian? | thường không có | có thể có | có thể có |
| Interrupted? | có thể có | có thể có | có thể có |
| Hợp với | giữ N user trong X thời gian | mỗi user/account làm đúng N vòng | nhiều worker chia tổng work |

Ví dụ cùng `vus = 4`:

```text
constant-vus:
  duration = 5s
  -> 4 VU chạy loop trong 5s
  -> tổng iteration phụ thuộc iteration_duration

per-vu-iterations:
  iterations = 3
  -> mỗi VU chạy đúng 3 vòng
  -> tổng = 4 * 3 = 12

shared-iterations:
  iterations = 12
  -> cả 4 VU chia nhau tổng 12 vòng
  -> VU nhanh có thể chạy nhiều hơn VU chậm
```

## 9. Cheat sheet — Công thức cần nhớ nhất

> Phần này dành cho người mới. Mỗi công thức có **tên tiếng Việt**, ví dụ
> đời thường, và "khi nào dùng". Đọc xong section này là dùng được ngay
> mà không cần đọc 3.1-3.16 chi tiết.
>
> `constant-vus` đơn giản hơn `*-arrival-rate` rất nhiều: chỉ pin một số
> VU cố định, không ramp, không drop slot. Mọi công thức đều xoay quanh
> hai con số `vus` và `iter_time`.

### 9.0. Config chung của `constant-vus`

Đây là **bộ config đầy đủ** cho executor `constant-vus`. Đọc bảng này
trước khi viết test, biết tham số nào BẮT BUỘC, tham số nào có default.

#### Template config đầy đủ

```js
export const options = {
  scenarios: {
    my_scenario: {
      // === BẮT BUỘC ===
      executor: "constant-vus",   // tên executor
      vus: 4,                      // số VU pin cố định
      duration: "30s",             // thời gian regular phase

      // === TUỲ CHỌN (có default) ===
      gracefulStop: "30s",         // default = "30s" (từ BaseConfig)
      startTime: "0s",             // default = "0s"
      exec: "default",             // default = "default" function
      tags: { test: "demo" },      // default = {}
      env: { DEBUG: "1" },         // default = {}
    },
  },
};

export default function () {
  // code chạy mỗi iter, chạy lặp suốt duration
}
```

#### Bảng tham số chi tiết

| Tham số | Required? | Default | Đơn vị | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | **BẮT BUỘC** | — | string | Phải đặt là `"constant-vus"` |
| `vus` | **BẮT BUỘC** | — | int (> 0) | Số VU pin cố định trong suốt `duration` |
| `duration` | **BẮT BUỘC** | — | duration (>= 1s) | Thời gian regular phase |
| `gracefulStop` | tuỳ chọn | `"30s"` | duration | Grace cuối scenario cho iter đang chạy |
| `startTime` | tuỳ chọn | `"0s"` | duration | Trễ trước khi scenario bắt đầu |
| `exec` | tuỳ chọn | `"default"` | string | Tên function JS chạy mỗi iter |
| `tags` | tuỳ chọn | `{}` | object | Tag attach vào metric của scenario |
| `env` | tuỳ chọn | `{}` | object | Biến môi trường riêng cho scenario |

**Không có** trong `constant-vus` (tránh nhầm lẫn với executor khác):

```text
iterations          (chỉ có ở per-vu-iterations / shared-iterations)
maxDuration         (không phải option riêng — duration + gracefulStop là trần)
preAllocatedVUs     (chỉ có ở *-arrival-rate)
maxVUs              (chỉ có ở *-arrival-rate)
stages              (chỉ có ở ramping-vus / ramping-arrival-rate)
rate / timeUnit     (chỉ có ở *-arrival-rate)
```

Khai báo nhầm các field này sẽ bị `StrictJSONUnmarshal` từ chối với lỗi
`json: unknown field "..."`. Xem chi tiết Section 3.10.

#### 3 quy tắc validate (đọc từ core)

```text
1. vus > 0
   (nếu <= 0: lỗi "the number of VUs must be more than 0")

2. duration phải có
   (nếu thiếu: lỗi "the duration is unspecified")

3. duration >= 1 giây
   (nếu < 1s: lỗi "the duration must be at least 1s, but is ...")

(BaseConfig còn check: gracefulStop >= 0, startTime >= 0)
```

Code ref: `lib/executor/constant_vus.go:65-80` (function `Validate()`)
và `lib/executor/base_config.go:50-73` (`BaseConfig.Validate()`).

#### Config tối thiểu (chạy được)

Nếu chỉ muốn config gọn nhất, **3 dòng đủ chạy**:

```js
export const options = {
  scenarios: {
    minimal: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
    },
  },
};
```

Các field khác lấy default: `gracefulStop=30s`, `startTime=0s`,
`exec="default"`, `tags={}`, `env={}`.

### 9.1. 5 công thức TOP cho `constant-vus`

#### Công thức 1: "Throughput đỉnh" (Peak rate)

```text
peak_rate = vus / iter_time
```

**Tiếng Việt**: "Throughput đỉnh = số VU chia cho thời gian 1 iter"

**Ví dụ đời thường**:

```text
Quán phở có 4 nhân viên (VU).
Mỗi nhân viên phục vụ 1 khách mất 2 phút (iter_time).

Phân tích từng bước:

  Bước 1 — tốc độ 1 nhân viên:
    iter_time = 2 phút/khách

    Vấn đề: iter_time có đơn vị "phút/khách" (thời gian để xong 1 khách),
           nhưng muốn tính "khách/phút" (số khách trong 1 phút) thì phải ĐẢO.

    Cách đảo — quy tắc toán lớp 5: 1 / (a/b) = b/a

    Viết dưới dạng phân số:
              2 phút
    iter_time = ───────
              1 khách

                            1           1 khách
    1/iter_time = ─────────────────── = ─────── = 0.5 khách/phút
                        2 phút          2 phút
                       ───────
                       1 khách

    Cùng một sự thật, hai đơn vị:
      iter_time     = 2 phút/khách  → "1 khách mất 2 phút"
      1/iter_time   = 0.5 khách/phút → "1 phút được 0.5 khách"

    Hai con số 2 và 0.5 là NGHỊCH ĐẢO của nhau. Đơn vị cũng đảo theo.

  Bước 2 — tốc độ 4 nhân viên (cả quán):
    peak_rate = vus × (1/iter_time)
              = 4 × 0.5
              = 2 khách/phút

    Viết gọn: peak_rate = vus / iter_time = 4 / 2 = 2 khách/phút

    Số 2 ở đây là THROUGHPUT (khách/phút), không phải số VU hay số phút.
    Nó là: 4 nhân viên × (tốc độ mỗi người) = throughput cả quán.

  Bước 3 — quy ra giây nếu cần:
    2 khách/phút = 2/60 = 0.033 khách/giây
    Hoặc: 60 giây × 0.033 = 2 khách (trong 1 phút)

Tóm lại vì sao là vus/iter_time mà không phải vus × iter_time:
  iter_time = giây/iter   (đơn vị thời gian)
  Muốn throughput = iter/giây (đơn vị tốc độ) → PHẢI ĐẢO iter_time
  → throughput = vus × (1/iter_time) = vus / iter_time
```

**Áp vào k6**:

```text
config:
  vus: 4
  duration: "30s"
code: sleep(0.5)  -> iter_time ≈ 0.5s

Bước 1: 1/iter_time = 1/0.5 = 2 iter/s  (tốc độ 1 VU)
Bước 2: peak_rate = 4 × 2 = 8 iter/s    (tốc độ 4 VU)
        Viết gọn: peak_rate = 4 / 0.5 = 8 iter/s
```

**Khi nào dùng**: muốn ước lượng throughput trước khi chạy. Đây là
**rate tối đa** mà scenario có thể đạt nếu code không có biến thiên.

**So với `ramping-vus`**: đơn giản hơn rất nhiều. `ramping-vus` rate
thay đổi theo stage, còn `constant-vus` rate cố định = `vus / iter_time`.

#### Công thức 2: "Rate của 1 VU" (Per-VU rate)

```text
per_vu_rate = 1 / iter_time
```

**Tiếng Việt**: "Tốc độ của 1 VU = 1 chia cho thời gian 1 iter"

**Ví dụ đời thường**:

```text
1 nhân viên phục vụ 1 khách mất 2 phút.
=> nhân viên đó làm được 1 / 2 = 0.5 khách/phút
=> hay 30 khách/giờ
```

**Áp vào k6**:

```text
code có sleep(0.5), HTTP mất ~0.05s -> iter_time ≈ 0.55s

per_vu_rate = 1 / 0.55 ≈ 1.82 iter/giây
```

**Có trong summary không?**: KHÔNG có sẵn. Phải tự tính từ `iteration_duration`.

```text
Trong summary:
  iteration_duration...: avg=0.55s    ← đây là iter_time
  iterations...........: 240  8.0/s   ← đây là throughput TOÀN POOL

Tự tính per_vu_rate:
  per_vu_rate = 1 / iteration_duration.avg
              = 1 / 0.55
              = 1.82 iter/s           ← 1 VU làm được bấy nhiêu

Liên hệ:
  iterations/s ≈ vus × per_vu_rate
      8.0/s   ≈  4  ×    1.82        ← khớp

  iterations/s là tốc độ CẢ POOL (summary có sẵn)
  per_vu_rate  là tốc độ 1 VU     (tự tính, summary KHÔNG có sẵn)
```

**Khi nào dùng**: debug khi VU chậm bất thường, hoặc muốn biết 1 VU
chạy được bao nhiêu iter/giây để sizing.

**Liên kết Công thức 1**: `peak_rate = vus × per_vu_rate`.

#### Công thức 3: "Tổng iter ước lượng" (Total iterations)

```text
total ≈ vus × duration / iter_time
```

**Tiếng Việt**: "Tổng iter ≈ số VU × thời gian / thời gian 1 iter"

**Ví dụ đời thường**:

```text
4 nhân viên làm 30 phút, mỗi khách mất 2 phút.
=> tổng khách = 4 × 30 / 2 = 60 khách
```

**Áp vào k6**:

```text
config: vus=4, duration=30s, sleep(0.5)
total ≈ 4 × 30 / 0.5 = 240 iter
```

**Lưu ý có dấu xấp xỉ (`≈`)**:

```text
Vì sao xấp xỉ?
  - iter_time có thể biến thiên (HTTP latency, GC, ...)
  - iter cuối có thể chưa kịp xong khi grace hết -> bị interrupt
  - VU spawn xong start gần như đồng thời tại t=0,
    nhưng "gần như" chứ không phải đúng tuyệt đối

Trên thực tế:
  total_thực ≈ total_lý_thuyết, sai số vài %
```

**Khi nào dùng**: ước lượng trước test để biết tổng iter sẽ là bao
nhiêu, đối chiếu với `iterations` trong summary sau test.

#### Công thức 4: "Trần wall-clock" (Max real time)

```text
max_wall_time = duration + gracefulStop
```

**Tiếng Việt**: "Thời gian thật tối đa scenario chiếm = duration + gracefulStop"

**Ví dụ đời thường**:

```text
"Quán bán từ 8h-9h" (duration = 1 giờ)
"Cho khách đang ăn 30 phút nữa để xong" (gracefulStop = 30 phút)
=> 9h30 là chốt cuối cùng, sau đó khách phải về
```

**Áp vào k6**:

```text
config: duration="30s", gracefulStop="30s" (default)
max_wall_time = 30 + 30 = 60s

Scenario sẽ kết thúc CHẬM NHẤT là 60s.
Nếu mọi iter đều xong trước 30s, kết thúc đúng 30s.
Nếu có iter dài, k6 đợi tối đa thêm 30s rồi cancel.
```

**Quan trọng**:

```text
Header k6 in:
  "max duration (incl. graceful stop) = duration + gracefulStop"

Đó là cùng 1 con số với max_wall_time.
```

**Khi nào dùng**: setup CI/CD timeout (đặt timeout > max_wall_time để
tránh job kill scenario sớm), hoặc plan thời lượng test.

Code ref: `lib/executor/constant_vus.go:87-98`
(`GetExecutionRequirements()`).

#### Công thức 5: "Số iter mỗi VU" (Per-VU iterations)

```text
iter_per_vu ≈ duration / iter_time
```

**Tiếng Việt**: "Số iter mỗi VU ≈ thời gian / thời gian 1 iter"

**Ví dụ đời thường**:

```text
1 nhân viên làm 30 phút, mỗi khách mất 2 phút.
=> 1 nhân viên phục vụ 30 / 2 = 15 khách
```

**Áp vào k6**:

```text
config: vus=4, duration=30s, sleep(0.5)
iter_per_vu ≈ 30 / 0.5 = 60 iter mỗi VU

Tổng (Công thức 3): 4 × 60 = 240 iter
```

**Liên kết với `__ITER`**:

```text
__ITER counter trong code chạy từ 0 lên iter_per_vu - 1
(mỗi VU có __ITER riêng, đếm từ 0)
```

**Khi nào dùng**: setup test data per-VU (vd dùng `__ITER` làm index
data), hoặc check log xem có VU nào tụt hậu so với expected.

### 9.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

4 tình huống hay gặp, mỗi tình huống dùng công thức nào:

```text
| Tình huống                              | Công thức chính | Phụ trợ |
| --------------------------------------- | --------------- | ------- |
| 1. Sắp viết config, sizing VU           | CT 1 đảo        | CT 3    |
| 2. Đã có target throughput, cần bao nhiêu VU | CT 1 đảo   | -       |
| 3. Đã có sẵn N VU, hỏi throughput được bao nhiêu | CT 1   | CT 3    |
| 4. Đã chạy xong, đọc summary            | CT 5            | CT 3    |
```

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

Đây là tình huống đầu tiên ai cũng gặp: đã có script, muốn test chạy ở tốc
độ target, nhưng chưa biết đặt `vus` bao nhiêu.

Demo dùng để phân tích: `examples/constant_vus_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 10;
const ITER_TIME_SEC = 0.5;  // sleep cố định giả lập request HTTP

const W = ITER_TIME_SEC;
const X = TARGET_RATE;
const calculatedVUs = Math.ceil(X * W);

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "constant-vus",
      vus: calculatedVUs,
      duration: "10s",
      gracefulStop: "5s",
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC);
}
```

Chạy:

```bash
k6 run examples/constant_vus_sizing_demo.js              # X = 10
k6 run -e TARGET_RATE=20 examples/constant_vus_sizing_demo.js  # X = 20
```

Giờ phân tích output theo đúng 4 bước, lấy lần chạy TARGET_RATE=10 làm mẫu.

**── Bước 1: Đo iter_time (W) ──**

Lý thuyết: chạy thử 1 VU, xem `iteration_duration avg` trong summary,
lấy đó làm W.

Trong demo: `const ITER_TIME_SEC = 0.5` → W = 0.5s. Đây là giả lập —
sleep(0.5) mô phỏng 1 request HTTP mất 0.5s. Ngoài đời thì bạn chạy
thử script với 1 VU rồi đọc số từ summary.

```text
iteration_duration...: avg=500.34ms     ← W thực tế ~0.5s, khớp code
```

**── Bước 2: Chọn tốc độ muốn đạt (X iter/s) ──**

Lý thuyết: X là con số bạn TỰ CHỌN dựa trên mục tiêu test. Không đọc
từ summary, không có trong config cũ. Đây là tốc độ sẽ hiện ở dòng
`iterations...: N  X/s` nếu config đúng.

Ví dụ chọn X:
  "Tôi muốn test chạy 10 journey mỗi giây" → X = 10
  "Production 50 req/s, tôi muốn test ở mức đó" → X = 50
  "CI regression cần 30 iter/s cho nhanh" → X = 30

Trong demo: `const TARGET_RATE = 10` → X = 10 iter/s. Có thể đổi qua
env var `-e TARGET_RATE=...`.

```text
iterations...........: 100 9.993115/s   ← 9.99/s ≈ 10/s, khớp X đã chọn
```

**── Bước 3: Tính số VU cần ──**

Lý thuyết: đảo Công thức 1 → `vus = ceil(X × W)`. Làm tròn LÊN vì
VU là số nguyên, thiếu VU thì rate thực tế sẽ thấp hơn target.

Trong demo:
  `const calculatedVUs = Math.ceil(X * W)`
  = ceil(10 × 0.5) = ceil(5) = 5 VU
  → config tự điền `vus: 5`

```text
vus..................: 5   min=5 max=5  ← 5 VU, đúng Bước 3
```

  vus min = max = 5 → constant-vus giữ đúng số VU suốt duration,
  không tụt (khác với per-vu-iterations hay shared-iterations).

**── Bước 4: Đặt config hoàn chỉnh, chạy, đọc summary kiểm tra ──**

Lý thuyết: sau khi có vus từ Bước 3, điền nốt duration, maxDuration,
gracefulStop. Rồi chạy và kiểm tra chéo bằng các công thức.

Trong demo:
  vus: calculatedVUs (= 5)     ← từ Bước 3
  duration: "10s"              ← thời gian muốn test kéo dài
  gracefulStop: "5s"           ← để iter cuối không bị cắt
  maxDuration: (mặc định "10m", dư rộng)

Tổng iter dự kiến (Công thức 3):
  total ≈ vus × duration / W = 5 × 10 / 0.5 = 100 iter
  Summary: iterations = 100 ✓

Peak rate dự kiến (Công thức 1):
  peak = vus / W = 5 / 0.5 = 10 iter/s
  Summary: iterations/s = 9.993 ≈ 10 ✓

Kiểm tra ngược (đảo Công thức 1):
  vus = rate × W = 9.993 × 0.50034 ≈ 5.0 → đúng config ✓

Footer:
```text
running (10.0s), 0/5 VUs, 100 complete and 0 interrupted iterations
                         ↑               ↑
                    N_done = 100    N_int = 0 → sạch
```

  interrupted = 0 → duration + gracefulStop đủ rộng, không iter nào
  bị cắt giữa chừng.

**── Thử target khác để thấy quy luật ──**

```bash
k6 run -e TARGET_RATE=20 examples/constant_vus_sizing_demo.js
```

Bước 2: X = 20.  Bước 3: vus = ceil(20 × 0.5) = 10 VU.

```text
  iterations...........: 200 19.98/s   ← gần 20 ✓
  vus..................: 10
```

→ Muốn rate gấp đôi → VU gấp đôi. Đúng lý thuyết: rate ∝ vus.

```bash
k6 run -e TARGET_RATE=5 examples/constant_vus_sizing_demo.js
```

Bước 3: vus = ceil(5 × 0.5) = ceil(2.5) = 3 VU.

```text
  iterations...........: 50 5.0/s   ← gần 5 ✓
  vus..................: 3
```

Bảng tổng kết:

| X (target) | W | vus = ceil(X × W) | rate thực | total (10s) | Đạt? |
| ---: | ---: | ---: | ---: | ---: | --- |
| 5 | 0.5s | 3 | ~5.0/s | 50 | ✓ |
| 10 | 0.5s | 5 | ~10.0/s | 100 | ✓ |
| 20 | 0.5s | 10 | ~20.0/s | 200 | ✓ |
| 30 | 0.5s | 15 | ~30.0/s | 300 | ✓ |

Tất cả khớp vì demo dùng sleep cố định. Với HTTP thật, iter_time dao
động → rate thực tế lệch vài % → dùng p95 thay avg để an toàn (mục 9.3).

#### Tình huống 2: "Đã có target throughput, cần bao nhiêu VU?"

Đây là dạng phổ biến nhất với `constant-vus`: biết throughput target,
hỏi đặt `vus` bao nhiêu.

```text
Công thức gốc: peak_rate = vus / iter_time     (Công thức 1)
Đảo lại:        vus      = target_rate × iter_time

Thực tế phải làm tròn LÊN:
  vus = ceil(target_rate × iter_time)
```

**Ví dụ thực tế (dùng demo `constant_vus_sizing_demo.js`):**

```text
Ví dụ A: Muốn 20 iter/s, iter_time đo được 0.5s
  vus = ceil(20 × 0.5) = ceil(10) = 10 VU

  Chạy: k6 run -e TARGET_RATE=20 examples/constant_vus_sizing_demo.js
  Summary: iterations.........: 200 19.98/s  ✓  (gần 20)
           vus................: 10

Ví dụ B: Muốn 5 iter/s, iter_time = 0.5s
  vus = ceil(5 × 0.5) = ceil(2.5) = 3 VU

  Chạy: k6 run -e TARGET_RATE=5 examples/constant_vus_sizing_demo.js
  Summary: iterations.........: 50 5.0/s  ✓
           vus................: 3

Ví dụ C: Muốn 7 iter/s, iter_time = 0.3s
  vus = ceil(7 × 0.3) = ceil(2.1) = 3 VU
```

**Lưu ý quan trọng:**

```text
constant-vus KHÔNG đảm bảo target_rate đúng tuyệt đối.
Nếu iter_time biến thiên, rate thực tế cũng biến thiên:
  iter_time tăng (server chậm) → rate giảm
  iter_time giảm (server nhanh) → rate tăng

→ constant-vus rate = vus / iter_time_thực_tế (phụ thuộc latency)
→ Nếu cần rate CHÍNH XÁC bất kể latency: dùng constant-arrival-rate.
```

#### Tình huống 3: "Đã có sẵn N VU, hỏi throughput được bao nhiêu?"

Ngược với Tình huống 2: đã biết số VU (vd do giới hạn tài khoản test,
hoặc do server giới hạn connection), muốn ước lượng throughput sẽ đạt.

```text
Bước 1: Đo iter_time (chạy thử 1 VU)
   W = iteration_duration của code

Bước 2: Tính peak (Công thức 1)
   peak_rate = N / W

Bước 3: Đó là throughput tối đa scenario sẽ đạt
   total ≈ N × duration / W  (Công thức 3)
```

**Ví dụ với demo có sẵn:**

```text
Ví dụ A: Có 6 VU, code sleep(0.5)
  peak_rate = 6 / 0.5 = 12 iter/s
  Tổng iter trong 30s: 6 × 30 / 0.5 = 360 iter

  Nếu chạy thật:
    iteration_duration...: avg=0.5s
    iterations...........: 360  12.0/s
    vus.................. 6

Ví dụ B: Có 2 VU, HTTP request thật ~0.25s + sleep(1) = iter_time ≈ 1.25s
  peak_rate = 2 / 1.25 = 1.6 iter/s
  Tổng iter trong 30s: 2 × 30 / 1.25 = 48 iter

Ví dụ C: Cùng 2 VU, nhưng HTTP nhanh hơn ~0.05s + sleep(0.5) = 0.55s
  peak_rate = 2 / 0.55 = 3.64 iter/s
  Tổng iter trong 30s: 2 × 30 / 0.55 ≈ 109 iter

  → Cùng 2 VU, iter_time giảm từ 1.25s xuống 0.55s
    → throughput tăng từ 1.6 lên 3.64 iter/s
    → Cho thấy: với constant-vus, throughput PHỤ THUỘC iter_time
```

**Điểm cần dạy:**

```text
Với constant-vus, N VU CỐ ĐỊNH không có nghĩa throughput cố định.
Throughput = N / iter_time — iter_time càng nhỏ (code càng nhanh)
thì throughput càng cao. Ngược lại, server chậm → throughput tụt.
```

#### Tình huống 4: "Đã chạy xong, đọc summary"

Sau khi run xong, summary là nơi duy nhất cần đọc để kết luận test
có chạy đúng kế hoạch không.

**4 con số chính trong summary:**

```text
  iteration_duration...: avg=500.34ms    ← W thực tế
  iterations...........: 100  9.99/s     ← N_done  và average rate
  vus..................: 5   min=5 max=5 ← VU active (constant-vus: min=max)
  vus_max..............: 5   min=5 max=5 ← VU đã init
```

**Footer progress:**
```text
  running (10.0s), 0/5 VUs, 100 complete and 0 interrupted iterations
                         ↑           ↑              ↑
                    VU active   N_done=100     N_int=0
```

**5 câu hỏi kiểm tra (theo thứ tự):**

```text
1. N_done có gần total ước lượng không?
     total ≈ vus × duration / W = 5 × 10 / 0.5 = 100
     N_done = 100 → khớp 100% ✓

2. iteration_duration avg có gần W dự kiến không?
     W dự kiến = 0.5s, thực tế = 500.34ms → khớp ✓

3. vus min = vus max = config?
     min=5, max=5, config=5 → constant-vus giữ đúng số VU ✓

4. Có interrupt cuối không?
     interrupted = 0 → không iter nào bị cắt ở grace ✓

5. iterations/s có gần peak_rate dự kiến không?
     peak_rate = vus / W = 5 / 0.5 = 10 iter/s
     thực tế = 9.99/s → gần đúng ✓
```

**Nếu có lệch thì đọc tiếp mục 9.3 "Hành động khi gặp vấn đề".**

### 9.3. Hành động khi gặp vấn đề

#### "Throughput thấp hơn expected!"

Nguyên nhân: `iter_time` thực tế dài hơn dự kiến, hoặc biến thiên lớn.
Cách xử lý theo thứ tự:

```text
1. (KIỂM TRA TRƯỚC) iter_time có biến thiên không?
   Đọc summary:
     iteration_duration min  = ?
     iteration_duration avg  = ?
     iteration_duration max  = ?
     iteration_duration p95  = ?

   Nếu max >> avg (vd avg=500ms nhưng max=5s):
     -> code có biến thiên lớn, throughput không đều
     -> peak_rate tính từ avg, nhưng thực tế thấp hơn nhiều

2. Đo iter_time đúng (chạy test 1 VU, hold lâu)
   Vd: vus=1, duration=60s, đo iteration_duration p95
   -> p95 chính xác hơn avg nếu code biến thiên

3. Tính lại Công thức 1
   peak_rate_thực = vus / iter_time_p95
   (chứ không phải vus / iter_time_avg)

4. Tăng vus nếu cần
   muốn X iter/s ổn định -> vus = ceil(X × iter_time_p95)

5. Nếu vẫn không đạt, đổi executor
   -> constant-arrival-rate cho rate ổn định bất kể iter_time
```

#### "Có interrupted iterations cuối test!"

Nguyên nhân: iter chưa kịp xong khi `duration + gracefulStop` hết.
Cách xử lý:

```text
1. Tăng gracefulStop
   -> Cho iter cuối thêm thời gian
   -> Vd: gracefulStop: "60s" thay vì default 30s

2. Giảm iter_time (tối ưu code)
   -> Bỏ sleep dư
   -> Tối ưu logic, giảm số HTTP request

3. Tăng duration (cho iter "đều" hơn)
   -> Iter đủ dài để biến thiên cuối ít ảnh hưởng

4. Chấp nhận N_int nếu nhỏ
   -> Trong test thực tế, N_int = 1-2 ở biên là OK
   -> Quan trọng là N_int / N_done < 1%
```

#### "iter_time biến thiên lớn (max >> avg)!"

```text
1. Check code có HTTP request bên ngoài không
   -> Latency mạng không ổn định
   -> Đặt timeout cụ thể: http.get(url, { timeout: "5s" })

2. Check code có sleep ngẫu nhiên không
   -> sleep(Math.random() * 5) -> biến thiên lớn
   -> Đổi thành sleep cố định nếu được

3. Check GC pause
   -> Test dài, nhiều object -> GC chạy lâu
   -> Giảm allocation trong hot path

4. Check VU nhiễu lẫn nhau
   -> Quá nhiều VU -> CPU/memory contention
   -> Giảm vus, hoặc chia ra nhiều scenario
```

#### "Test kết thúc sớm hơn duration!"

```text
Không thể với constant-vus.
Khác hẳn shared-iterations / per-vu-iterations:
  - shared-iterations: hết iters thì stop sớm
  - per-vu-iterations: VU xong iters thì idle, scenario stop khi VU cuối xong
  - constant-vus: CHẠY ĐÚNG duration, KHÔNG sớm hơn

Nếu thấy stop sớm:
  -> Có phải bị Ctrl+C không?
  -> Có phải duration < 1s (validate sẽ fail)?
  -> Có phải scenario khác đụng độ?
```

### 9.4. Bảng từ vựng: ký hiệu nào nghĩa là gì?

> Section 3.1-3.16 dùng nhiều ký hiệu rút gọn cho gọn. Đây là bảng tra
> để bạn không phải lật lại đầu Section 3 mỗi lần.

| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
| --- | --- | --- | --- |
| `vus` | "vê u s" | Số VU pin cố định (config) | VU |
| `M` | "em" | Số VU thực tế trong pool (= vus) | VU |
| `W` | "đắp-bờ-liu" | Thời gian 1 iter chiếm 1 VU (= iter_time) | giây/iter |
| `iter_time` | "i tờ tai" | Như W, dạng tiếng Việt dễ đọc | giây/iter |
| `T` | "ti" | duration của scenario | giây |
| `T_run` | "ti rần" | Thời gian thực tế chạy (≤ T + grace) | giây |
| `peak_rate` | "pích rết" | Throughput đỉnh = vus / iter_time | iter/giây |
| `per_vu_rate` | "pờ vê u rết" | Rate của 1 VU = 1 / iter_time | iter/giây |
| `total` | "tổ-tô" | Tổng iter ước lượng | iter |
| `iter_per_vu` | "i tờ pờ vê u" | Số iter mỗi VU ≈ T / iter_time | iter |
| `N_done` | "ren đần" | Tổng iter HOÀN THÀNH (đọc summary) | iter |
| `N_int` | "ren in-tờ" | Iter bị interrupt cuối test | iter |
| `gracefulStop` | "grây-sờ-phun stóp" | Grace cuối scenario | giây |
| `__ITER` | "đồ bồ ai tê e rờ" | Counter iter của VU (đếm từ 0) | int |
| `__VU` | "đồ bồ vê u" | ID của VU (đếm từ 1) | int |

**Khác biệt với `*-arrival-rate`** (KHÔNG có ở `constant-vus`):

```text
λ (lambda)        -> không có (constant-vus đo throughput từ vus, không từ rate config)
N_sched           -> không có (constant-vus không lên lịch slot trước)
N_drop            -> không có (constant-vus không drop, vì không có slot)
preAllocatedVUs   -> không có
maxVUs            -> không có
```

`constant-vus` đơn giản hơn nhiều vì closed model: VU pin xong cứ chạy.

### 9.5. 3 công thức "1 dòng" để giải mọi case (nhớ vĩnh viễn)

```text
Throughput đỉnh?  peak = vus / iter_time
Tổng iter?        total ≈ vus × duration / iter_time
Mỗi VU làm bao nhiêu? per_vu ≈ duration / iter_time
```

Học thuộc 3 dòng này là dùng được 80% nhu cầu thực tế với `constant-vus`.

### 9.6. Đọc output sau test: tìm số ở đâu?

Sau `k6 run`, output có 3 nhóm số liệu cần đọc. Phải biết tìm từng con
số ở đâu để **áp vào đúng công thức** đã học ở 9.1.

**Bảng mapping nhanh: số ở đâu → dùng cho công thức nào**:

```text
| Số liệu                  | Đọc ở đâu                   | Dùng cho công thức |
| ------------------------ | --------------------------- | ------------------ |
| vus (config)             | Header "X looping VUs"      | CT 1, 3 (verify)   |
| duration                 | Header "for Xs"             | CT 3, 4 (verify)   |
| max_wall_time            | Header "max duration"       | CT 4 (verify)      |
| W (iter_time)            | Summary iteration_duration  | CT 1, 2, 3, 5      |
| N_done                   | Summary iterations count    | CT 5 (verify)      |
| actual_rate              | Summary iterations rate     | CT 1 verify (peak) |
| M (vus min/max)          | Summary vus                 | CT 1 verify        |
| T_run                    | Footer "running (X.Xs)"     | CT 5 (mẫu số)      |
| N_int                    | Footer "X interrupted"      | CT 5 (verify)      |
```

Lưu ý: `constant-vus` KHÔNG có `dropped_iterations` (closed model).

#### Nhóm 1: Header (đầu test)

```text
scenarios: (100.00%) 1 scenario, 5 max VUs, 40s max duration (incl. graceful stop):
         * my_scenario: 5 looping VUs for 10s (gracefulStop: 30s)
```

Đọc các con số:

```text
"5 max VUs"               <- vus (số VU pin)
"40s max duration"        <- duration + gracefulStop = 10s + 30s
"5 looping VUs"           <- vus (lặp lại từ config)
"for 10s"                 <- duration
"gracefulStop: 30s"       <- grace cuối
```

#### Nhóm 2: Summary cuối test

```text
EXECUTION
iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
iterations...........: 100   10/s
vus..................: 5     min=5  max=5
vus_max..............: 5     min=5  max=5
```

Đọc các con số:

```text
iteration_duration avg     <- iter_time thực tế (so với config sleep)
iterations (count)         <- N_done
iterations (rate)          <- actual_rate = N_done / T_run
vus (max)                  <- M (= vus, không đổi)
vus_max                    <- preAllocated (= vus)
```

`constant-vus` KHÔNG có dropped_iterations vì closed model không drop.

#### Nhóm 3: Progress/footer (ngay trước summary)

```text
running (10.0s), 0/5 VUs, 100 complete and 0 interrupted iterations
```

Đọc các con số:

```text
"10.0s"                       <- T_run thực tế
"0/5 VUs"                     <- VU đang bận / tổng VU
"100 complete"                <- N_done
"0 interrupted iterations"    <- N_int (= 0 nếu mọi iter xong clean)
```

`N_int` chỉ xuất hiện ở đây, không có metric Counter riêng.

### 9.7. Quy trình 5 bước phân tích output

Sau khi có đủ số liệu từ 9.6, làm 5 bước theo thứ tự. Mỗi bước **dùng
đúng 1 công thức từ 9.1**.

**Bảng mapping nhanh: Bước → Công thức → Số liệu cần**:

```text
| Bước | Công thức dùng       | Input cần              | Output                |
|------|----------------------|------------------------|-----------------------|
| 1    | CT verify            | Header + config        | Verify config OK      |
| 2    | CT 3 (total)         | vus, duration, W       | total dự kiến         |
| 3    | CT 5 (so N_done)     | N_done từ summary      | Tỷ lệ N_done/total    |
| 4    | CT 5 (interrupt)     | N_int từ footer        | Diagnose interrupted  |
| 5    | CT 1 đảo (suy ngược) | actual_rate + W        | Verify peak thực tế   |
```

#### Output mẫu để phân tích (dùng xuyên suốt 5 bước)

**Config đã chạy**:

```js
export const options = {
  scenarios: {
    demo_analyze: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
      // gracefulStop: "30s" (default)
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(0.5); }
```

**Output đầy đủ k6 in ra**:

```text
scenarios: (100.00%) 1 scenario, 2 max VUs, 40s max duration (incl. graceful stop):
         * demo_analyze: 2 looping VUs for 10s

running (10.0s), 0/2 VUs, 40 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=502ms min=500ms max=515ms p(95)=510ms
    iterations...........: 40    3.984063/s
    vus..................: 2     min=2  max=2
    vus_max..............: 2     min=2  max=2

  EXECUTION
  scenarios: 1 scenarios completed
```

Áp 5 bước dưới đây vào đúng output này.

#### Bước 1: Verify config có chạy đúng không [verify Header]

```text
Câu hỏi: header có khớp với config?

Header in:    "2 looping VUs"
Config có:    vus = 2 ✓

Header in:    "for 10s"
Config có:    duration = "10s" ✓

Header in:    "40s max duration"
Tính:         duration + gracefulStop = 10 + 30 = 40s ✓ (Công thức 4)

Header in:    "2 max VUs"
Config có:    vus = 2 (constant-vus init đúng vus VU) ✓

KẾT LUẬN: config đã parse đúng -> sang Bước 2
```

#### Bước 2: Tính total ước lượng [dùng CT 3]

Áp Công thức 3 với iter_time chưa biết, dùng `sleep(0.5)` ≈ 0.5s:

```text
total ≈ vus × duration / iter_time
     ≈ 2 × 10 / 0.5
     = 40 iter
```

#### Bước 3: So với N_done (đã hoàn thành) [dùng CT 5: ratio]

```text
Summary cho:  iterations = 40
Tính từ Bước 2: total ≈ 40

So sánh:
  N_done / total = 40 / 40 = 100%
  -> hoàn hảo, không sai số

Phân loại:
  >= 99%     : test "hoàn hảo"          <- DEMO RƠI VÀO ĐÂY
  95-99%     : sai số biên cuối, OK
  80-95%     : iter_time biến thiên lớn, kiểm tra Bước 5
  < 80%      : code chậm, có vấn đề nghiêm trọng
```

#### Bước 4: Verify N_int

```text
Footer cho:   "0 interrupted iterations" -> N_int = 0

Diagnose:
  N_int = 0  -> tất cả iter đều xong trước duration + grace
              -> code không cần lo grace
              -> không cần tăng gracefulStop
```

Nếu N_int > 0:

```text
N_int = 2:  iter cuối chưa kịp xong khi grace hết
            -> tăng gracefulStop, hoặc giảm iter_time
```

#### Bước 5: Đo iter_time thực tế (suy ngược công thức)

Đây là bước **suy ngược công thức** từ output để biết peak_rate thực tế.

```text
Đo W từ summary:
  iteration_duration avg = 502ms = 0.502s
  iteration_duration p95 = 510ms = 0.51s
  iteration_duration max = 515ms

Đo M từ summary:
  vus max = 2 (= vus, vì constant-vus pin cố định)

Tính peak_rate thực tế (Công thức 1):
  peak_rate_avg = M / W_avg = 2 / 0.502 ≈ 3.98 iter/s
  peak_rate_p95 = M / W_p95 = 2 / 0.510 ≈ 3.92 iter/s

Đối chiếu summary:
  iterations rate = 3.984/s ≈ peak_rate_avg ✓

Sizing đúng:
  Nếu muốn 10 iter/s với code này:
  vus = ceil(10 × 0.502) = ceil(5.02) = 6 VU
  (lấy theo avg, vì code khá đều - max chỉ chênh 13ms)

Kết luận:
  - Code RẤT đều (max - min = 15ms, biến thiên cực thấp)
  - Throughput thực = 3.98/s, gần với target 4/s = 2/0.5
  - Sizing để scale 10x: dùng 6 VU thay vì 2 VU
```

