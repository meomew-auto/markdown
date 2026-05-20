# `constant-vus`: tham số, ý nghĩa và công thức

File này là bài song song với:

```text
docs/20260514_per-vu-iterations-tham-so-cong-thuc.md
docs/20260515_shared-iterations-tham-so-cong-thuc.md
```

nhưng dành cho executor:

```text
constant-vus
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-vus/>

Nếu chỉ muốn tra nhanh, mở:

```text
docs/20260516_constant-vus-quick-index.md
```

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Demo loop theo duration](#4-demo-loop-theo-duration)
- [Demo VU nhanh/chậm](#5-demo-vu-nhanhchậm)
- [Demo interrupt](#6-demo-interrupt)
- [Demo QuickPizza 2 requests / iteration](#7-demo-quickpizza-2-requests--iteration)
- [So sánh với per-vu và shared](#8-so-sánh-với-per-vu-và-shared)
- [Cheat sheet](#9-cheat-sheet)

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
| `http_reqs_rate` | tốc độ HTTP request nhìn từ summary | summary | `http_reqs / summary_runtime_base` | Đây là RPS theo HTTP request. |
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

Nhưng summary `iterations/s` là **average total rate** trên runtime thật:

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

## 4. Demo loop theo duration

File:

```text
examples/constant_vus_loop_demo.js
```

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
  ~= ceil(D / W)
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

## 6. Demo interrupt

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

## 7. Demo QuickPizza `2 requests / iteration`

File:

```text
examples/constant_vus_quickpizza_two_requests_demo.js
```

Worked example chi tiết nằm ở:

```text
docs/20260516_constant_vus_quickpizza_two_requests_worked_example.md
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
| VU nhanh làm gì? | tự loop nhiều hơn trong cùng duration | xong quota thì idle | lấy thêm việc từ pool chung |
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

## 9. Cheat sheet

```text
constant-vus = fixed VUs over time
```

Tham số chính:

```text
vus       số VU cố định
duration  thời gian regular phase
gracefulStop thời gian cho iteration đang chạy finish
```

Không có:

```text
iterations
maxDuration option riêng
```

Header:

```text
max duration (incl. graceful stop) = duration + gracefulStop
```

Công thức:

```text
executor_wall_time_after_start = duration + gracefulStop

per_vu_rate_i = 1 / t_i

peak_iteration_rate_if_all_vus_active = sum(1 / t_i)

average_iteration_rate = completed_iterations / summary_runtime_base

summary_runtime_base = counter_count / counter_rate
```

Nếu các VU đều gần giống nhau:

```text
per_vu_rate ~= 1 / W_effective
peak_iteration_rate ~= vus / W_effective
```

Với HTTP:

```text
estimated_http_requests_if_fixed_path = completed_iterations * http_requests_per_iteration
estimated_http_reqs_rate_if_fixed_path = estimated_http_requests_if_fixed_path / summary_runtime_base
```

Không đọc nhầm:

```text
http_req_duration avg
  = thời gian trung bình của 1 HTTP request

iteration_duration avg
  = thời gian trung bình của 1 vòng JS function

iterations/s
  = tốc độ iteration trung bình của toàn scenario

http_reqs/s
  = tốc độ HTTP request trung bình của toàn scenario
```

Khi tuning:

```text
mu ~= vus / W_effective
```

Trong đó:

```text
mu = capacity iteration/s ước lượng
W_effective = effective_iteration_time_avg
            = thời gian trung bình 1 iteration chiếm 1 VU
```

Nếu cần fixed RPS/iteration rate, đi tiếp executor `constant-arrival-rate`.
