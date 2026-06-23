# `shared-iterations`: tham số, ý nghĩa và công thức

File này là bài song song với `per-vu-iterations`, nhưng dành cho executor:

```text
shared-iterations
```

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/shared-iterations/>

## Mục lục nhanh

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [VU init ở phase nào](#13-vu-init-ở-phase-nào-có-phải-unplanned-vus-không)
- [Checklist core đã lọc](#14-checklist-core-đã-lọc-cho-shared-iterations)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [VU activate xong start iteration ngay](#36-vu-activate-xong-start-iteration-ngay-không-đợi-vu-khác)
- [Vì sao spawn hết VU ngay từ đầu](#37-vì-sao-spawn-hết-vu-ngay-từ-đầu)
- [maxDuration và gracefulStop chi tiết](#38-maxduration-và-gracefulstop-chi-tiết)
- [Lifecycle VU iter counter](#39-lifecycle-vu-và-iter-counter)
- [Khác gì với `per-vu-iterations`](#4-khác-gì-với-per-vu-iterations)
- [Demo phân phối iteration](#5-demo-phân-phối-iteration)
- [Demo đếm từng VU nhanh/chậm](#51-demo-đếm-từng-vu-nhanhchậm)
- [Edge case của shared-iterations](#6-edge-case-của-shared-iterations)
- [Demo QuickPizza 2 requests](#7-demo-quickpizza-2-requests--iteration)
- [Cheat sheet — Công thức cần nhớ nhất](#8-cheat-sheet--công-thức-cần-nhớ-nhất)
  - [Config chung](#80-config-chung-của-shared-iterations)
  - [5 công thức TOP](#81-5-công-thức-top-cần-thuộc-lòng)
  - [Bảng tra theo tình huống](#82-bảng-tra-nhanh-gặp-tình-huống-nào-dùng-công-thức-nào)
  - [Hành động khi gặp vấn đề](#83-hành-động-khi-gặp-vấn-đề)
  - [Bảng từ vựng](#84-bảng-từ-vựng-ký-hiệu-nào-nghĩa-là-gì)
  - [3 công thức 1 dòng](#85-3-công-thức-1-dòng-để-giải-mọi-case-nhớ-vĩnh-viễn)
  - [Đọc output sau test](#86-đọc-output-sau-test-tìm-số-ở-đâu)
  - [Quy trình 5 bước phân tích](#87-quy-trình-5-bước-phân-tích-output)

## 1. Ý tưởng chính

`shared-iterations` nghĩa là:

```text
có một tổng số iteration chung
các VU cùng lấy việc từ kho iteration chung của scenario
VU nào xong sớm thì lấy tiếp iteration mới
scenario kết thúc khi tổng số iteration chung chạy xong
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "shared-iterations",
      vus: 3,
      iterations: 9,
    },
  },
};
```

Hiểu là:

```text
tổng toàn scenario = 9 iterations
3 VU cùng chia nhau 9 iterations đó
```

Không hiểu là:

```text
mỗi VU chạy 9 iterations
```

Với `shared-iterations`, field `iterations` là:

```text
tổng số iteration của scenario
```

không phải:

```text
số iteration cho mỗi VU
```

### 1.1. Khi nào dùng thực tế?

`shared-iterations` hợp khi bạn muốn:

```text
có một tổng số việc cố định
nhiều VU cùng xử lý cho xong tổng số việc đó
```

Ví dụ thực tế:

```text
có 1000 job trong queue
10 worker cùng xử lý
worker nào xong job trước thì lấy job tiếp theo
test kết thúc khi đủ 1000 job được xử lý
```

Mapping sang k6:

```text
vus = 10
iterations = 1000
```

Một vài case hợp:

- benchmark một flow với tổng số request/iteration cố định
- muốn VU nhanh tự lấy thêm việc, không bị idle sớm
- muốn hoàn thành một lượng work cố định nhanh nhất có thể với N VU
- mô phỏng worker pool / job queue đơn giản
- smoke/performance regression với tổng số iteration giống nhau qua mỗi lần run

Ví dụ khác:

```text
5 worker cùng import 500 records
20 VU cùng chạy tổng 2000 flow checkout
10 VU cùng xử lý tổng 1000 message
```

Không hợp khi:

```text
mỗi account phải chạy đúng số vòng bằng nhau
```

Vì VU nhanh có thể lấy thêm nhiều iteration hơn VU chậm. Nếu cần công bằng theo user/account,
dùng `per-vu-iterations`.

### 1.2. Core chạy như nào?

Trong code executor:

```text
lib/executor/shared_iterations.go
```

description của executor là:

```text
N iterations shared among M VUs
```

Khi chạy, core tạo một biến đếm chung:

```text
attemptedIters
```

Mỗi VU trong vòng lặp sẽ lấy iteration tiếp theo bằng atomic counter:

```text
attemptedIterNumber := atomic.AddUint64(&attemptedIters, 1)
```

Nếu số đã lấy vượt quá tổng:

```text
attemptedIterNumber > totalIters
```

thì VU đó dừng.

Hiểu đơn giản:

```text
mọi VU cùng bốc số thứ tự iteration từ một quầy chung
ai bốc nhanh thì được làm nhiều hơn
```

Đây là lý do `shared-iterations` không đảm bảo mỗi VU có số iteration bằng nhau.

Những điểm cần lưu ý thêm khi đọc core:

- **default config**:
  ```text
  vus = 1
  iterations = 1
  maxDuration = 10m
  ```

- **validate**:
  ```text
  vus > 0
  iterations >= vus
  maxDuration >= minDuration
  ```

- **iterations có thể bị scale theo execution tuple**:
  core dùng `GetNewExecutionTupleFromValue()` rồi `ScaleInt64()`, nên trong segmented/distributed run,
  `iterations` của instance hiện tại có thể là phần được scale từ tổng chung.

- **planned VUs được reserve sẵn**:
  `GetExecutionRequirements()` reserve đúng `vus` từ đầu đến
  `maxDuration + gracefulStop`.
  Việc initialize planned VUs xảy ra trong scheduler init phase, trước khi executor `Run()`.
  Thời gian tạo các planned VUs này không tính vào `maxDuration` của scenario. Nếu `vus` rất lớn,
  wall-clock từ lúc bấm `k6 run` có thể lâu hơn, nhưng `exec.scenario.startTime` và
  `maxDuration` bắt đầu sau khi init planned VUs xong.

- **executor mới bắt đầu tính thời gian khi Run()**:
  trong core, `Run()` gọi `getDurationContexts()`, và helper này set `startTime = time.Now()`.
  Đây là mốc dùng cho `maxDuration`, `gracefulStop` và `exec.scenario.startTime`.

- **khi Run() thì executor lấy đủ `vus` ra chạy song song**:
  với `shared-iterations`, sau khi init đủ planned VUs, executor gọi `GetPlannedVU(..., true)`
  đúng `vus` lần, rồi start mỗi VU bằng `go handleVU(initVU)`.
  Nghĩa là lúc bắt đầu executor:
  ```text
  vus = 4
  -> k6 init đủ 4 planned VUs
  -> executor lấy 4 VUs ra khỏi pool
  -> 4 VUs chạy concurrent/song song
  ```
  Nhưng work không chia quota riêng. Các VU cùng lấy từ kho `iterations` chung của scenario:
  ```text
  iterations = 12
  4 VUs cùng lấy iteration từ kho 12 iteration đó
  VU nào xong trước thì lấy tiếp
  ```
  Vì vậy số iteration từng VU thực tế chạy không cố định. Về cuối test, nếu pool gần hết, có thể
  không còn đủ việc để mọi VU đều bận tới giây cuối.
  Nghĩa là phải tách:
  ```text
  VU đã được start / active
  !=
  VU đang thật sự bận chạy iteration
  ```
  Ví dụ gần cuối:
  ```text
  4 VU đã được start
  nhưng kho iteration chung của scenario chỉ còn 1 iteration cuối
  -> chỉ 1 VU đang bận
  -> 3 VU còn lại không còn việc để lấy
  ```

- **`doneIters` chỉ là progress counter nội bộ**:
  nó dùng để vẽ progress bar `xx/yy shared iters`, không phải chính metric summary `iterations`.

- **`dropped_iterations` được emit nếu chưa lấy hết work**:
  nếu test chạm `maxDuration` khi còn iteration chưa được lấy từ kho iteration chung của scenario,
  core sẽ push phần còn lại vào
  `DroppedIterations`.

- **hết `maxDuration` thì không lấy iteration mới nữa**:
  vòng lặp VU check `regDurationDone` trước khi `atomic.AddUint64(&attemptedIters, 1)`.

- **không có fairness guarantee giữa các VU**:
  đây không phải bug, mà là đúng design của executor.

### 1.3. VU init ở phase nào? Có phải unplanned VUs không?

Câu hỏi hay gặp:

```text
khi config vus=4, iterations=100 thì 4 VU đó được init lúc nào?
nếu test có nhiều iteration mà ít VU, k6 có spawn thêm VU runtime không?
shared-iterations có khái niệm unplanned VUs không?
```

Trả lời ngắn:

```text
4 VU được init ở init phase, trước khi Run() chạy
shared-iterations KHÔNG có unplanned VUs
k6 KHÔNG spawn thêm VU lúc runtime dù còn nhiều iteration trong kho
closed model nói chung không có khái niệm unplanned VUs
```

Đi vào chi tiết core:

- **Init phase init đủ `vus` instance một lần**:

  Trước khi `Run()` chạy, scheduler gọi `GetExecutionRequirements()`.
  Với `shared-iterations` (`shared_iterations.go:103-124`):

  ```go
  return []lib.ExecutionStep{
      {TimeOffset: 0, PlannedVUs: uint64(vus)},
      {TimeOffset: maxDuration + gracefulStop, PlannedVUs: 0},
  }
  ```

  Nghĩa là toàn bộ thời gian scenario có đúng `vus` planned VU (không có
  bậc thay đổi). Scheduler thấy con số này, init đủ `vus` JS context vào
  pool ngay từ đầu. Bước này xong **trước** khi scenario bắt đầu chạy.

- **`Run()` lấy đủ `vus` ra khỏi pool và bắn goroutine**:

  Đoạn `shared_iterations.go:264-272`:

  ```go
  for range numVUs {
      initVU, err := si.executionState.GetPlannedVU(si.logger, true)
      if err != nil {
          cancel()
          return err
      }
      activeVUs.Add(1)
      go handleVU(initVU)
  }
  ```

  Tất cả `vus` được pull ra cùng lúc, mỗi VU một goroutine `handleVU()`.
  Khác với `ramping-vus` (start/stop theo timeline), `shared-iterations` chỉ
  có 1 lần activate ở đầu, sau đó VU loop tới khi hết kho hoặc hết duration.

- **Không có scale up giữa runtime**:

  `GetExecutionRequirements()` trả về timeline `vus` cố định, không có step
  nào tăng VU. `handleVU()` cũng không gọi `GetPlannedVU()` lần nào nữa
  ngoại trừ vòng lặp `for range numVUs` ở `Run()`.

  Cho dù iteration trong kho nhiều bao nhiêu, nếu `vus=4` thì cả test luôn
  chỉ có 4 VU đua nhau lấy việc.

- **So sánh nhanh với arrival-rate (open model)**:

  | Khái niệm | Closed model (`shared-iterations`, `per-vu-iterations`, ...) | Open model (`*-arrival-rate`) |
  | --- | --- | --- |
  | Init thêm VU trong runtime? | không | có, nếu cần |
  | Field `preAllocatedVUs` | không có | có |
  | Field `maxVUs` (scenario) | không có | có |
  | Khái niệm unplanned VU | không tồn tại | `MaxUnplannedVUs = maxVUs - preAllocatedVUs` |
  | Vì sao? | iteration mới chỉ start sau khi iter cũ xong → biết trước số VU cần | rate cố định, có thể vượt năng lực preAllocated → cần spawn thêm |

  Grep core:

  ```text
  unplannedVUs / preAllocatedVUs chỉ xuất hiện ở:
    constant_arrival_rate.go
    ramping_arrival_rate.go
  ```

  Hoàn toàn không có ở `shared_iterations.go`.

Tóm lại:

```text
shared-iterations là closed model
4 VU được init đầy đủ ở init phase, không có spawn thêm runtime
unplanned VUs không tồn tại với executor này
muốn nhiều worker hơn -> tăng vus trong config, không có cách runtime
```

### 1.4. Checklist core đã lọc cho `shared-iterations`

| Core | Hành vi thật | Ý nghĩa khi đọc bài |
| --- | --- | --- |
| `shared_iterations.go:NewSharedIterationsConfig()` | default `vus = 1`, `iterations = 1`, `maxDuration = 10m` | Thiếu config thì executor vẫn có total work mặc định nhỏ. |
| `shared_iterations.go:GetVUs()` | scale `vus` qua execution tuple | Local thường bằng config; segmented/distributed run phải dùng số đã scale. |
| `shared_iterations.go:GetIterations(et)` | scale `iterations` bằng execution tuple | Với distributed/segment, instance hiện tại có thể chỉ chạy phần work được chia. |
| `shared_iterations.go:GetExecutionRequirements()` | reserve planned VUs tới `maxDuration + gracefulStop` | Planned VUs init trước execution; không có unplanned VUs cho executor này. |
| `shared_iterations.go:Run()` | tạo `attemptedIters` chung cho toàn scenario | Work nằm trong kho iteration chung của scenario, không chia quota riêng theo VU. |
| `shared_iterations.go:handleVU()` | mỗi VU lấy 1 iteration bằng `atomic.AddUint64(&attemptedIters, 1)` | Trong core hay gọi là `claim`, nhưng ở bài học này cứ hiểu là VU "lấy" 1 iteration để chạy. |
| `shared_iterations.go:regDurationDone` | hết `maxDuration` thì VU không lấy iteration mới nữa | Phần work chưa lấy có thể thành `dropped_iterations`. |
| `shared_iterations.go` defer sau `activeVUs.Wait()` | nếu `attemptedIters < totalIters`, emit `DroppedIterations = totalIters - attemptedIters` | Drop là phần work trong kho iteration chung chưa từng được lấy. |
| `helpers.go:getDurationContexts()` | `maxDuration` là regular duration, `gracefulStop` là cửa sổ chờ sau đó | Hết `maxDuration` ngừng lấy mới; iteration đang chạy có thể finish trong grace. |
| `internal/js/runner.go:RunOnce()` + `iterationSamples()` | `iterations`/`iteration_duration` chỉ emit khi full iteration hoàn tất | `completed_iterations` đọc từ metric, không lấy từ total work nếu có drop/interrupt. |
| `internal/js/runner.go` min duration path | `iteration_duration` emit trước sleep bù `minIterationDuration` | Capacity phải dùng `effective_iteration_time`, không dùng riêng `iteration_duration` khi có min. |
| `scheduler.go:emitVUsAndVUsMax()` | `vus`/`vus_max` sample từ active/initialized VUs | Gauge sample theo thời điểm, không phải Counter. |

### Demo dropped iterations do `maxDuration`

Grafana docs cho ý này:

```text
với shared-iterations và per-vu-iterations
iterations sẽ bị drop nếu scenario chạm maxDuration trước khi toàn bộ iterations finish
```

Với `shared-iterations`, phải hiểu đúng là:

```text
hết maxDuration
-> k6 không cho VU lấy iteration mới từ kho nữa
-> phần work trong kho chưa được lấy sẽ đi vào dropped_iterations
```

Nếu iteration đang chạy dở mà vẫn finish kịp trong `gracefulStop`, nó vẫn được tính là `complete`,
không phải `dropped`.

Nếu muốn mitigate theo docs thì với executor này thường là:

```text
tăng maxDuration
```

chứ không phải field `duration`, vì `shared-iterations` không có option `duration`.

File demo:

```text
examples/shared_iterations_dropped_demo.js
```

Command:

```bash
k6 run examples/shared_iterations_dropped_demo.js
```

Config:

```text
vus = 2
iterations = 5
maxDuration = 3s
gracefulStop = 2s
sleep(2) trong mỗi iteration
```

Timeline chạy thật:

```text
t=0.0s  VU1 lấy iter 0, VU2 lấy iter 1
t=2.0s  iter 0 va iter 1 end
t=2.0s  VU1 lấy iter 3, VU2 lấy iter 2
t=3.0s  het maxDuration
t=4.0s  iter 2 va iter 3 end trong gracefulStop

iter 4 khong duoc lay nua
```

Output chính đã chạy:

```text
scenarios:
  * shared_dropped_demo: 5 iterations shared among 2 VUs (maxDuration: 3s, gracefulStop: 2s)

EXECUTION
  dropped_iterations...: 1   0.249919/s
  iterations...........: 4   0.999677/s

running (4.0s), 0/2 VUs, 4 complete and 0 interrupted iterations
```

Đọc ra:

```text
tổng mục tiêu = 5 iterations
thực tế complete = 4
interrupted = 0
dropped_iterations = 1
```

Vì sao drop?

```text
kho iteration chung của scenario còn 1 iteration chưa được lấy trước khi hết maxDuration
```

Đây chính là ý docs đang nói.

## 2. Bảng tham số tiếng Việt

| Tên trong k6 / ký hiệu | Dịch tiếng Việt | Lấy ở đâu | Cách tính / quy đổi | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | kiểu chạy | `options.scenarios.<name>.executor` | `"shared-iterations"` | Chọn executor shared iterations. |
| `vus` | số VU / số worker | `options.scenarios.<name>.vus` | lấy từ config | Số VU cùng chia nhau tổng iteration. |
| `iterations` | tổng số iteration chung | `options.scenarios.<name>.iterations` | lấy từ config | Tổng số iteration của scenario, không phải mỗi VU. |
| `total_iterations_target` | tổng iteration mục tiêu | ký hiệu mình dùng | `total_iterations_target = iterations` | Tổng việc cần chạy xong. |
| `completed_iterations` | số iteration hoàn thành thật | summary/progress | clean run thường đọc từ `iterations` hoặc progress `complete` | Nếu không drop/interrupt thì thường bằng `iterations`. Edge case context chết trong sleep bù `minIterationDuration` có thể làm summary `iterations` và progress `complete` lệch nhau. |
| `iterations_per_vu_i` | số iteration VU i thực tế chạy | log / tự đo | không cố định | VU nhanh thường có số này lớn hơn VU chậm. |
| `maxDuration` | trần thời gian chạy bình thường | config | lấy trực tiếp | Hết mốc này không start iteration mới. |
| `gracefulStop` | thời gian chờ dừng mềm | config/base | lấy trực tiếp | Cho iteration đang chạy thêm thời gian kết thúc. |
| `minIterationDuration` | thời gian tối thiểu mỗi iteration | global option | lấy trực tiếp | Nếu function chạy ngắn hơn min, k6 sleep bù sau function. Phần sleep bù không nằm trong `iteration_duration`, nhưng vẫn chiếm VU. |
| `effective_iteration_time` | thời gian VU bị bận cho 1 iteration | tự tính | không min: `iteration_duration`; có min: `max(iteration_duration, minIterationDuration)` | Dùng để ước lượng `per_vu_rate`. |
| `actual_scenario_runtime` | thời gian scenario chạy thật theo cách nhìn của bài | summary / tự tính | gần với thời gian đến khi kho iteration chung của scenario chạy xong | Hữu ích để hiểu executor, nhưng không phải lúc nào cũng trùng mẫu số `/s` của summary. |
| `average_iteration_rate` | tốc độ iteration trung bình nhìn từ summary | summary | `completed_iterations / summary_runtime_base` | Với demo 1 scenario sạch, `summary_runtime_base` thường gần runtime của scenario. |
| `vus` metric | số VU active tại sample | summary/progress | Gauge `value/min/max` | Có bao nhiêu VU đang active theo sample. |
| `vus_max` metric | số VU initialized | summary | Gauge `value/min/max` | Số VU đã tạo sẵn/reserve. |
| `iteration_duration` | thời gian một iteration | summary | Trend `avg/min/med/max/p...` | Đo cả JS, HTTP, check, sleep trong function. |

Ghi nhớ nhanh:

```text
shared-iterations:
  total_iterations_target = iterations

per-vu-iterations:
  total_iterations_target = vus * iterations
```

## 3. Công thức nền

### 3.1. Tổng iteration

```text
total_iterations_target = iterations
```

Ví dụ:

```text
vus = 4
iterations = 12

total_iterations_target = 12
```

### 3.2. Iteration theo từng VU

Với `shared-iterations`, không có công thức:

```text
iterations_per_vu = iterations
```

Thay vào đó:

```text
iterations_per_vu_1 + iterations_per_vu_2 + ... + iterations_per_vu_n
  = completed_iterations
```

Nếu không drop/interrupt:

```text
sum(iterations_per_vu_i) = total_iterations_target
```

### 3.3. Runtime và rate

Với metric `Counter`, core summary dùng:

```text
rate = count / summary_runtime_base
summary_runtime_base = count / rate
```

Ví dụ:

```text
iterations.........: 12  2.317275/s

summary_runtime_base
  = 12 / 2.317275
  ≈ 5.1785s
```

Lưu ý:

```text
đây là mẫu số mà summary Counter dùng cho cột /s của cả test run
trong demo 1 scenario, startTime=0, không setup/teardown thì nó mới gần runtime của scenario
```

Khi cần ước lượng tốc độ mỗi VU, dùng thời gian VU bị bận:

```text
effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration
per_vu_rate_i ~= 1 / effective_iteration_time
```

### 3.4. Nếu các VU đều chạy gần giống nhau

Nếu:

```text
vus = 4
iterations = 12
iteration_time ≈ 1.5s
```

thì có thể ước lượng theo wave:

```text
waves ≈ ceil(iterations / vus)
      = ceil(12 / 4)
      = 3

runtime ≈ waves * iteration_time
        ≈ 3 * 1.5s
        ≈ 4.5s
```

Thực tế có overhead/network nên output có thể lớn hơn.

### 3.5. Nếu VU nhanh/chậm khác nhau

Không chia đều. VU nhanh lấy thêm việc:

```text
VU nhanh: nhiều iteration hơn
VU chậm: ít iteration hơn
```

Đây là điểm khác lớn nhất với `per-vu-iterations`.

### 3.6. VU activate xong start iteration ngay, không đợi VU khác

Câu hỏi: với `vus=4, iterations=12`, 4 VU được activate cùng lúc tại t=0
hay tuần tự? VU đầu tiên có chờ VU thứ 2/3/4 init xong rồi mới chạy không?

Trả lời ngắn:

```text
4 VU được activate ngay tại t=0, đồng loạt vào iter đầu
mỗi VU độc lập, không chờ VU khác
mỗi VU có goroutine handleVU() riêng, loop iteration của nó
hết kho iteration chung -> VU đó tự dừng
```

#### 3.6.1. Đọc từ core

`shared_iterations.go:264-272`:

```go
for range numVUs {
    initVU, err := si.executionState.GetPlannedVU(si.logger, true)
    if err != nil {
        cancel()
        return err
    }
    activeVUs.Add(1)
    go handleVU(initVU)
}
```

`Run()` chạy `for range numVUs` rất nhanh: với `numVUs=4` thì pull đủ 4 VU
và bắn 4 goroutine `handleVU()` chỉ trong vài microsecond. 4 goroutine này
chạy song song.

`handleVU()` ở `shared_iterations.go:239-262` có cấu trúc:

```go
handleVU := func(initVU lib.InitializedVU) {
    ctx, cancel := context.WithCancel(maxDurationCtx)
    defer cancel()

    activeVU := initVU.Activate(getVUActivationParams(...))

    for {
        select {
        case <-regDurationDone:
            return                          // hết maxDuration -> dừng
        default:
        }

        attemptedIterNumber := atomic.AddUint64(&attemptedIters, 1)
        if attemptedIterNumber > totalIters {
            return                          // hết kho -> dừng
        }

        runIteration(maxDurationCtx, activeVU)
        atomic.AddUint64(doneIters, 1)
    }
}
```

Mỗi VU tự `Activate()` và vào vòng lặp `for {}` ngay. Không có rendezvous,
không có barrier, không đồng bộ với VU khác.

#### 3.6.2. Snapshot tại các mốc

Config `vus=4, iterations=12`, code mỗi iter `sleep(0.5)`:

```text
t=0.000s   Run() bắn 4 goroutine handleVU
t=0.001s   4 VU activate xong, đồng loạt vào iter đầu
           VU=1: attemptedIterNumber=1 (kho còn 11)
           VU=2: attemptedIterNumber=2 (kho còn 10)
           VU=3: attemptedIterNumber=3 (kho còn 9)
           VU=4: attemptedIterNumber=4 (kho còn 8)
t=0.5s    cả 4 VU finish iter đầu, đồng loạt lấy iter mới
           VU=1: attemptedIterNumber=5
           VU=2: attemptedIterNumber=6
           VU=3: attemptedIterNumber=7
           VU=4: attemptedIterNumber=8
t=1.0s    4 VU finish, lấy tiếp
           attemptedIterNumber=9, 10, 11, 12
t=1.5s    4 VU finish, gọi atomic.AddUint64 -> > 12 -> return
           tất cả VU dừng
```

Atomic counter đảm bảo không có 2 VU lấy trùng số. Nếu race ở t=1.0s, 4 VU
gọi `atomic.AddUint64(&attemptedIters, 1)` đồng thời thì kết quả tuần tự
9, 10, 11, 12 (chỉ là thứ tự ai trước ai sau không xác định trước).

#### 3.6.3. Throughput peak khi cả `vus` VU cùng active

```text
peak_iteration_rate ≈ vus / effective_iteration_time
```

Áp vào ví dụ trên (`vus=4, iter time=0.5s`):

```text
peak_rate ≈ 4 / 0.5 = 8 iter/s
```

Nếu code khác:

```text
sleep(1)               -> peak ≈ 4 / 1   = 4 iter/s
http 200ms + sleep(0.5) -> peak ≈ 4 / 0.7 ≈ 5.7 iter/s
```

Vì 4 VU active suốt từ t=0 (trừ phần cuối khi kho cạn), throughput gần như
phẳng — khác `ramping-vus` (throughput tăng/giảm theo timeline).

#### 3.6.4. Gần cuối kho: số VU active giảm

Khi kho gần cạn, không phải VU nào cũng còn việc. VU lấy được số > totalIters
sẽ return ngay. Ví dụ `iterations=10, vus=4`:

```text
t=...     attemptedIters=8 -> VU lấy số 9 còn việc
          attemptedIters=9 -> VU lấy số 10 còn việc
          attemptedIters=10 -> VU lấy số 11, > 10 -> return
          attemptedIters=11 -> VU lấy số 12, > 10 -> return

=> gần cuối có thể chỉ 1-2 VU đang chạy iter cuối
   các VU khác đã return, nhưng activeVUs.Wait() vẫn chờ
```

Đây là lý do `vus` Gauge có thể giảm dưới `vus` config ở mốc gần cuối:

```text
vus: 4 min=2 max=4
       ^      ^
       |      |
       cuối: kho cạn, một số VU đã return
       max: đầu test, 4 VU đều bận
```

#### 3.6.5. Điểm dễ nhầm

```text
SAI : "VU đầu tiên chạy hết iter mới đến VU thứ 2"
ĐÚNG: "4 VU activate cùng lúc, đồng loạt vào iter đầu"

SAI : "iteration được phân phối tuần tự theo VU index"
ĐÚNG: "iteration phân phối theo ai đến quầy atomic counter trước"

SAI : "có thể tăng VU lên runtime nếu kho còn nhiều iter"
ĐÚNG: "vus cố định trong suốt scenario, không có scale up"
```

### 3.7. Vì sao spawn hết VU ngay từ đầu?

Khác với `ramping-vus` (rải VU theo timeline), `shared-iterations` activate
hết `vus` VU **ngay tại t=0**. Tại sao thiết kế thế?

#### 3.7.1. Mục tiêu khác nhau

```text
ramping-vus       : mô phỏng concurrency thay đổi theo thời gian
                    -> rải VU theo stage để tạo "tăng dần"

shared-iterations : hoàn thành tổng N iteration nhanh nhất với M worker
                    -> activate hết M worker ngay để max throughput
                    -> không có khái niệm "ramp" trong executor này
```

`shared-iterations` không có `stages`, `startVUs`, `gracefulRampDown`. Config
chỉ có `vus`, `iterations`, `maxDuration`. Nghĩa là không có cách "rải" VU
theo timeline — toàn bộ VU phải có mặt từ đầu.

#### 3.7.2. Đọc từ core

`GetExecutionRequirements()` (`shared_iterations.go:103-124`) trả về timeline
chỉ có 2 step:

```go
return []lib.ExecutionStep{
    {TimeOffset: 0, PlannedVUs: uint64(vus)},                           // t=0: đủ vus
    {TimeOffset: maxDuration + gracefulStop, PlannedVUs: 0},            // cuối: 0
}
```

Step 1 nói "tại t=0 đã phải có đủ `vus` planned VU". Step 2 nói "tại
`maxDuration + gracefulStop`, planned VU về 0". Giữa 2 step không có bậc
trung gian, scheduler không cần phân tích timeline phức tạp.

`Run()` (`shared_iterations.go:264-272`) cũng phản ánh: `for range numVUs`
chạy đúng `numVUs` lần, mỗi lần `GetPlannedVU()` + `go handleVU()`. Không có
helper dạng `vuHandle` start/stop như `ramping_vus.go` — không cần state
machine vì không có scale up/down.

#### 3.7.3. Hệ quả thực tế

```text
- max throughput đạt được ngay từ giây đầu
  (không có warm-up từ 1 VU lên N VU như ramping)

- nếu test quá ngắn (vài ms), 4 VU vẫn kịp activate trước khi iter chạy
  vì init đã xong từ trước Run()

- không có "load shape" — đường biểu diễn vus theo time gần như phẳng
  4 4 4 4 4 ... rồi giảm gần cuối khi kho cạn

- nếu muốn ramp up VU, phải dùng ramping-vus rồi đếm tổng iter sau
```

#### 3.7.4. Khi nào không phù hợp

```text
- muốn xem hệ thống chịu tải tăng dần thế nào
  -> dùng ramping-vus, không phải shared-iterations

- muốn đảm bảo từng user (account) chạy đủ N vòng
  -> dùng per-vu-iterations

- muốn ép start iteration theo rate cố định (không phụ thuộc iter time)
  -> dùng constant-arrival-rate / ramping-arrival-rate
```

`shared-iterations` chỉ phù hợp khi mục tiêu là "M worker cùng làm xong N
việc". Nếu mục tiêu khác, chọn executor khác.

### 3.8. `maxDuration` và `gracefulStop` chi tiết

`shared-iterations` có 2 mốc thời gian quan trọng từ config:

```text
maxDuration  : trần wall-clock của scenario, hết -> không lấy iter mới
gracefulStop : sau maxDuration, iter đang chạy được phép tiếp tục thêm N giây
```

Default values (đọc từ `shared_iterations.go:46`, `BaseConfig`):

```text
maxDuration  = 10m
gracefulStop = 30s
```

#### 3.8.1. Hai trục độc lập (giống cách đọc ramping-vus)

Khi đọc timeline ví dụ bên dưới, phải tách rõ 2 trục:

```text
Trục 1 — SCENARIO timeline (do CONFIG quyết định):
  t=0           scenario bắt đầu
  t=maxDuration scenario hết regular phase, vào graceful
  t=maxDuration+gracefulStop scenario kết thúc hoàn toàn

Trục 2 — VU iteration timeline (do CODE quyết định):
  iter_duration = thời gian default function chạy (sleep, http, ...)
  với sleep(2): iter#0 = t=0..2, iter#1 = t=2..4, iter#2 = t=4..6
  __ITER counter của từng VU đếm độc lập
```

Hai trục **không đồng bộ**:

```text
- VU finish iter#0 ở t=2s không liên quan tới scenario timeline
  VU chỉ cần kiểm regDurationDone (closed channel khi hết maxDuration)
  và atomic counter (số iter đã lấy)

- maxDuration hết ở t=N -> không cắt iter đang chạy
  iter đó được phép finish trong gracefulStop
  VU chỉ không lấy iter mới
```

#### 3.8.2. Đọc từ core

`getDurationContexts()` (gọi từ `shared_iterations.go:174`) tạo 2 context:

```text
regDurationCtx : cancel khi t=maxDuration
maxDurationCtx : cancel khi t=maxDuration+gracefulStop
```

Trong `handleVU()` (`shared_iterations.go:246-252`):

```go
for {
    select {
    case <-regDurationDone:
        return                            // hết maxDuration -> không lấy iter mới
    default:
    }

    attemptedIterNumber := atomic.AddUint64(&attemptedIters, 1)
    if attemptedIterNumber > totalIters {
        return                            // hết kho -> dừng
    }

    runIteration(maxDurationCtx, activeVU) // iter chạy với maxDurationCtx
    atomic.AddUint64(doneIters, 1)
}
```

Hai cơ chế khác nhau:

```text
1) Trước khi lấy iter mới: check regDurationDone
   -> hết maxDuration, không vào atomic.AddUint64 nữa

2) Khi iter đang chạy: dùng maxDurationCtx
   -> iter chạy được tới maxDuration + gracefulStop
   -> nếu chưa xong tới mốc đó -> context cancel -> iter bị interrupt
```

#### 3.8.3. Ví dụ đầy đủ

Config:

```js
scenarios: {
  demo_stop: {
    executor: "shared-iterations",
    vus: 2,
    iterations: 10,
    maxDuration: "5s",
    gracefulStop: "3s",
  },
},

// code: mỗi iter sleep 2s
export default function () { sleep(2); }
```

Tách 2 trục:

```text
Scenario timeline:
  t=0      scenario start
  t=5s     maxDuration hết (regDurationCtx done)
  t=8s     gracefulStop hết (maxDurationCtx done)

VU iter timeline:
  iter time = 2s
  VU=1 iter#0 = t=0..2
  VU=1 iter#1 = t=2..4
  VU=1 iter#2 = t=4..6 (vắt qua t=5s!)
  VU=2 iter#0 = t=0..2
  VU=2 iter#1 = t=2..4
  VU=2 iter#2 = t=4..6
```

Timeline đầy đủ:

```text
t=0.0s   2 VU activate, đồng loạt vào iter
         VU=1: attemptedIterNumber=1, sleep(2)
         VU=2: attemptedIterNumber=2, sleep(2)

t=2.0s   2 VU finish, lấy tiếp
         VU=1: attemptedIterNumber=3
         VU=2: attemptedIterNumber=4

t=4.0s   2 VU finish, lấy tiếp
         VU=1: attemptedIterNumber=5 (kho còn 5/10)
         VU=2: attemptedIterNumber=6 (kho còn 4/10)
         VU=1, VU=2 vào iter#2 (sẽ đến t=6.0s)

t=5.0s   maxDuration hết, regDurationCtx done
         VU=1, VU=2 đang ở giữa iter#2 (đã chạy 1s, còn 1s)
         iter đang chạy KHÔNG bị cắt
         vào pha grace

t=6.0s   VU=1, VU=2 finish iter#2 (1s qua < grace 3s, finish clean)
         vòng for tiếp theo: check regDurationDone -> đã done -> return
         attemptedIterNumber=5,6 đã chạy xong (iter complete)

t=6.0s   defer: activeVUs.Wait() chờ tất cả goroutine return
         attemptedIters = 6, totalIters = 10
         emit DroppedIterations = 10 - 6 = 4

scenario summary:
  iterations          = 6 (complete)
  dropped_iterations  = 4 (chưa lấy được trước maxDuration)
  interrupted         = 0 (iter đang chạy đều finish trong grace)
```

#### 3.8.4. Biến thể 1: `iter_time = 4s` (lâu hơn grace)

```text
t=0.0s   VU=1, VU=2 vào iter#0 (đến t=4.0s)
t=4.0s   VU=1, VU=2 finish iter#0
         attemptedIterNumber=3, 4
         vào iter#1 (sẽ đến t=8.0s nếu không bị cắt)
t=5.0s   maxDuration hết, vào grace
t=8.0s   gracefulStop hết, maxDurationCtx done
         VU=1, VU=2 vẫn đang ở iter#1 (đã 4s = đúng iter time)
         tùy race: có thể finish clean hoặc bị interrupt

         worst case: iter#1 chưa kịp emit complete -> +interrupted
         best case:  iter#1 finish ngay trước context cancel -> +complete

         dropped_iterations = 10 - 4 = 6
```

#### 3.8.5. Biến thể 2: `iter_time = 6s` (lâu hơn cả grace)

```text
t=0.0s   VU=1, VU=2 vào iter#0 (sẽ đến t=6.0s)
t=5.0s   maxDuration hết, vào grace
         VU=1, VU=2 đang ở iter#0 (đã 5s, còn 1s)
t=6.0s   VU finish iter#0 (1s qua < grace 3s, finish clean)
         vòng for tiếp: regDurationDone -> return
         attemptedIters = 2

dropped_iterations = 10 - 2 = 8
iterations         = 2
```

#### 3.8.6. Biến thể 3: `gracefulStop = "0s"`

```text
t=5.0s   maxDuration hết, gracefulStop=0 -> maxDurationCtx cancel ngay
         VU=1, VU=2 đang ở iter (đã 1s, còn tùy iter time)
         iter bị cancel -> +interrupted
         vòng for tiếp: regDurationDone -> return

         iterations         < expected (mất iter đang chạy)
         interrupted        = 2 (VU bị cắt giữa iter)
         dropped_iterations = totalIters - attemptedIters
```

`gracefulStop=0s` rất hà khắc, dễ tạo interrupted iterations. Default 30s
là an toàn cho hầu hết case.

#### 3.8.7. Quy tắc thực tế

```text
- iter_time << gracefulStop  : mọi iter đang chạy đều finish clean
- iter_time ≈ gracefulStop   : race condition, có thể có interrupted
- iter_time >> gracefulStop  : iter bị interrupt nhiều, summary ra số nhỏ

- nếu test thường xuyên hit maxDuration -> tăng maxDuration
- nếu chỉ thỉnh thoảng iter dài -> tăng gracefulStop
```

### 3.9. Lifecycle VU và `__ITER` counter

Trong `shared-iterations`, lifecycle VU đơn giản hơn `ramping-vus` vì
không có scale up/down giữa runtime.

#### 3.9.1. Lifecycle đầy đủ

```text
1) Init phase     : k6 init đủ vus instance vào pool
                    mỗi instance đã có JS context, sandbox, biến module-scope
                    chạy file-level code (import, biến module-scope)

2) Run() start    : for range numVUs gọi GetPlannedVU(true) đúng vus lần
                    pull đủ vus instance ra khỏi pool
                    mỗi instance: go handleVU(initVU)

3) handleVU loop  : Activate() -> for {...} -> lấy iter -> runIteration -> ...
                    loop này chạy tới khi:
                      a) attemptedIterNumber > totalIters (hết kho)
                      b) regDurationDone (hết maxDuration)

4) handleVU end   : defer cancel() -> ReturnVU(initVU, true)
                    instance trở lại pool clean
                    activeVUs.Done() -> WaitGroup giảm

5) Scenario end   : activeVUs.Wait() chờ tất cả goroutine return
                    nếu attemptedIters < totalIters: emit DroppedIterations
```

Đọc từ core:

```text
shared_iterations.go:264-272  Run(): pull đủ vus và bắn goroutine
shared_iterations.go:239-262  handleVU(): vòng lặp lấy iter
shared_iterations.go:234-237  returnVU: ReturnVU(initVU, true)
shared_iterations.go:217-229  defer activeVUs.Wait + emit DroppedIterations
```

#### 3.9.2. `__ITER` counter

`__ITER` là counter của từng VU, đếm số iter VU đó đã chạy. Trong
`shared-iterations`:

```text
- __ITER bắt đầu từ 0 cho mỗi VU
- mỗi iter VU đó chạy xong -> __ITER += 1
- KHÔNG đồng bộ với attemptedIterNumber (số iter toàn scenario)
```

Quan trọng: `__ITER != attemptedIterNumber`. Hai khái niệm khác nhau:

```text
__ITER (per-VU)              : số iter VU này đã chạy
attemptedIterNumber (global) : số thứ tự iter trong kho chung
                              (dùng để biết hết kho hay chưa)
```

Ví dụ với `vus=2, iterations=4`:

```text
t=0     VU=1: attempt=1, __ITER=0
        VU=2: attempt=2, __ITER=0

t=Δ     VU=1 finish, __ITER=0 emit
        VU=1 next: attempt=3, __ITER=1
        VU=2 finish, __ITER=0 emit
        VU=2 next: attempt=4, __ITER=1

t=2Δ    VU=1 finish, __ITER=1 emit
        VU=1 next: attempt=5, > 4 -> return
        VU=2 finish, __ITER=1 emit
        VU=2 next: attempt=6, > 4 -> return

Per VU: VU=1 chạy __ITER=0,1 (2 iter)
        VU=2 chạy __ITER=0,1 (2 iter)
Total: 4 iter complete (giống iterations config)
```

#### 3.9.3. Khi VU nhanh/chậm khác nhau

Nếu VU=1 chạy nhanh (sleep 0.2s), VU=2 chạy chậm (sleep 0.6s):

```text
vus=2, iterations=8

t=0     VU=1: attempt=1, __ITER=0 (sleep 0.2)
        VU=2: attempt=2, __ITER=0 (sleep 0.6)
t=0.2   VU=1 finish, attempt=3, __ITER=1
t=0.4   VU=1 finish, attempt=4, __ITER=2
t=0.6   VU=1 finish, attempt=5, __ITER=3
        VU=2 finish, attempt=6, __ITER=1
t=0.8   VU=1 finish, attempt=7, __ITER=4
t=1.0   VU=1 finish, attempt=8, __ITER=5
t=1.2   VU=1 finish, attempt=9 > 8 -> return
        VU=2 finish, attempt=10 > 8 -> return

VU=1 chạy 6 iter (__ITER=0..5)
VU=2 chạy 2 iter (__ITER=0,1)
Total: 8 (khớp iterations)
```

VU nhanh chiếm phần lớn iter — đây là đặc trưng "không công bằng" của
`shared-iterations`.

#### 3.9.4. ReturnVU và pool

`returnVU` ở `shared_iterations.go:234-237`:

```go
returnVU := func(u lib.InitializedVU) {
    si.executionState.ReturnVU(u, true)
    activeVUs.Done()
}
```

`ReturnVU(initVU, true)` — flag `true` nghĩa là "decrease counter của full
iterations". Với `shared-iterations` chỉ có 1 lần activate ở đầu, returnVU
chỉ chạy đúng 1 lần khi VU goroutine thoát (qua `defer cancel()` trong
`Activate()`).

VU instance sau khi `ReturnVU` quay về pool. Vì scenario đã kết thúc
(`handleVU` trả về), không có scenario khác trong cùng test cũng có thể
lấy VU này ra dùng tiếp (nếu cấu hình đa scenario).

#### 3.9.5. Khác `ramping-vus`

| Tiêu chí | `shared-iterations` | `ramping-vus` |
| --- | --- | --- |
| VU activate | 1 lần ở đầu Run() | nhiều lần theo timeline |
| VU return | 1 lần khi handleVU exit | nhiều lần khi scale-down |
| state machine vuHandle | không dùng | dùng (start/stop/hardStop) |
| `__ITER` reset | không (mỗi VU 1 lần activate) | không (qua nhiều activate vẫn giữ) |
| iter dropped | có (kho không lấy hết) | không |
| iter interrupted | có (gracefulStop=0 hoặc iter dài) | có (gracefulRampDown=0 hoặc iter dài) |

## 4. Khác gì với `per-vu-iterations`?

| Điểm so sánh | `shared-iterations` | `per-vu-iterations` |
| --- | --- | --- |
| `iterations` nghĩa là gì? | tổng toàn scenario | số vòng mỗi VU |
| VU nhanh xong sớm | lấy thêm iteration mới | idle |
| Work chia cho VU | không cố định | cố định bằng nhau |
| Tổng iterations | `iterations` | `vus * iterations` |
| Hợp với | fixed total work | fixed work per user |

Ví dụ:

```text
vus = 4
iterations = 12
```

Với `shared-iterations`:

```text
tổng toàn test = 12 iterations
4 VU chia nhau 12 iterations
```

Với `per-vu-iterations`:

```text
mỗi VU chạy 12 iterations
tổng toàn test = 4 * 12 = 48 iterations
```

## 5. Demo phân phối iteration

File:

```text
examples/shared_iterations_distribution_demo.js
```

Command:

```bash
k6 run examples/shared_iterations_distribution_demo.js
```

Config:

```text
vus = 4
iterations = 12
VU 1 sleep 0.2s
VU 2/3/4 sleep 0.6s
```

Output chính:

```text
scenarios:
  * shared_distribution: 12 iterations shared among 4 VUs

iteration_duration...: avg=400.58ms min=200.28ms med=400.75ms max=600.77ms
iterations...........: 12  9.968166/s
vus..................: 4   min=4      max=4
vus_max..............: 4   min=4      max=4
```

Từ log:

```text
VU 1 chạy __ITER=0..5  => 6 iterations
VU 2 chạy __ITER=0..1  => 2 iterations
VU 3 chạy __ITER=0..1  => 2 iterations
VU 4 chạy __ITER=0..1  => 2 iterations
```

Tổng:

```text
6 + 2 + 2 + 2 = 12
```

Đây là bằng chứng trực quan:

```text
shared-iterations không chia đều iteration cho từng VU
VU nhanh lấy thêm việc từ kho iteration chung của scenario
```

Tự tính `iteration_duration avg`:

```text
6 iterations nhanh * 0.2s = 1.2s
6 iterations chậm * 0.6s = 3.6s

avg = (1.2 + 3.6) / 12
    = 4.8 / 12
    = 0.4s
    = 400ms
```

Khớp:

```text
iteration_duration avg=400.58ms
```

### 5.1. Demo đếm từng VU nhanh/chậm

File:

```text
examples/shared_iterations_vu_speed_count_demo.js
```

Command:

```bash
k6 run examples/shared_iterations_vu_speed_count_demo.js
```

Nếu chỉ muốn lọc log đếm VU trên PowerShell:

```powershell
k6 run examples/shared_iterations_vu_speed_count_demo.js 2>&1 | Select-String "vu-progress"
```

Config:

```text
executor = shared-iterations
vus = 4
iterations = 16

VU 1 sleep 0.2s
VU 2 sleep 0.4s
VU 3 sleep 0.8s
VU 4 sleep 0.8s
```

Tốc độ lý thuyết của từng VU nếu chỉ tính theo `sleep`:

```text
VU 1: 1 / 0.2s = 5.00 iter/s
VU 2: 1 / 0.4s = 2.50 iter/s
VU 3: 1 / 0.8s = 1.25 iter/s
VU 4: 1 / 0.8s = 1.25 iter/s

tổng khi cả 4 VU cùng active
  = 5 + 2.5 + 1.25 + 1.25
  = 10 iter/s
```

Output summary đã chạy:

```text
iteration_duration...: avg=400.43ms min=200.08ms med=300.5ms max=800.96ms p(90)=800.67ms p(95)=800.96ms
iterations...........: 16  9.985117/s
vus..................: 4   min=4      max=4
vus_max..............: 4   min=4      max=4

running (01.6s), 0/4 VUs, 16 complete and 0 interrupted iterations
```

Từ log cuối của từng VU:

```text
VU 1 iterationsSoFar=8 delay=0.2s
VU 2 iterationsSoFar=4 delay=0.4s
VU 3 iterationsSoFar=2 delay=0.8s
VU 4 iterationsSoFar=2 delay=0.8s
```

Tổng:

```text
8 + 4 + 2 + 2 = 16
```

Vậy trong `shared-iterations`, câu hỏi "1 VU chạy được bao nhiêu iteration" phải tách làm hai ý:

```text
1. VU đó chạy nhanh hay chậm?
   đo bằng iteration_duration hoặc tự biết trong code:
   per_vu_rate_i ≈ 1 / t_i

2. VU đó thực tế nhận được bao nhiêu iteration từ kho iteration chung của scenario?
   đo bằng log __VU và __ITER:
   iterations_per_vu_i = __ITER cuối cùng của VU đó + 1
```

Trong demo này:

```text
VU 1:
  t_1 = 0.2s
  per_vu_rate_1 ≈ 5 iter/s
  iterations_per_vu_1 = 8

VU 2:
  t_2 = 0.4s
  per_vu_rate_2 ≈ 2.5 iter/s
  iterations_per_vu_2 = 4

VU 3:
  t_3 = 0.8s
  per_vu_rate_3 ≈ 1.25 iter/s
  iterations_per_vu_3 = 2

VU 4:
  t_4 = 0.8s
  per_vu_rate_4 ≈ 1.25 iter/s
  iterations_per_vu_4 = 2
```

`iteration_duration avg` cũng tự kiểm tra được:

```text
8 * 0.2s = 1.6s
4 * 0.4s = 1.6s
2 * 0.8s = 1.6s
2 * 0.8s = 1.6s

avg = (1.6 + 1.6 + 1.6 + 1.6) / 16
    = 6.4 / 16
    = 0.4s
    = 400ms
```

Khớp summary:

```text
iteration_duration avg=400.43ms
```

Và tốc độ toàn scenario:

```text
iterations/s
  = completed_iterations / summary_runtime_base
  = 16 / 1.602s
  ≈ 9.985 iter/s
```

Con số này gần bằng tổng tốc độ lý thuyết khi cả 4 VU đều active:

```text
5 + 2.5 + 1.25 + 1.25 = 10 iter/s
```

Cần nhớ:

```text
__ITER là counter riêng của từng VU
iterationInScenario là số thứ tự iteration toàn scenario
log có thể không theo thứ tự 0,1,2,3 vì các VU chạy song song
```

## 6. Edge case của `shared-iterations`

Phần này tổng hợp các tình huống đặc thù riêng của executor này, không gặp
ở `ramping-vus`/`constant-vus`.

### 6.1. Khi `iterations < vus`?

Validate ở `shared_iterations.go:82-87`:

```go
if sic.Iterations.Int64 < sic.VUs.Int64 {
    errors = append(errors, fmt.Errorf(
        "the number of iterations (%d) can't be less than the number of VUs (%d)",
        sic.Iterations.Int64, sic.VUs.Int64,
    ))
}
```

Nghĩa là config sau sẽ **fail validate**:

```js
scenarios: {
  invalid: {
    executor: "shared-iterations",
    vus: 5,
    iterations: 3,    // < vus -> error
  },
}
```

Output thực tế:

```text
the number of iterations (3) can't be less than the number of VUs (5)
```

Vì sao bắt buộc `iterations >= vus`?

```text
- nếu iterations < vus, một số VU sẽ không có iter nào để chạy
  -> tốn tài nguyên init VU mà không dùng
- design intent: mỗi VU ít nhất 1 iter
- nếu thật sự muốn ít iter hơn vus, giảm vus xuống
```

#### Nếu `iterations == vus`?

Hợp lệ. Mỗi VU chạy đúng 1 iter:

```js
vus: 4, iterations: 4
```

Timeline:

```text
t=0    4 VU activate, đồng loạt vào iter
       attemptedIters = 1, 2, 3, 4
t=Δ    4 VU finish iter
       attemptedIterNumber = 5, 6, 7, 8 -> đều > 4 -> return
       4 VU đều dừng

Total: 4 complete, 0 dropped
```

Trường hợp này tương đương `vus * 1 = 4` total iter, mỗi VU đúng 1 vòng.
Không nhanh hơn `per-vu-iterations: vus=4, iterations=1` về số iter, nhưng
vẫn khác về cơ chế lấy iter (atomic counter vs quota cố định).

### 6.2. Khi VU chậm hơn nhiều thì phân phối ra sao?

Đây là đặc trưng "atomic counter" của `shared-iterations`. Nếu các VU có
tốc độ khác nhau lớn, phân phối iter sẽ không đều.

#### 6.2.1. Mô hình phân phối

Với `vus=N` VU có thời gian iter `t_1, t_2, ..., t_N`:

```text
ratio_i = (1/t_i) / sum(1/t_j)
        = tốc độ VU i / tổng tốc độ

iterations_per_vu_i ≈ ratio_i * total_iterations
```

Ví dụ:

```text
vus=4, iterations=16
t_1=0.2s, t_2=0.4s, t_3=0.8s, t_4=0.8s

rate_1 = 5,    rate_2 = 2.5,  rate_3 = 1.25, rate_4 = 1.25
total_rate = 10

ratio_1 = 0.5,  ratio_2 = 0.25, ratio_3 = 0.125, ratio_4 = 0.125

iter_1 ≈ 0.5  * 16 = 8
iter_2 ≈ 0.25 * 16 = 4
iter_3 ≈ 0.125 * 16 = 2
iter_4 ≈ 0.125 * 16 = 2

total = 8 + 4 + 2 + 2 = 16 ✓
```

Khớp với output thực tế trong [demo 5.1](#51-demo-đếm-từng-vu-nhanhchậm).

#### 6.2.2. Khi 1 VU rất chậm (outlier)

Nếu 1 VU bị "stuck" (network slow, timeout, deadlock JS), VU đó vẫn được
phép chạy. VU khác lấy thêm iter bù.

Ví dụ:

```text
vus=4, iterations=20
t_1 = t_2 = t_3 = 0.1s
t_4 = 5s (rất chậm, outlier)

rate_1 = rate_2 = rate_3 = 10
rate_4 = 0.2
total_rate = 30.2

iter_1 ≈ iter_2 ≈ iter_3 ≈ 6.62
iter_4 ≈ 0.13

iter_1, iter_2, iter_3 dồn lại = ~19.86
iter_4 ≈ 0 (gần như không lấy được)

actual: iter_1=7, iter_2=7, iter_3=6, iter_4=0  (tổng 20)
```

VU=4 có thể chỉ chạy 0-1 iter vì các VU nhanh đã "ăn" hết kho. Đây không
phải bug, mà là consequence của design "first come first served" qua atomic
counter.

#### 6.2.3. Khi muốn fairness?

`shared-iterations` không có cơ chế fairness. Nếu cần:

```text
- per-vu-iterations: mỗi VU đúng N iter, không phụ thuộc tốc độ
- ramping-arrival-rate: scheduler ép tốc độ, VU chia đều iter theo time
```

### 6.3. Hành vi khi iteration count nhỏ hơn maxDuration cho phép

Hai trường hợp ngược nhau cần phân biệt:

```text
Case A: iter time * iter count << maxDuration
        -> scenario kết thúc sớm trước maxDuration
        -> không có dropped, không có interrupted

Case B: iter time * iter count >> maxDuration
        -> scenario hit maxDuration trước khi xong kho
        -> có dropped, có thể có interrupted
```

#### 6.3.1. Case A: kho cạn trước `maxDuration`

Config:

```js
vus: 4,
iterations: 12,
maxDuration: "10m",     // rất rộng
gracefulStop: "30s",

// code: sleep(0.5)
```

Timeline:

```text
t=0       4 VU activate, lấy iter
t=0.5s    4 VU finish, lấy tiếp (kho còn 4)
t=1.0s    4 VU finish, lấy tiếp (kho còn 0)
          attemptedIterNumber = 9,10,11,12
t=1.5s    4 VU finish, lấy tiếp (đã có atomic.AddUint64)
          attemptedIterNumber = 13,14,15,16 đều > 12 -> return

t=1.5s    activeVUs.Wait() trả về ngay (4 goroutine đã return)
          attemptedIters = 16, totalIters = 12
          attemptedIters > totalIters -> không emit DroppedIterations
          (defer block check `attemptedIters < totalIters`, không thỏa)

scenario summary:
  iterations          = 12 (complete)
  dropped_iterations  = 0
  interrupted         = 0
  duration            ≈ 1.5s (nhỏ hơn maxDuration nhiều)
```

Header in:

```text
* demo: 12 iterations shared among 4 VUs (maxDuration: 10m)
```

Nghĩa là `maxDuration` là **trần**, không phải target. Nếu xong sớm thì
scenario kết thúc ngay, không chờ tới `maxDuration`.

#### 6.3.2. Case B: hit `maxDuration` trước khi cạn kho

Config:

```js
vus: 4,
iterations: 1000,        // rất nhiều
maxDuration: "5s",
gracefulStop: "2s",

// code: sleep(0.5)
```

Tính:

```text
peak_rate = vus / iter_time = 4 / 0.5 = 8 iter/s
expected_iter_at_maxDuration = 8 * 5 = 40 iter
expected_iter_in_grace = 8 * 2 = 16 iter (nhưng chỉ tính iter đã start trước maxDuration)
```

Timeline:

```text
t=0..5s   4 VU loop iter, mỗi iter 0.5s
          tổng ~ 40 iter complete
t=5s      regDurationCtx done -> không lấy iter mới
          các iter đang chạy (đã started ngay trước t=5s) tiếp tục
t=5..5.5s iter cuối finish, vòng for tiếp: regDurationDone -> return
t=5.5s    handleVU exit, ReturnVU

scenario summary:
  iterations          ≈ 40-44 (complete)
  attemptedIters      ≈ 40-44 (số iter đã lấy trước hết)
  dropped_iterations  = 1000 - attemptedIters ≈ 956-960
  interrupted         = 0
  duration            ≈ 5-5.5s
```

Vì `iter_time` (0.5s) << `gracefulStop` (2s), iter đang chạy đều finish
clean trong grace, không có interrupted.

#### 6.3.3. Case C: iter dài, hit `maxDuration` rất chát

Config:

```js
vus: 4,
iterations: 1000,
maxDuration: "5s",
gracefulStop: "1s",

// code: sleep(3)    iter rất dài
```

Timeline:

```text
t=0       4 VU vào iter (đến t=3s)
t=3s      4 VU finish, lấy tiếp iter (sẽ đến t=6s)
          attemptedIterNumber = 5, 6, 7, 8
t=5s      regDurationCtx done
          4 VU đang ở iter (đã 2s, còn 1s)
          gracefulStop = 1s -> grace tới t=6s
t=6s      grace hết, maxDurationCtx cancel
          4 VU đang chạy: tùy race, có thể finish ngay (nếu iter đã 3s đúng) hoặc bị interrupt

worst case:
  iterations         = 4 (chỉ vòng đầu finish)
  interrupted        = 4 (iter#1 bị cắt giữa)
  attemptedIters     = 8
  dropped_iterations = 1000 - 8 = 992
```

`shared-iterations` cho phép scenario kết thúc theo 1 trong 4 cách:

```text
1) Kho cạn trước maxDuration (case A)
   -> iterations = config iterations
   -> dropped = 0

2) Hit maxDuration, iter time ngắn (case B)
   -> iterations < config iterations
   -> dropped = config iterations - attemptedIters
   -> interrupted = 0

3) Hit maxDuration, iter time vừa grace (case B với edge race)
   -> iterations vẫn < config
   -> dropped = config - attemptedIters
   -> interrupted có thể = 0 hoặc > 0 tùy race

4) Hit maxDuration, iter time > grace (case C)
   -> iterations rất nhỏ
   -> dropped lớn
   -> interrupted = số VU đang ở iter dở
```

### 6.4. Khi nào `dropped_iterations` thật sự xảy ra?

Đọc `shared_iterations.go:217-229`:

```go
defer func() {
    activeVUs.Wait()
    if attemptedIters < totalIters {
        metrics.PushIfNotDone(parentCtx, out, metrics.Sample{
            ...
            Value: float64(totalIters - attemptedIters),
            ...
        })
    }
}()
```

Quan trọng:

```text
DroppedIterations = totalIters - attemptedIters

điều kiện: attemptedIters < totalIters
```

Nghĩa là drop chỉ xảy ra khi:

```text
- atomic counter chưa từng lấy đủ totalIters lần
- = số iter trong kho chưa được "claim" hết
```

Note tinh tế:

```text
attemptedIters tăng KHI atomic.AddUint64 trả số > totalIters
nhưng vòng for return ngay sau đó, không gọi runIteration

ví dụ: totalIters=10, vus=4
  4 VU lấy đến số 11, 12, 13, 14 thì các số đó vẫn được tăng
  nhưng > totalIters nên return
  attemptedIters cuối có thể là 14, không phải 10
  -> attemptedIters > totalIters -> không emit DroppedIterations
```

Vì vậy `dropped_iterations` chỉ là **số iter còn trong kho chưa được VU lấy
đến**, không phải "số iter VU bỏ sót khi return".

#### Khi nào KHÔNG có drop?

```text
- kho cạn trước maxDuration                    -> attemptedIters >= totalIters
- iterations == vus, mọi VU finish iter đầu    -> attemptedIters = vus + 1 (cho lần > totalIters)
                                                  > totalIters -> không drop
```

#### Khi nào CÓ drop?

```text
- hit maxDuration trước khi VU lấy hết kho
- VU chạy rất chậm so với maxDuration
- gracefulStop quá ngắn so với iter time, một số VU bị interrupt
  (nhưng interrupted iter vẫn đếm vào attemptedIters,
   nên drop chỉ là phần kho chưa lấy)
```

### 6.5. `interrupted` vs `dropped` — phân biệt

Hai metric khác nhau, đừng nhầm:

| Metric | Khi nào tăng | Đếm cái gì |
| --- | --- | --- |
| `iterations` (full) | iter chạy xong và emit `AddFullIterations(1)` | iter complete |
| `interrupted_iterations` | iter đã start nhưng context cancel trước khi finish | iter đang chạy bị cắt |
| `dropped_iterations` | scenario kết thúc, kho còn iter chưa lấy | iter chưa từng start |

Quan hệ:

```text
attemptedIters     = iterations + interrupted_iterations + (iter quá totalIters do race)
dropped_iterations = totalIters - attemptedIters (nếu < 0 thì = 0, không emit)
```

Trong demo `shared_iterations_dropped_demo.js`:

```text
config: vus=2, iterations=5, maxDuration=3s, gracefulStop=2s, sleep(2)

t=0       VU=1 attempt=1, VU=2 attempt=2 (vào iter)
t=2s      cả 2 finish, attempt=3,4 (vào iter, sẽ đến t=4s)
t=3s      maxDuration hết, không lấy iter mới
          2 VU đang ở iter (đã 1s, còn 1s)
t=4s      2 VU finish iter (1s qua < grace 2s, finish clean)
          vòng for: regDurationDone -> return

iterations        = 4 (complete)
interrupted       = 0
attemptedIters    = 4
dropped           = 5 - 4 = 1
```

Output thực tế khớp với phân tích.

### 6.6. Tổng hợp công thức

```text
peak_rate     ≈ vus / effective_iteration_time

iter_per_vu_i ≈ (1/t_i) / sum(1/t_j) * totalIters
              (khi sum đủ thời gian cho cạn kho)

scenario_runtime ≈ totalIters / peak_rate
                  (clean run, không hit maxDuration)

scenario_runtime ≤ maxDuration + gracefulStop  (luôn đúng)

dropped = max(0, totalIters - attemptedIters)
        ≈ max(0, totalIters - peak_rate * maxDuration)  (khi hit maxDuration)
```

## 7. Demo QuickPizza `2 requests / iteration`

File:

```text
examples/shared_iterations_quickpizza_two_requests_demo.js
```

Command:

```bash
k6 run examples/shared_iterations_quickpizza_two_requests_demo.js
```

Config:

```text
vus = 4
iterations = 12
1 iteration = 2 HTTP requests + 2 checks + sleep(1)
```

Worked example riêng:

```text
docs/20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md
```

Output chính:

```text
checks_total.......: 24      4.634551/s
http_reqs..........: 24      4.634551/s
iteration_duration.: avg=1.72s min=1.5s med=1.5s max=2.15s
iterations.........: 12      2.317275/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4
```

Suy ra:

```text
total_iterations = 12
http_requests_per_iteration = 2
total_http_requests = 12 * 2 = 24
checks_per_iteration = 2
total_checks = 12 * 2 = 24

summary_runtime_base
  = 12 / 2.317275
  ≈ 5.1785s

average_total_rate
  = completed_iterations / summary_runtime_base
  = 12 / 5.1785
  ≈ 2.317275 iter/s

per_vu_rate
  ≈ 1 / effective_iteration_time

peak_total_rate
  ≈ active_vus * per_vu_rate

Không lấy:

summary iterations/s rồi nhân thêm vus

vì summary iterations/s đã là average_total_rate của toàn scenario.

http_reqs/s
  = 24 / 5.1785
  ≈ 4.634551/s

per_vu_rate_avg
  ≈ 1 / effective_iteration_time_avg
  ≈ 1 / 1.72
  ≈ 0.58 iter/s

estimated_total_rate_from_avg
  ≈ 4 * 0.58
  ≈ 2.32 iter/s
```

Ghi chú:

```text
per_vu_rate tính được từ iteration_duration trong run không có minIterationDuration
nhưng mỗi VU thực tế chạy bao nhiêu iteration thì không cố định
muốn biết phải log theo __VU / __ITER / iterInScenario
```

## 8. Cheat sheet — Công thức cần nhớ nhất

> Phần này dành cho người mới. Mỗi công thức có **tên tiếng Việt**, ví dụ
> đời thường, và "khi nào dùng". Đọc xong section này là dùng được ngay
> mà không cần đọc Section 3 chi tiết.

### 8.0. Config chung của `shared-iterations`

Đây là **bộ config đầy đủ** cho executor `shared-iterations`. Đọc bảng
này trước khi viết test, biết tham số nào BẮT BUỘC, tham số nào có default.

#### Template config đầy đủ

```js
export const options = {
  scenarios: {
    my_scenario: {
      // === BẮT BUỘC ===
      executor: "shared-iterations",  // tên executor
      vus: 4,                         // số VU cùng chia kho iter
      iterations: 20,                 // tổng iter chung của scenario

      // === TUỲ CHỌN (có default) ===
      maxDuration: "10m",             // default = "10m" (trần wall-clock)
      gracefulStop: "30s",            // default = "30s" (từ BaseConfig)
      startTime: "0s",                // default = "0s"
      exec: "default",                // default = "default" function
      tags: { test: "demo" },         // default = {}
      env: { DEBUG: "1" },            // default = {}
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
| `executor` | **BẮT BUỘC** | — | string | Phải đặt là `"shared-iterations"` |
| `vus` | **BẮT BUỘC** | — | int | Số VU cùng chia kho iteration |
| `iterations` | **BẮT BUỘC** | — | int | Tổng iter chung scenario phải chạy |
| `maxDuration` | tuỳ chọn | `"10m"` | duration | Trần wall-clock cho scenario |
| `gracefulStop` | tuỳ chọn | `"30s"` | duration | Grace cuối scenario cho iter đang chạy |
| `startTime` | tuỳ chọn | `"0s"` | duration | Trễ trước khi scenario bắt đầu |
| `exec` | tuỳ chọn | `"default"` | string | Tên function JS chạy mỗi iter |
| `tags` | tuỳ chọn | `{}` | object | Tag attach vào metric của scenario |
| `env` | tuỳ chọn | `{}` | object | Biến môi trường riêng cho scenario |

> Lưu ý: `vus` và `iterations` mặc định là `1` trong code (xem
> `shared_iterations.go:44-45`), nhưng đều có flag `false` (chưa set).
> Nếu thiếu thì k6 dùng `1, 1` — vẫn chạy được, nhưng test 1 iter, 1 VU
> không có ý nghĩa, nên coi như BẮT BUỘC phải khai báo.

#### 3 quy tắc validate (đọc từ core)

```text
1. vus phải > 0
   (nếu <= 0: lỗi "the number of VUs must be more than 0")

2. iterations phải >= vus
   (nếu nhỏ hơn: lỗi "the number of iterations (X) can't be less than
    the number of VUs (Y)")

3. maxDuration >= 1s
   (nếu < 1s: lỗi "the maxDuration must be at least 1s, but is ...")
```

Code ref: `shared_iterations.go:76-96` (function `Validate()`).

> Vì sao `iterations >= vus`? Vì mỗi VU phải có ít nhất 1 iter để làm,
> nếu `iterations < vus` thì có VU không có việc -> vô nghĩa, fail
> validate ngay.

#### Config tối thiểu (chạy được)

Nếu chỉ muốn config gọn nhất:

```js
export const options = {
  scenarios: {
    minimal: {
      executor: "shared-iterations",
      vus: 4,
      iterations: 20,
    },
  },
};
```

4 dòng đủ chạy. `maxDuration` (10m) và `gracefulStop` (30s) lấy default.

#### `startTime` — không phải để chờ VU init

Câu hỏi hay gặp:

```text
nếu set vus=4000, có cần set startTime="30s" để k6 kịp init 4000 VU không?
```

**Trả lời ngắn: Không cần.** `startTime` không liên quan gì tới việc init VU cả.

##### Hai phase tách biệt trong core

k6 chia đời sống test làm 2 phase rõ ràng. Đọc từ `execution.go:88-89`:

```go
// Planned VUs are initialized before a test begins, while
// unplanned VUS can be initialized in the middle of the test run
```

Và comment trong `GetExecutionRequirements()` của `shared_iterations.go:99`:

```go
// executor for its whole duration (disregarding any startTime)
```

Nghĩa là **dù `startTime` là bao nhiêu, planned VUs vẫn được reserve từ đầu test, trước khi đồng hồ chạy**.

Luồng thật:

```text
╔═══════════════════════════════════════════════════════════════╗
║ PHASE 1 — INIT (trước khi đồng hồ test chạy)                  ║
║                                                               ║
║  Scheduler đọc GetExecutionRequirements() của TẤT CẢ scenario ║
║  ├── shared-iterations: PlannedVUs = 4000 tại TimeOffset = 0  ║
║  ├── Init đủ 4000 JS context vào pool                         ║
║  └── Phase này xong thì mới sang phase 2                      ║
║                                                               ║
║  → Wall-clock có thể mất vài giây, nhưng đồng hồ test CHƯA    ║
║    chạy. maxDuration chưa bắt đầu đếm.                        ║
╚═══════════════════════════════════════════════════════════════╝
                          ↓
╔═══════════════════════════════════════════════════════════════╗
║ PHASE 2 — EXECUTION (đồng hồ test bắt đầu từ t=0)             ║
║                                                               ║
║  Scheduler chờ tới startTime của từng scenario rồi gọi Run(): ║
║  ├── startTime="0s"  → Run() gọi ngay tại t=0                 ║
║  ├── startTime="30s" → Run() gọi tại t=30s                    ║
║  └── Lúc Run() chạy: 4000 VU đã sẵn trong pool từ phase 1 rồi ║
║                                                               ║
║  Run() gọi GetPlannedVU() đúng vus lần → bắn goroutine        ║
║  → Đồng hồ maxDuration bắt đầu từ lúc Run() chạy              ║
╚═══════════════════════════════════════════════════════════════╝
```

##### `startTime` thật sự dùng để làm gì?

`startTime` dùng để **stagger (rải) thời điểm bắt đầu giữa nhiều scenario** trong cùng 1 test:

```js
export const options = {
  scenarios: {
    warm_up: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 100,
      startTime: "0s",     // chạy ngay
    },
    main_load: {
      executor: "shared-iterations",
      vus: 100,
      iterations: 1000,
      startTime: "30s",    // đợi warm_up xong rồi mới bắt đầu
    },
  },
};
```

Không có `startTime`, cả 2 scenario cùng bắt đầu tại t=0.

##### Chứng minh bằng core

`GetExecutionRequirements()` trong `shared_iterations.go:103-124`:

```go
return []lib.ExecutionStep{
    {TimeOffset: 0, PlannedVUs: uint64(vus)},
    {TimeOffset: maxDuration + gracefulStop, PlannedVUs: 0},
}
```

Hàm này **không nhận `startTime` làm tham số**. Nó luôn trả về `TimeOffset: 0` cho step đầu tiên. `startTime` được scheduler xử lý riêng ở tầng trên — nó chỉ delay lúc gọi `Run()`, không delay lúc init VU.

##### Điểm dễ nhầm

```text
SAI: "startTime để cho VU kịp init"
ĐÚNG: "VU init xong hết trước khi test chạy, startTime chỉ để stagger scenario"

SAI: "set startTime=30s để 4000 VU init xong"
ĐÚNG: "không cần startTime, scheduler tự lo init, startTime=0s vẫn đủ 4000 VU"

SAI: "startTime càng lớn thì VU init càng nhiều"
ĐÚNG: "số VU init = vus config, không phụ thuộc startTime"
```

##### Vậy với 4000 VU có cần lo gì không?

Có 1 thứ cần lo, nhưng **không liên quan `startTime`**:

```text
THỜI GIAN INIT (wall-clock thật):
  - Diễn ra ở phase 1, trước khi test bắt đầu
  - Có thể mất vài giây đến vài chục giây (tùy code JS nặng/nhẹ)
  - Nhưng đồng hồ test chưa chạy, maxDuration không bị ảnh hưởng

RAM:
  - 4000 VU = 4000 JS context
  - Mỗi context tốn vài MB → có thể tốn 8-16GB RAM
  - Đây là giới hạn thật sự, không phải timing
```

##### Tóm tắt 1 dòng

```text
startTime = "thời điểm bắt đầu chạy scenario" chứ không phải "thời gian chờ VU init"
```

### 8.1. 5 công thức TOP cần thuộc lòng

> **Đọc trước khi dùng**: 5 công thức này xếp theo thứ tự logic —
> từ chi tiết (từng VU) đến tổng thể (toàn scenario), từ dự đoán
> (ước lượng trước run) đến chẩn đoán (đọc output sau run). Mỗi công
> thức có **tên tiếng Việt**, **ví dụ đời thường**, **phân tích từng
> bước**, **kết nối với công thức khác**, và **cách verify với
> output thật**.

#### Công thức 1: "Chia kho thế nào?" (Phân phối iter giữa các VU)

```text
ratio_i = (1/t_i) / Σ(1/t_j)
iterations_per_vu_i ≈ ratio_i × iterations
```

**Tiếng Việt**: "Tỷ lệ iter VU thứ i nhận = (1 chia thời gian 1 iter của
VU đó) chia cho (tổng 1/thời gian của tất cả VU)". VU nhanh nhận nhiều,
VU chậm nhận ít.

##### Thay số vào công thức

Lấy demo 3 VU: VU0 `sleep(1)`, VU1 `sleep(2)`, VU2 `sleep(3)`, tổng
`iterations = 90`.

**Trong demo này, `t_i` lấy từ đâu?**

```text
Demo CỐ Ý cho mỗi VU sleep khác nhau dựa trên __VU:

  const delays = { 1: 1.0, 2: 2.0, 3: 3.0 };
  sleep(delays[__VU]);

→ t_0 = 1.0s (VU số 1, __VU=1)
→ t_1 = 2.0s (VU số 2, __VU=2)
→ t_2 = 3.0s (VU số 3, __VU=3)

→ ĐÂY LÀ DEMO NHÂN TẠO, con số biết trước vì chính mình code sleep().
```

**Trong test THẬT (HTTP), `t_i` lấy từ đâu?**

```text
Trong test thật, bạn KHÔNG biết trước iter_time. Bạn PHẢI ĐO:

Cách 1 — Đọc iteration_duration từ summary (gộp chung tất cả VU):
  iteration_duration...: avg=200ms min=150ms med=190ms max=350ms

  → avg=200ms là trung bình của TẤT CẢ iter, TẤT CẢ VU
  → Nếu các VU cùng code, cùng server, avg này đại diện được
  → Dùng avg làm t_i chung cho mọi VU: t_0 = t_1 = t_2 ≈ 200ms
  → Lúc này Công thức 1 ≈ Công thức 5 (vì các t_i bằng nhau)

Cách 2 — Tự log per-VU iteration_duration:
  export default function () {
    let start = Date.now();
    // ... code ...
    let duration = Date.now() - start;
    console.log(`VU=${__VU} iter=${__ITER} duration=${duration}ms`);
  }

  → Chạy test, gom log theo __VU, tính avg duration cho từng VU
  → Đây là cách có t_0, t_1, t_2 CHÍNH XÁC cho Công thức 1

Cách 3 — Suy ngược từ output (khi đã biết iterations_per_vu_i):
  Nếu output cho thấy VU0=49 iter, VU1=25 iter, VU2=16 iter:
    ratio_0 = 49/90 = 0.544
    ratio_1 = 25/90 = 0.278
    ratio_2 = 16/90 = 0.178

    → 1/t_0 : 1/t_1 : 1/t_2 = 0.544 : 0.278 : 0.178
    → t_0 : t_1 : t_2 ≈ 1 : 2 : 3
    → VU1 chậm gấp 2 VU0, VU2 chậm gấp 3 VU0
```

**Quay lại demo với số đã biết:**

```text
Cho:  t_0 = 1.0s,  t_1 = 2.0s,  t_2 = 3.0s
      iterations = 90

────────────────────────────────────────────────────────────
VU0 (nhanh nhất):

           1/t_0               1/1.0
  ratio₀ = ────────  =  ───────────────────
           Σ(1/t_j)      1/1.0 + 1/2.0 + 1/3.0

            1.000             1.000
          = ─────  =  ───────────────────
            1.833       1.000 + 0.500 + 0.333

          = 0.546  →  54.6%

  iter_VU0 = ratio₀ × iterations
           = 0.546 × 90
           = 49.1
           ≈ 49 iter

────────────────────────────────────────────────────────────
VU1 (vừa):

           1/t_1               1/2.0
  ratio₁ = ────────  =  ───────────────────
           Σ(1/t_j)      1/1.0 + 1/2.0 + 1/3.0

            0.500
          = ─────
            1.833

          = 0.273  →  27.3%

  iter_VU1 = 0.273 × 90
           = 24.6
           ≈ 25 iter

────────────────────────────────────────────────────────────
VU2 (chậm nhất):

           1/t_2               1/3.0
  ratio₂ = ────────  =  ───────────────────
           Σ(1/t_j)      1/1.0 + 1/2.0 + 1/3.0

            0.333
          = ─────
            1.833

          = 0.182  →  18.2%

  iter_VU2 = 0.182 × 90
           = 16.4
           ≈ 16 iter

────────────────────────────────────────────────────────────
Kiểm tra:  49 + 25 + 16 = 90 ✓  (khớp iterations config)
           ratio: 0.546 + 0.273 + 0.182 = 1.001 ≈ 1.0 ✓
```

> **Mẹo nhớ**: Mẫu số `Σ(1/t_j)` giống nhau cho TẤT CẢ các VU. Chỉ cần
> tính 1 lần rồi chia từng `1/t_i` cho nó. Đừng tính lại mẫu số cho
> từng VU — vừa thừa vừa dễ sai.

##### Tại sao có công thức này?

Gốc của công thức đến từ cơ chế **atomic counter** trong
`shared_iterations.go`:

```text
1. Mọi VU cùng lấy iter từ 1 quầy chung
2. VU nào xong trước thì quay lại quầy lấy tiếp
3. Không có quota riêng, không có fairness guarantee

→ Trong 1 đơn vị thời gian, VU nhanh quay lại quầy NHIỀU lần hơn VU chậm
→ Số lần quay lại tỷ lệ thuận với tốc độ = 1/t_i
→ Tỷ lệ iter = (tốc độ của VU i) / (tổng tốc độ tất cả VU)
```

Đây không phải "k6 cố ý phân phối theo tỷ lệ", mà là **hệ quả tự nhiên**
của cơ chế "first come first served" qua atomic counter. Đọc lại
[section 6.2](#62-khi-vu-chậm-hơn-nhiều-thì-phân-phối-ra-sao) để thấy
cách core hoạt động.

##### Thực tế: iter_time gần bằng nhau — vậy Công thức 1 còn dùng không?

**Trong test thực tế**, tất cả VU chạy cùng 1 `export default function()`:
cùng code, cùng endpoint, cùng server → `iteration_duration` của các VU
**xấp xỉ bằng nhau** (chỉ dao động nhẹ ±5-10% do network jitter).

```text
Demo sleep(1)/sleep(2)/sleep(3) là NHÂN TẠO — cố ý cho khác nhau
để thấy rõ cơ chế atomic counter. Test thật không ai viết code như vậy.
```

Vậy Công thức 1 dùng làm gì trong thực tế?

```text
1. HIỂU CƠ CHẾ — không phải để tính:
   Công thức 1 giải thích "TẠI SAO" VU có thể nhận số iter khác nhau.
   Không cần thay số — chỉ cần hiểu: VU nhanh hơn → nhiều iter hơn.

2. Khi t_i ≈ t (thực tế):
   ratio_i = (1/t) / (n × 1/t) = 1/n
   iter_per_vu_i = (1/n) × iterations = iterations / n
   → Công thức 1 thu về Công thức 5
   → iter phân phối ĐỀU, không cần tính ratio

3. Khi NÀO cần thay số thật vào Công thức 1:
   - VU dùng data-driven test với payload khác nhau (file 1KB vs 10MB)
   - Một VU gặp network chậm khác hẳn (timeout, retry nhiều)
   - Một VU bị "stuck" → iter_time dài gấp 5-10x VU khác
   → Lúc này mới cần tính ratio để ước lượng mức độ lệch

Tóm lại:
  - Demo: dùng Công thức 1 để HIỂU
  - Thực tế: Công thức 5 đủ dùng, Công thức 1 chỉ cần khi có outlier
```

##### Phân tích từng bước (với số cụ thể)

```text
Bước 1: Đo iter_time từng VU
  ┌──────┬──────────┬─────────────────────────────────┐
  │ VU   │ iter_time│ Ghi chú                         │
  ├──────┼──────────┼─────────────────────────────────┤
  │ VU0  │ 1.0s     │ sleep(1)                        │
  │ VU1  │ 2.0s     │ sleep(2)                        │
  │ VU2  │ 3.0s     │ sleep(3)                        │
  └──────┴──────────┴─────────────────────────────────┘

Bước 2: Tính tốc độ từng VU (1/t_i)
  VU0: 1/1.0 = 1.000 iter/s
  VU1: 1/2.0 = 0.500 iter/s
  VU2: 1/3.0 = 0.333 iter/s

Bước 3: Tính tổng tốc độ
  Σ = 1.000 + 0.500 + 0.333 = 1.833 iter/s

Bước 4: Tính tỷ lệ (ratio)
  VU0: 1.000 / 1.833 = 0.546 → 54.6%
  VU1: 0.500 / 1.833 = 0.273 → 27.3%
  VU2: 0.333 / 1.833 = 0.182 → 18.2%

Bước 5: Nhân với tổng iter để ra số iter mỗi VU
  VU0: 0.546 × 90 = 49.1 → ~49 iter
  VU1: 0.273 × 90 = 24.6 → ~25 iter
  VU2: 0.182 × 90 = 16.4 → ~16 iter
                            ───
                            90 ✓
```

##### Ví dụ đời thường

```text
3 nhân viên cùng đóng gói 90 cái hộp:
  - A nhanh: 1 hộp/phút  -> về quầy 1 lần/phút
  - B vừa:  1 hộp/2 phút -> về quầy 0.5 lần/phút
  - C chậm: 1 hộp/3 phút -> về quầy 0.33 lần/phút

  Sau 1 phút, quầy được ghé:
    A ghé 1 lần, B ghé 0.5 lần, C ghé 0.33 lần
    Tổng = 1.83 lần/phút

  Tỷ lệ ghé quầy:
    A: 1/1.83    ≈ 54.6%  -> A đóng ≈ 49 hộp
    B: 0.5/1.83  ≈ 27.3%  -> B đóng ≈ 25 hộp
    C: 0.33/1.83 ≈ 18.0%  -> C đóng ≈ 16 hộp
                            ----------
                            Tổng = 90 hộp ✓
```

##### Kết nối với Công thức 5

```text
Công thức 5 (trung bình): iter_per_vu ≈ 90 / 3 = 30 (mỗi VU 30)

Nhưng thực tế: VU0=49, VU1=25, VU2=16
→ Công thức 5 SAI khi VU lệch tốc độ
→ Công thức 1 là bản chi tiết, Công thức 5 là bản thô

Khi nào 2 công thức cho cùng kết quả?
→ Khi t_0 = t_1 = t_2 (các VU cùng tốc độ):
  ratio_0 = (1/t) / (3 × 1/t) = 1/3
  ratio_1 = 1/3
  ratio_2 = 1/3
  iter mỗi VU = 90/3 = 30 → khớp Công thức 5
```

##### Edge case: 1 VU rất chậm (outlier)

```text
vus=4, iterations=20
t_0=t_1=t_2=0.1s (rất nhanh), t_3=5s (rất chậm)

Tốc độ:
  VU0-2: 1/0.1 = 10 iter/s mỗi VU
  VU3:   1/5   = 0.2 iter/s
  Σ = 30.2 iter/s

Tỷ lệ:
  VU0-2: 10/30.2 ≈ 33.1% mỗi VU → ~6.6 iter mỗi VU
  VU3:   0.2/30.2 ≈ 0.66%       → ~0.13 iter

Thực tế: VU3 có thể chỉ chạy 0-1 iter, trong khi VU0-2 đã "ăn" hết 19-20 iter.

→ VU quá chậm gần như KHÔNG được chia việc
→ Đây KHÔNG phải bug — là hệ quả của design "không fairness"
```

##### Cách verify với output thật

```text
1. Log __VU và __ITER trong default function:
   console.log(`VU=${__VU} ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`);

2. Đếm số iter từng VU:
   VU=1 ITER=5  → VU1 chạy 6 iter (0..5)
   VU=2 ITER=1  → VU2 chạy 2 iter (0..1)
   ...

3. So với dự đoán từ Công thức 1:
   Nếu iter_time đo được từ iteration_duration, tỷ lệ phải khớp ~5% sai số.
```

**Khi nào dùng**: muốn dự đoán VU nào sẽ chạy nhiều iter, hoặc giải thích
tại sao log thấy VU0 chạy 49 iter còn VU2 chạy 16 iter.

**Lưu ý**: chỉ đúng khi clean run (cạn kho). Nếu hit `maxDuration` giữa
chừng, tỷ lệ vẫn giữ nhưng tổng < `iterations`.

---

#### Công thức 2: "Đỉnh là bao nhiêu?" (Throughput đỉnh)

```text
peak_rate ≈ vus / effective_iteration_time
```

**Tiếng Việt**: "Throughput đỉnh = số VU chia cho thời gian 1 iter".
Giống `constant-vus`, vì cả 2 đều closed model với cùng vus chạy
song song suốt thời gian active.

##### Tại sao có công thức này?

Gốc từ mô hình closed model:

```text
Trong 1 giây:
  - Mỗi VU chạy được 1/iter_time iteration
  - Có vus VU chạy song song
  - → Tổng iteration trong 1 giây = vus × (1/iter_time) = vus / iter_time

Đây là phiên bản closed-model của capacity formula:
  capacity = M / W = M × (1/W)

Với:
  M = vus (số worker)
  W = effective_iteration_time (thời gian 1 iter)
```

##### Phân tích từng bước

```text
Cho: vus=4, iter_time=0.5s

Bước 1: Tính per-VU rate
  1 VU chạy 1 iter mất 0.5s
  → Trong 1s, 1 VU chạy được: 1 / 0.5 = 2 iter

Bước 2: Nhân với số VU
  4 VU cùng chạy → 4 × 2 = 8 iter/s

Bước 3: Đối chiếu đơn vị
  4 VU × (1 iter / 0.5s) = 4 × 2 iter/s = 8 iter/s ✓
```

##### Khi nào peak_rate ĐẠT ĐƯỢC?

```text
ĐIỀU KIỆN ĐỂ ĐẠT PEAK:
  1. Tất cả vus VU đang active (không VU nào idle)
  2. Không VU nào bị block bởi network/timeout dài hơn bình thường
  3. Kho iteration còn đủ để tất cả VU cùng lấy

→ Với shared-iterations, điều kiện 1 & 3 thỏa từ t=0 (tất cả VU activate
  cùng lúc, kho còn đầy)
→ PEAK ĐẠT NGAY TỪ GIÂY ĐẦU

NGOẠI LỆ:
  - Gần cuối kho: kho gần cạn, vài VU return sớm → active VU < vus → dưới peak
  - iter_time không đều: nếu 1 VU gặp timeout dài → VU đó "vắng mặt" tạm
    thời → throughput giảm nhẹ
```

##### Phân biệt peak_rate với average_rate trong summary

```text
peak_rate (dự đoán)   = vus / iter_time
                       = throughput KHI TẤT CẢ VU ĐỀU BẬN

summary_rate (thực đo) = completed_iterations / summary_runtime_base
                       = throughput TRUNG BÌNH toàn scenario

Với clean run (không drop):
  summary_rate ≈ peak_rate (vì hầu hết thời gian các VU đều bận)

Với run bị drop (hit maxDuration):
  summary_rate < peak_rate (vì gần cuối vài VU idle khi kho cạn, hoặc bị cắt)

Ví dụ:
  vus=4, iter_time=0.5s, iterations=12
  peak_rate = 4 / 0.5 = 8 iter/s
  summary_rate = 12 / 1.5s = 8 iter/s → khớp ✓ (sạch, không drop)

  vus=4, iter_time=0.5s, iterations=1000, maxDuration=5s
  peak_rate = 8 iter/s
  summary_rate = completed / ~5s ≈ 6-7 iter/s → thấp hơn peak
  (vì gần cuối kho cạn, active VU < 4)
```

##### Ví dụ đời thường

```text
4 nhân viên đóng gói, mỗi cái mất 0.5 phút:
  → Mỗi phút 1 người đóng được 2 cái
  → 4 người đóng được 4 × 2 = 8 cái/phút
  → peak = 8 cái/phút

Nhưng nếu kho chỉ còn 1 cái cuối:
  → Chỉ 1 người bận, 3 người đứng không
  → Thực tế lúc đó = 1 cái/phút (dưới peak)
```

##### Kết nối với Công thức 3

```text
Công thức 2: peak_rate = vus / iter_time
Công thức 3: T_est = iterations / peak_rate = iterations × iter_time / vus

→ Công thức 3 suy trực tiếp từ Công thức 2:
  T_est = iterations / peak_rate
        = iterations / (vus / iter_time)
        = iterations × iter_time / vus

→ Nếu bạn biết peak_rate, chỉ cần: T_est = iterations / peak_rate
```

**Khi nào dùng**: ước lượng trước scenario sẽ tạo bao nhiêu req/s đỉnh,
để xem hệ backend chịu nổi không. Nếu peak > khả năng backend → sẽ có
timeout/retry → iter_time tăng → peak giảm → nhưng lúc đó hệ thống đã
quá tải rồi.

**Lưu ý**: dùng `effective_iteration_time`, không phải `sleep()` trong
code. `effective_iteration_time` = thời gian thật VU bị bận (gồm HTTP,
check, sleep, ...). Nếu có `minIterationDuration` thì:
`effective = max(iteration_duration, minIterationDuration)`.

---

#### Công thức 3: "Hết bao lâu?" (Thời gian chạy ước lượng)

```text
T_est ≈ iterations × effective_iteration_time / vus
     ≈ iterations / peak_rate
```

**Tiếng Việt**: "Tổng thời gian chạy = (tổng iter × thời gian 1 iter)
chia cho số VU". Vì iter chia đều cho `vus` VU chạy song song.

##### Tại sao có công thức này?

Từ mô hình wave (đợt):

```text
1. vus VU cùng chạy → mỗi đợt hoàn thành vus iteration
2. Số đợt cần = ceil(iterations / vus)
3. Mỗi đợt mất ~iter_time
4. Tổng thời gian ≈ số đợt × iter_time ≈ (iterations / vus) × iter_time
```

Nếu iterations chia hết cho vus (như `12/4=3`), các đợt đều đặn.
Nếu không chia hết, đợt cuối ít VU hơn nhưng thời gian vẫn ~iter_time.

##### Phân tích từng bước (có timeline)

```text
Config: vus=4, iterations=12, iter_time=0.5s

Bước 1: Tính số đợt
  waves = ceil(12 / 4) = 3 đợt

Bước 2: Timeline từng đợt
  Đợt 1 (t=0.0→0.5s): VU0-3 cùng chạy iter #1-#4
  Đợt 2 (t=0.5→1.0s): VU0-3 cùng chạy iter #5-#8
  Đợt 3 (t=1.0→1.5s): VU0-3 cùng chạy iter #9-#12

Bước 3: T_est = 3 × 0.5s = 1.5s

Bước 4: So sánh với công thức
  T_est = 12 × 0.5 / 4 = 6/4 = 1.5s ✓
```

##### Khi T_est sai — và sai bao nhiêu?

```text
NGUỒN SAI SỐ:

1. iter_time không đều giữa các VU:
   → VU nhanh hoàn thành sớm, lấy thêm iter
   → Số đợt thực tế ít hơn dự đoán
   → T thực < T_est (test nhanh hơn dự đoán)

   Ví dụ: VU0=0.2s, VU1-3=0.6s, iterations=16
     T_est (dùng avg=0.5s): 16×0.5/4 = 2.0s
     T thực: ~1.6s (VU0 "gánh" nhiều iter hơn, tổng nhanh hơn)

2. iter_time không đều giữa các iter của CÙNG 1 VU:
   → HTTP request có lúc nhanh lúc chậm
   → T thực dao động quanh T_est

3. Overhead scheduler:
   → Activate VU, atomic counter, context switch
   → Thêm ~1-5ms mỗi iter → không đáng kể với iter_time >= 100ms

SAI SỐ ĐIỂN HÌNH: ±10-20% với HTTP test thông thường
                    ±5% với sleep() test (đơn giản, ít biến động)
```

##### Ví dụ đời thường

```text
90 cái hộp, mỗi cái 1 phút, 3 nhân viên:
  → 90 × 1 / 3 = 30 phút (nếu 3 người đều tốc độ)

Nhưng nếu A nhanh gấp 3 lần C:
  → A "gánh" nhiều hộp hơn
  → Tổng thời gian < 30 phút
  → (~25 phút, vì A làm 49 hộp thay vì 30)
```

##### Kết nối với Công thức 4

```text
T_est là INPUT cho Công thức 4:

  Nếu T_est < maxDuration:
    → scenario kết thúc tự nhiên khi cạn kho
    → T_max = T_est + gracefulStop (grace thường không dùng tới)

  Nếu T_est > maxDuration:
    → scenario bị cắt bởi maxDuration
    → T_max = maxDuration + gracefulStop
    → Có dropped_iterations (iter trong kho chưa kịp lấy — xem bên dưới)
    → CÓ THỂ có interrupted_iterations (iter đang chạy không kịp finish trong grace)

→ Luôn kiểm tra: T_est < maxDuration không?
→ Nếu không: hoặc giảm iterations, hoặc tăng vus, hoặc tăng maxDuration
```

##### Drop vs Interrupt trong shared-iterations — đừng nhầm

CẢ HAI đều có thể xảy ra khi `T_est > maxDuration`, nhưng là 2 thứ KHÁC NHAU:

| | `dropped_iterations` | `interrupted_iterations` |
| --- | --- | --- |
| **Là gì?** | Iter trong kho CHƯA TỪNG ĐƯỢC LẤY | Iter ĐÃ START nhưng KHÔNG KỊP FINISH |
| **Xảy ra khi** | `maxDuration` hết, VU không claim iter mới | `gracefulStop` hết, `maxDurationCtx` cancel |
| **Core** | `attemptedIters < totalIters` → emit | `ctx.Err()` → `AddInterrupted` |
| **Code ref** | `shared_iterations.go:219-228` | `helpers.go:90-95` |
| **Ví dụ** | config 100 iter, VU mới lấy 40 → drop 60 | iter đang chạy 5s/6s, grace=1s → interrupt |

**Timeline minh họa CẢ HAI CÙNG XUẤT HIỆN:**

```text
Config: iterations=100, vus=2, iter_time=2s, maxDuration=5s, grace=1s

t=0     2 VU claim iter#1,#2 → chạy (đến t=2)
t=2     finish #1,#2 (complete=2)
        claim iter#3,#4 → chạy (đến t=4)
t=4     finish #3,#4 (complete=4)
        claim iter#5,#6 → chạy (đến t=6)
t=5     maxDuration hết → regDurationCtx done
        → VU không claim iter mới nữa
        → iter#7..#100 trong kho = DROPPED (94 iter chưa từng lấy)
t=6     gracefulStop hết → maxDurationCtx cancel
        → iter#5,#6 đang chạy (đã 2s/2s, vừa kịp)
        → nếu iter_time=2.5s thay vì 2s: iter mới được 2s/2.5s → INTERRUPTED

Kết quả: complete=6, interrupted=0, dropped=94
         attemptedIters=6, totalIters=100
         100 = 6(complete) + 0(interrupted) + 94(dropped) ✓
```

Quy tắc:

```text
- iter_time < gracefulStop  → chỉ DROP, không interrupt (iter kịp finish trong grace)
- iter_time > gracefulStop  → DROP + INTERRUPT (iter không kịp finish)
- Drop KHÔNG chỉ có ở arrival-rate — shared-iterations cũng có drop
```

**Khi nào dùng**: trước khi chạy, để biết test mất bao lâu — và quan trọng
là để chọn `maxDuration` đủ lớn (xem Công thức 4).

**Lưu ý**: dùng `effective_iteration_time`, không phải `sleep()` trong code.
Nếu không biết trước iter_time, chạy thử 1 VU, 1 iter để đo `iteration_duration`
trước khi tính.

---

#### Công thức 4: "Trần wall-clock" (Tổng thời gian tối đa scenario)

```text
T_max = min(maxDuration, T_est) + gracefulStop

Trong đó:
  - T_est ≈ iterations × iter_time / vus (từ Công thức 3)
  - maxDuration: trần config, default 10m
  - gracefulStop: cửa sổ grace cho iter đang chạy, default 30s
```

**Tiếng Việt**: "Thời gian tối đa scenario kéo dài = lấy số NHỎ HƠN giữa
(maxDuration) và (T ước lượng), cộng grace cuối".

##### Tại sao là `min` mà không phải `max`?

```text
Vì scenario kết thúc theo 1 trong 2 cách:

Cách 1: Cạn kho iteration → T_thực ≈ T_est → không cần tới maxDuration
Cách 2: Hết maxDuration → T_thực ≈ maxDuration → kho chưa cạn, có drop

→ Scenario luôn kết thúc khi ĐIỀU KIỆN NÀO ĐẾN TRƯỚC
→ Điều kiện nào đến trước = con số nhỏ hơn = min(maxDuration, T_est)
```

##### Phân tích 3 case (có timeline)

**Case A: T_est < maxDuration — "ngon, cạn kho trước hạn"**

```text
Config: vus=4, iterations=12, iter_time=0.5s, maxDuration=10m, gracefulStop=30s

T_est = 12 × 0.5 / 4 = 1.5s
min(10m, 1.5s) = 1.5s
T_max = 1.5s + 30s = 31.5s (nhưng thực tế grace không dùng)

Timeline:
  t=0.0   Run(), 4 VU activate
  t=0.5   đợt 1 xong
  t=1.0   đợt 2 xong
  t=1.5   đợt 3 xong, kho cạn
          → activeVUs.Wait() return
          → scenario kết thúc (~1.5s)
          → không dùng tới maxDuration (10m), không dùng gracefulStop

Output:
  iterations...........: 12
  dropped_iterations...: 0          ← không drop
  running (1.5s)                    ← << 10m
```

**Case B: T_est > maxDuration — "kẹt, hit trần"**

```text
Config: vus=2, iterations=100, iter_time=2s, maxDuration=5s, gracefulStop=3s

T_est = 100 × 2 / 2 = 100s
min(5s, 100s) = 5s
T_max = 5s + 3s = 8s

Timeline:
  t=0.0   2 VU activate, vào đợt 1 (đến t=2s)
  t=2.0   đợt 1 xong (2 iter), vào đợt 2 (đến t=4s)
  t=4.0   đợt 2 xong (4 iter), vào đợt 3 (đến t=6s)
  t=5.0   maxDuration hết → regDurationCtx done
          → VU không lấy iter mới nữa
          → 2 VU đang ở đợt 3 (đã 1s, còn 1s)
          → vào grace
  t=6.0   2 VU finish đợt 3 trong grace (1s < 3s, clean)
          → loop: check regDurationDone → đã done → return
  t=6.0   activeVUs.Wait() return
          attemptedIters = 6, totalIters = 100
          emit DroppedIterations = 94

Output:
  iterations...........: 6          ← chỉ 6/100 hoàn thành
  dropped_iterations...: 94         ← kho còn 94 iter chưa lấy
  interrupted..........: 0          ← iter đang chạy kịp finish trong grace
  running (6.0s)
```

**Case C: iter_time > gracefulStop — "cắt đau"**

```text
Config: vus=2, iterations=100, iter_time=6s, maxDuration=5s, gracefulStop=1s

T_est = 100 × 6 / 2 = 300s
min(5s, 300s) = 5s
T_max = 5s + 1s = 6s

Timeline:
  t=0.0   2 VU vào đợt 1 (đến t=6s)
  t=5.0   maxDuration hết, vào grace (1s)
          2 VU đang ở đợt 1 (đã 5s, còn 1s)
  t=6.0   gracefulStop hết → maxDurationCtx cancel
          2 VU vẫn đang chạy iter (6s = đúng iter_time)
          → Tùy race: có thể finish kịp hoặc bị cancel giữa chừng
          → Nếu bị cancel: iter thành interrupted

Worst case:
  iterations....: 0          ← iter bị cắt trước khi emit complete
  interrupted...: 2          ← 2 iter đang chạy bị cắt
  dropped.......: 98         ← 100 - 2 (attempted = 2 nhưng chưa complete)
```

##### Cách chọn `maxDuration` hợp lý

```text
QUY TRÌNH 3 BƯỚC:

1. Ước lượng T_est (Công thức 3)
   T_est = iterations × iter_time / vus

2. Thêm buffer 20-50%
   maxDuration = T_est × 1.5  (hoặc × 2 cho an toàn)

3. Kiểm tra lower bound
   maxDuration >= 1s (validate requirement)

Ví dụ:
  T_est = 30s → maxDuration = 45s-60s
  T_est = 5m  → maxDuration = 7m30s-10m
  T_est = 30s → maxDuration = "1m" (chọn tròn)

Nếu không chắc iter_time:
  → Chạy thử với vus=1, iterations=1 để đo iteration_duration trước
  → Rồi tính lại T_est với vus và iterations thật
```

##### Ví dụ đời thường

```text
Đóng 90 hộp, ước 30 phút, sếp giới hạn 1h:
  min(60, 30) = 30 phút
  + grace 5 phút
  = 35 phút (tối đa scenario kéo dài)

Nhưng thực tế: sau 30 phút xong việc, về sớm, không cần grace.

Nếu sếp giới hạn 20 phút (chặt hơn T_est):
  min(20, 30) = 20 phút
  + grace 5 phút
  = 25 phút
  → còn 15 hộp chưa đóng (= dropped)
```

##### Kết nối với section 3.8

```text
Công thức 4 là bản cheat sheet của section 3.8 (maxDuration và gracefulStop).
Nếu muốn hiểu sâu cơ chế:
  - regDurationCtx vs maxDurationCtx → section 3.8.2
  - interrupt vs drop → section 6.5
  - 4 cách kết thúc scenario → section 6.3
```

**Khi nào dùng**: trước khi chạy, để chọn `maxDuration` và `gracefulStop`
cho phù hợp. Sau khi chạy, để giải thích tại sao có dropped/interrupted.

---

#### Công thức 5: "Mỗi VU làm bao nhiêu?" (Số iter trung bình mỗi VU)

```text
iter_per_vu ≈ iterations / vus
```

**Tiếng Việt**: "Số iter trung bình mỗi VU = tổng iter chia cho số VU".
Là **xấp xỉ thô** — thực tế VU nhanh hơn nhận nhiều, VU chậm hơn nhận
ít (xem Công thức 1).

##### Tại sao cần công thức này nếu đã có Công thức 1?

```text
Công thức 5 là "quick check", Công thức 1 là "deep analysis":

  Công thức 5: 1 phép chia, không cần biết iter_time từng VU
  → Dùng khi: mới phác thảo config, chưa biết iter_time

  Công thức 1: cần biết iter_time từng VU, tính tỷ lệ
  → Dùng khi: đã có output, muốn giải thích phân phối thực tế

Tương tự như trong thống kê:
  - Công thức 5 = mean (trung bình)
  - Công thức 1 = weighted distribution (phân phối có trọng số)
```

##### Phân tích: khi nào Công thức 5 ĐÚNG?

```text
ĐIỀU KIỆN ĐỂ CÔNG THỨC 5 CHÍNH XÁC:
  Tất cả VU có iter_time BẰNG NHAU

Chứng minh:
  Khi t_0 = t_1 = ... = t_{n-1} = t:
    ratio_i = (1/t) / (n × 1/t) = 1/n
    iter_per_vu_i = (1/n) × iterations = iterations / n = iterations / vus

→ Kết quả giống Công thức 5

KHI NÀO ĐIỀU KIỆN NÀY ĐÚNG TRONG THỰC TẾ?
  - Test sleep(): các VU cùng sleep(N) → iter_time bằng nhau
  - HTTP test với server ổn định: mọi VU cùng code → iter_time gần bằng
  - Trong thực tế: iter_time LUÔN có dao động nhỏ (±5-10%) do network
    → Công thức 5 là approximation, không exact
```

##### Khi nào Công thức 5 SAI nhiều?

```text
SAI NHIỀU (>30%) KHI:
  1. VU dùng __VU để chọn sleep khác nhau:
     sleep(__VU * 0.5) → VU1=0.5s, VU2=1.0s, VU3=1.5s → lệch 3x

  2. VU dùng data-driven test với payload khác nhau:
     VU0 xử lý file 1KB, VU1 xử lý file 10MB → iter_time lệch lớn

  3. Một vài VU gặp timeout/retry:
     → iter_time của VU đó tăng đột biến → nhận ít iter hơn hẳn

  4. Network không ổn định giữa các VU:
     → VU có connection tốt "ăn" nhiều iter hơn
```

##### Ví dụ đời thường

```text
20 hộp chia cho 4 nhân viên:
  Trung bình: 20 / 4 = 5 hộp/người

Nhưng thực tế:
  - Người nhanh: 8 hộp (gấp 1.6x trung bình)
  - 2 người vừa: 5 hộp mỗi người
  - Người chậm: 2 hộp (chưa bằng 1/2 trung bình)
  Tổng = 20 ✓

→ Trung bình = 5 là con số "trên giấy"
→ Thực tế ai làm được bao nhiêu là do tốc độ từng người
```

##### Áp vào k6

```text
Ví dụ 1 — VU đều tốc độ (sleep 0.5s, vus=4, iterations=20):
  iter_per_vu = 20 / 4 = 5
  Kết quả thật: VU0=5, VU1=5, VU2=5, VU3=5 ✓

Ví dụ 2 — VU lệch tốc độ (như demo 5.1):
  vus=4, iterations=16
  iter_per_vu = 16 / 4 = 4 (trung bình)

  Kết quả thật:
    VU0 (0.2s): 8 iter  ← gấp 2x trung bình
    VU1 (0.4s): 4 iter  ← đúng trung bình
    VU2 (0.8s): 2 iter  ← 1/2 trung bình
    VU3 (0.8s): 2 iter  ← 1/2 trung bình
    Tổng = 16 ✓

  → Trung bình 4 là "vô nghĩa" về mặt dự đoán từng VU
  → Nhưng hữu ích để tính T_est (Công thức 3):
    T_est = 16 × 0.5 / 4 = 2s (dùng iter_time trung bình 0.5s)
```

##### Kết nối với Công thức 1 và 3

```text
Công thức 5 → Công thức 1: từ thô đến chi tiết
  iter_per_vu (thô) = iterations / vus
  iter_per_vu_i (chi tiết) = ratio_i × iterations

Công thức 5 → Công thức 3: từ VU đến scenario
  T_est = iterations / peak_rate
        = iterations / (vus / iter_time)
        = (iterations / vus) × iter_time
        = iter_per_vu × iter_time              ← Công thức 5 xuất hiện!

→ Công thức 3 = Công thức 5 × iter_time
→ "Tổng thời gian = số iter mỗi VU × thời gian 1 iter"
→ Lý do: vus VU cùng chạy, mỗi VU làm iter_per_vu iter,
  thời gian = số đợt × iter_time ≈ iter_per_vu × iter_time
```

**Khi nào dùng**: ước lượng nhanh không cần biết tốc độ từng VU. Nếu muốn
chính xác hơn, dùng Công thức 1.

**Lưu ý**: chỉ chính xác khi tất cả VU đều cùng iter_time. Lệch nhau thì
dùng Công thức 1 (ratio). Đây là công thức YẾU NHẤT trong 5 công thức về
độ chính xác — nhưng NHANH NHẤT để tính nhẩm.

---

#### Bảng tổng kết 5 công thức

| # | Tên | Công thức | Độ chính xác | Dùng khi |
| --- | --- | --- | --- | --- |
| 1 | Chia kho | `iter_i ≈ (1/t_i)/Σ(1/t_j) × N` | ★★★★★ | Đã có output, muốn giải thích phân phối |
| 2 | Đỉnh | `peak ≈ vus / t` | ★★★★☆ | Ước lượng max req/s trước run |
| 3 | Bao lâu | `T_est ≈ N × t / vus` | ★★★★☆ | Chọn maxDuration trước run |
| 4 | Trần | `T_max = min(mD, T_est) + gS` | ★★★★★ | Kiểm tra config có bị cắt không |
| 5 | Mỗi VU | `avg ≈ N / vus` | ★★☆☆☆ | Tính nhẩm nhanh, phác thảo config |

> **Thứ tự học**: 5→2→3→4→1. Bắt đầu từ Công thức 5 (đơn giản nhất),
> rồi học Công thức 2 (peak), rồi 3 và 4 (ước lượng thời gian), cuối
> cùng là Công thức 1 (chi tiết nhất, dùng để debug).

> **Thứ tự dùng khi viết config**: 2→3→4→1→5. Đầu tiên ước lượng peak
> (backend chịu nổi không?), rồi tính T_est và chọn maxDuration, rồi
> sau run dùng Công thức 1 để giải thích output, Công thức 5 để tính
> nhẩm khi cần.

### 8.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

Đây là tình huống đầu tiên ai cũng gặp: đã có script, muốn test tổng N
lượt request, nhưng chưa biết đặt `maxDuration` bao nhiêu cho đủ, và muốn
ước lượng trước thời gian chạy.

Khác với `constant-vus` (chạy theo duration), `shared-iterations` chạy đến
khi **cạn kho iteration**. Vì thế bạn phải ước lượng `T_est` để đặt
`maxDuration` đủ rộng, nếu không scenario sẽ bị cắt giữa chừng.

Demo dùng để phân tích: `examples/shared_iterations_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TOTAL_ITERATIONS = __ENV.ITERATIONS ? Number(__ENV.ITERATIONS) : 40;
const VUS = __ENV.VUS ? Number(__ENV.VUS) : 4;
const ITER_TIME_SEC = 0.5;  // W: sleep cố định giả lập request HTTP

// ─── Bước 1-4: tính toán (init phase) ──────────────────────
const N = TOTAL_ITERATIONS;
const W = ITER_TIME_SEC;
const vusCount = VUS;

// Công thức 3: T_est ≈ iterations × iter_time / vus
const T_est = N * W / vusCount;

// Công thức 2: peak_rate ≈ vus / iter_time
const peak_rate = vusCount / W;

// Công thức 5: iter_per_vu ≈ iterations / vus
const iter_per_vu_avg = N / vusCount;

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "shared-iterations",
      vus: vusCount,
      iterations: N,
      maxDuration: "2m",
      gracefulStop: "10s",
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC); // giả lập request HTTP
}
```

Chạy:

```bash
k6 run examples/shared_iterations_sizing_demo.js                   # N=40, vus=4
k6 run -e ITERATIONS=100 -e VUS=10 examples/shared_iterations_sizing_demo.js
k6 run -e ITERATIONS=200 -e VUS=10 examples/shared_iterations_sizing_demo.js
```

Giờ phân tích output theo đúng 5 bước, lấy lần chạy N=40, vus=4 làm mẫu.

**── Bước 1: Quyết tổng iter cần (iterations = N) ──**

Lý thuyết: đây là con số bạn TỰ CHỌN dựa trên mục tiêu test. Không đọc
từ summary, không có trong config cũ. Đây là tổng số iter toàn scenario,
KHÔNG phải per-VU.

Ví dụ chọn N:
  "Tôi muốn test tổng 200 lượt request" → N = 200
  "Smoke test nhanh, 40 iter là đủ" → N = 40
  "Regression cần 1000 iter" → N = 1000

Trong demo: `const TOTAL_ITERATIONS = 40` → N = 40 iter.

```text
sizing_demo: 40 iterations shared among 4 VUs   ← Header xác nhận config đúng
```

**── Bước 2: Quyết số VU song song (vus) ──**

Lý thuyết: với `shared-iterations`, **nhiều VU hơn = xong nhanh hơn** (vì
nhiều worker cùng chia việc). Nhưng không phải cứ "càng nhiều càng tốt" —
có 3 giới hạn thực tế:

```text
1. GIỚI HẠN MÁY LOCAL (RAM/CPU):
   Mỗi VU = 1 JS context (goja VM) → tốn RAM ~2-5MB/VU
   → 100 VU ≈ 200-500MB: ổn
   → 1000 VU ≈ 2-5GB: bắt đầu nặng
   → 5000 VU ≈ 10-25GB: dễ crash máy local
   Khi máy local quá tải, chính k6 thành bottleneck — kết quả đo sai.

2. GIỚI HẠN PHÍA SERVER (không phải lúc nào cũng muốn test max):
   shared-iterations activate HẾT VU ngay từ t=0
   → 100 VU cùng bắn request → server có thể bị "thunder"
   → response time tăng vọt, timeout, connection refused
   → Bạn đang test "server quá tải" thay vì "server hoạt động bình thường"
   → Cần chọn vus phù hợp với MỤC TIÊU TEST, không phải max luôn.

3. GIỚI HẠN VALIDATE:
   vus phải <= iterations (mỗi VU ít nhất 1 iter)
   → iterations=40, vus=100 → LỖI VALIDATE
```

**Vậy chọn bao nhiêu?**

```text
Mục tiêu "hoàn thành N iter nhanh nhất" → chọn vus LỚN NHẤT có thể,
nhưng không vượt quá:
  a) RAM máy local (thường ~500-1000 VU là trần với laptop 16GB)
  b) Khả năng server chịu đựng (nếu test API công cộng, đừng DDoS)

Mục tiêu "mô phỏng N user thật" → chọn vus = số user đồng thời thực tế
  → Không cần nhiều hơn, vì thực tế chỉ có bấy nhiêu user

Mục tiêu "so sánh performance giữa 2 phiên bản code":
  → Chọn vus cố định (vd: 10), giữ nguyên qua mọi lần chạy
  → iterations đủ lớn để có ý nghĩa thống kê (>100)
```

Trong demo: chọn `vus=4` — con số nhỏ để demo. Với `iterations=40`,
`peak_rate = 4/0.5 = 8 iter/s` là đủ thấy rõ hành vi.

```text
Ràng buộc: vus (4) <= iterations (40) ✓
Header: "40 iterations shared among 4 VUs"   ← vus=4 khớp config
```

> **Tóm lại**: user hỏi "chọn nhiều hơn thì tốt hơn chứ?" — ĐÚNG, nếu mục
> tiêu là xong nhanh nhất. Nhưng đừng quên máy local (RAM) và server (quá
> tải). Chọn vus = max mà máy local chịu được, miễn là không vượt quá
> iterations và không làm sập server đang test.

**── Bước 3: Đo iter_time (W) ──**

Lý thuyết: chạy thử 1 VU, xem `iteration_duration avg` trong summary,
lấy đó làm W.

Trong demo: `const ITER_TIME_SEC = 0.5` → W = 0.5s. Đây là giả lập —
sleep(0.5) mô phỏng 1 request HTTP mất 0.5s. Ngoài đời thì bạn chạy
thử script với 1 VU rồi đọc số từ summary.

```text
iteration_duration...: avg=500.37ms     ← W thực tế ~0.5s, khớp code
per_vu_rate = 1 / W = 1 / 0.5 = 2.0 iter/s/VU
```

Mỗi VU làm được 2 iter mỗi giây. 4 VU cùng làm → throughput đỉnh = 4 / 0.5
= 8 iter/s (sẽ kiểm tra ở Bước 5).

**── Bước 4: Tính T_est (Công thức 3) → chọn maxDuration ──**

Lý thuyết: `T_est = iterations × iter_time / vus`. Công thức 3 trong
cheat sheet — chia tổng việc cho số VU song song.

Trong demo:
  T_est = 40 × 0.5 / 4 = 5.0s

→ Đặt `maxDuration` > T_est ít nhất 50-100%. Demo dùng `maxDuration: "2m"`
(rộng thênh thang, an toàn tuyệt đối).

```text
Bước 4 — Tính T_est (Công thức 3):
  T_est = N × W / vus
        = 40 × 0.5 / 4
        = 5.0s
  → Đặt maxDuration > T_est (dùng "2m" cho an toàn)
```

**── Bước 5: Đặt config hoàn chỉnh, chạy, đọc summary kiểm tra ──**

Lý thuyết: sau khi có vus, iterations, maxDuration, chạy và kiểm tra chéo
bằng các công thức.

Trong demo:
  executor = "shared-iterations"
  vus = 4
  iterations = 40
  maxDuration = "2m"
  gracefulStop = "10s"

Chạy lần đầu (N=40, vus=4):

```text
  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.37ms min=500.17ms med=500.32ms max=500.88ms
                           p(90)=500.55ms p(95)=500.88ms
    iterations...........: 40  7.994025/s
    vus..................: 4   min=4      max=4
    vus_max..............: 4   min=4      max=4

    NETWORK
    data_received........: 0 B 0 B/s
    data_sent............: 0 B 0 B/s

  running (0m05.0s), 0/4 VUs, 40 complete and 0 interrupted iterations
```

T_est dự kiến (Công thức 3):
  T_est = 40 × 0.5 / 4 = 5.0s
  Footer: `running (0m05.0s)` → T_run = 5.0s ✓
  → Khớp tuyệt đối vì sleep cố định.

Peak rate dự kiến (Công thức 2):
  peak = vus / W = 4 / 0.5 = 8.0 iter/s
  Summary: `iterations/s = 7.994` ≈ 8.0 ✓

Số iter trung bình mỗi VU (Công thức 5):
  iter_per_vu ≈ 40 / 4 = 10 iter/VU

Kiểm tra không drop:
  N_done = 40 = iterations (config) ✓
  N_drop = 0 (không có dòng `dropped_iterations`) ✓
  N_int = 0 (footer: "0 interrupted") ✓

Footer:
```text
running (0m05.0s), 0/4 VUs, 40 complete and 0 interrupted iterations
           ↑          ↑        ↑              ↑
       T_run=5.0s  VU về 0  N_done=40     N_int=0
```

  T_run = 5.0s → khớp T_est. VU active cuối = 0/4 → tất cả VU đã xong.
  N_int = 0 → grace đủ, không iter nào bị cắt.

**── Thử N khác để thấy quy luật ──**

```bash
k6 run -e ITERATIONS=100 -e VUS=10 examples/shared_iterations_sizing_demo.js
```

Bước 1: N = 100.  Bước 2: vus = 10.
Bước 4: T_est = 100 × 0.5 / 10 = 5.0s.

```text
  iteration_duration...: avg=500.46ms
  iterations...........: 100 19.979574/s   ← peak = 10/0.5 = 20/s ✓
  vus..................: 10  min=10  max=10
  running (0m05.0s), 00/10 VUs, 100 complete and 0 interrupted iterations
```

→ Gấp đôi N và gấp đôi vus → T_est vẫn 5s, nhưng throughput gấp đôi (20/s
so với 8/s). Đúng lý thuyết: T_est ∝ N/vus, peak ∝ vus.

```bash
k6 run -e ITERATIONS=20 -e VUS=2 examples/shared_iterations_sizing_demo.js
```

Bước 4: T_est = 20 × 0.5 / 2 = 5.0s. (T_est không đổi vì N/vus = 10)

→ Với shared-iterations, T_est chỉ phụ thuộc tỉ số N/vus, không phụ
thuộc giá trị tuyệt đối của N hay vus riêng lẻ. Đây là điểm khác biệt
với constant-vus (T_est = duration, cố định).

**Bảng tổng kết**:

| N | vus | W | T_est = N×W/vus | peak = vus/W | T_run | rate thực | N_done | Đạt? |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 40 | 4 | 0.5s | 5.0s | 8.0/s | 5.0s | ~7.99/s | 40 | ✓ |
| 100 | 10 | 0.5s | 5.0s | 20.0/s | 5.0s | ~19.98/s | 100 | ✓ |
| 20 | 2 | 0.5s | 5.0s | 4.0/s | 5.0s | ~4.0/s | 20 | ✓ |
| 200 | 10 | 0.5s | 10.0s | 20.0/s | ~10s | ~20.0/s | 200 | ✓ |

Tất cả khớp vì demo dùng sleep cố định. Với HTTP thật, iter_time dao
động → T_est lệch vài % → dùng p95 thay avg để an toàn (mục 8.3).

**Lưu ý quan trọng cho shared-iterations**:

```text
Khác với constant-vus:
  - constant-vus: bạn đặt DURATION, số iter là HỆ QUẢ (N ≈ vus × duration / W)
  - shared-iterations: bạn đặt ITERATIONS, thời gian là HỆ QUẢ (T ≈ N × W / vus)

→ Với shared-iterations, maxDuration PHẢI > T_est, nếu không sẽ có
  dropped_iterations (kho chưa cạn mà hết giờ).
→ Luôn tính T_est trước khi đặt maxDuration.
```

#### Tình huống 2: "Đã có target tổng iter, cần bao nhiêu VU?"

Đây là dạng phổ biến: biết tổng iter muốn test (N) và thời gian tối đa cho
phép (T_target), cần tính số VU để xong kịp. Thực chất là đảo Công thức 3
để tìm `vus`.

Demo dùng để phân tích: `examples/shared_iterations_reverse_sizing_demo.js`

```js
import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TOTAL_ITERATIONS = __ENV.ITERATIONS ? Number(__ENV.ITERATIONS) : 80;
const TARGET_DURATION_SEC = __ENV.TARGET_DURATION ? Number(__ENV.TARGET_DURATION) : 10;
const ITER_TIME_SEC = 0.5;  // W: sleep cố định giả lập request HTTP

// ─── Bước 1-3: tính toán (init phase) ──────────────────────
const N = TOTAL_ITERATIONS;
const W = ITER_TIME_SEC;
const T_target = TARGET_DURATION_SEC;

// Đảo Công thức 3: vus = ceil(iterations × iter_time / target_duration)
const calculatedVUs = Math.ceil(N * W / T_target);

// Verify lại: T_est với số VU đã tính
const T_est = N * W / calculatedVUs;

// Công thức 2: peak_rate ≈ vus / iter_time
const peak_rate = calculatedVUs / W;

export const options = {
  scenarios: {
    reverse_sizing: {
      executor: "shared-iterations",
      vus: calculatedVUs,
      iterations: N,
      maxDuration: "2m",
      gracefulStop: "10s",
    },
  },
};

export default function () {
  sleep(ITER_TIME_SEC); // giả lập request HTTP
}
```

**── Công thức ──**

```text
Công thức gốc: T_est = iterations × iter_time / vus     (Công thức 3)
Đảo lại:        vus   = iterations × iter_time / T_est

Thực tế phải làm tròn LÊN:
  vus = ceil(iterations × iter_time / target_duration)
```

Vì VU là số nguyên. Thiếu VU → T_run > target. Thừa 1 VU → T_run < target
(an toàn hơn là thiếu).

**── Ví dụ A: N=80 iter, target 10s, W=0.5s ──**

```bash
k6 run examples/shared_iterations_reverse_sizing_demo.js
```

Code làm gì:
  `const calculatedVUs = Math.ceil(80 × 0.5 / 10) = Math.ceil(4.0) = 4`
  → config có `vus: 4`

**── Bước 1: Đảo Công thức 3 ──**

  vus = N × W / T_target = 80 × 0.5 / 10 = 4.0

**── Bước 2: Làm tròn LÊN (ceil) ──**

  vus = ceil(4.0) = 4 VU
  Ràng buộc: vus (4) <= iterations (80) ✓

**── Bước 3: Verify lại T_est ──**

  T_est = 80 × 0.5 / 4 = 10.0s ≤ target 10s ✓

**── Bước 4: Chạy, đọc summary ──**

Output:

```text
  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.27ms min=500.04ms med=500.26ms max=500.75ms
                           p(90)=500.5ms p(95)=500.52ms
    iterations...........: 80  7.994489/s
    vus..................: 4   min=4      max=4
    vus_max..............: 4   min=4      max=4

  running (0m10.0s), 0/4 VUs, 80 complete and 0 interrupted iterations
```

Kiểm tra:
  Đảo CT3: vus_calc = ceil(80 × 0.5 / 10) = 4 → config vus=4 ✓
  CT3 verify: T_est = 80 × 0.5 / 4 = 10.0s → T_run = 10.0s ✓
  CT2: peak = 4 / 0.5 = 8.0 iter/s → summary 7.994 ≈ 8.0 ✓
  CT5: iter_per_vu ≈ 80 / 4 = 20 iter/VU
  N_done = 80 = iterations config, N_drop = 0, N_int = 0 → clean run ✓

**── Ví dụ B: N=100 iter, target 8s, W=0.5s (ceil ra số lẻ) ──**

```bash
k6 run -e ITERATIONS=100 -e TARGET_DURATION=8 examples/shared_iterations_reverse_sizing_demo.js
```

Bước 1: vus = 100 × 0.5 / 8 = 6.25
Bước 2: ceil(6.25) = 7 VU
Bước 3: T_est = 100 × 0.5 / 7 = 7.14s ≤ target 8s ✓

Output:

```text
  iteration_duration...: avg=500.29ms
  iterations...........: 100 13.324333/s
  vus..................: 7   min=7       max=7

  running (0m07.5s), 0/7 VUs, 100 complete and 0 interrupted iterations
```

Kiểm tra:
  vus_calc = ceil(100 × 0.5 / 8) = ceil(6.25) = 7 ✓
  CT3: T_est = 100 × 0.5 / 7 = 7.14s → T_run = 7.5s (lệch 0.36s, ~5%)
  CT2: peak = 7 / 0.5 = 14.0 iter/s → summary 13.32 ≈ 14.0 ✓

  T_run = 7.5s ≤ target 8s → XONG SỚM HƠN TARGET. Đây là hệ quả của
  ceil() — làm tròn lên cho thừa VU, nên chạy nhanh hơn dự kiến.

**── Ví dụ C: N=50 iter, target 20s, W=0.5s (cần rất ít VU) ──**

  vus = ceil(50 × 0.5 / 20) = ceil(1.25) = 2 VU
  T_est = 50 × 0.5 / 2 = 12.5s ≤ target 20s ✓
  peak = 2 / 0.5 = 4.0 iter/s

  → Chỉ cần 2 VU cũng xong 50 iter trong 12.5s, sớm hơn target 20s nhiều.

**── Lưu ý quan trọng ──**

```text
ceil() làm vus nhảy bậc (1, 2, 3, ...), T_est nhảy bậc theo:
  vus=6 (ceil 6.25) → T_est = 100×0.5/6 = 8.33s > target 8s  ← THIẾU!
  vus=7 (ceil 6.25) → T_est = 100×0.5/7 = 7.14s ≤ target 8s  ← OK

→ Luôn dùng ceil(), không dùng floor(). Floor dễ gây thiếu VU → T_run
  vượt target.
→ Khi ceil() làm T_est << target: bạn có thời gian dư. Có thể GIẢM vus
  nếu muốn tiết kiệm tài nguyên (nhưng phải verify T_est vẫn <= target).
```

**Bảng tổng kết**:

| N | T_target | W | vus_raw | vus=ceil | T_est verify | T_run | Đạt target? |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 80 | 10s | 0.5s | 4.00 | 4 | 10.0s | 10.0s | ✓ (khớp) |
| 100 | 8s | 0.5s | 6.25 | 7 | 7.14s | 7.5s | ✓ (sớm) |
| 50 | 20s | 0.5s | 1.25 | 2 | 12.5s | ~12.5s | ✓ (sớm) |
| 200 | 15s | 0.5s | 6.67 | 7 | 14.3s | ~14.3s | ✓ (sớm) |

Tất cả đều T_run <= T_target vì dùng ceil() và sleep cố định.

#### Tình huống 3: "Đã chạy xong, đọc summary"

Sau khi run xong, summary là nơi duy nhất cần đọc để kết luận test có chạy
đúng kế hoạch không.

Dùng output từ demo `shared_iterations_sizing_demo.js` (N=40, vus=4) làm mẫu:

```text
  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=500.37ms min=500.17ms med=500.32ms max=500.88ms
                           p(90)=500.55ms p(95)=500.88ms
    iterations...........: 40  7.994025/s
    vus..................: 4   min=4      max=4
    vus_max..............: 4   min=4      max=4

    NETWORK
    data_received........: 0 B 0 B/s
    data_sent............: 0 B 0 B/s

  running (0m05.0s), 0/4 VUs, 40 complete and 0 interrupted iterations
```

**── 4 dòng quan trọng trong EXECUTION ──**

| Dòng summary | Ký hiệu | Nghĩa | Giá trị mẫu | Đọc thế nào |
|---|---|---|---|---|
| `iteration_duration avg` | W | Thời gian 1 iter trung bình | 500.37ms | So với W dự kiến (0.5s) → khớp |
| `iterations` (count) | N_done | Số iter hoàn thành | 40 | So với config iterations=40 ✓ |
| `iterations X/s` | rate | Tốc độ trung bình toàn test | 7.99/s | So với CT2: peak=4/0.5=8.0 ≈ 7.99 ✓ |
| `vus min / max` | VU active | Số VU bận | 4 / 4 | shared-iterations: min=max, không tụt |

**── Footer progress ──**

```text
running (0m05.0s), 0/4 VUs, 40 complete and 0 interrupted iterations
         ↑          ↑        ↑              ↑
     T_run=5.0s  VU về 0  N_done=40     N_int=0
```

  T_run = 5.0s → khớp T_est (CT3: 40 × 0.5 / 4 = 5.0s)
  VU active cuối = 0/4 → tất cả VU đã xong, không còn VU bận
  N_done = 40 → khớp iterations config
  N_int = 0 → không iter nào bị cắt giữa chừng

**── 5 câu hỏi kiểm tra (theo thứ tự) ──**

```text
1. N_done có bằng iterations config không?
     N_done = 40, config iterations = 40 → khớp 100% ✓
     N_done + N_drop + N_int = 40 + 0 + 0 = 40 = config ✓
     (clean run — kho cạn đúng giờ)

2. iteration_duration avg có gần W dự kiến không?
     W dự kiến = 0.5s, thực tế = 500.37ms → khớp ✓
     Nếu lệch nhiều: code biến thiên, có thể do HTTP latency dao động

3. vus min = vus max = config?
     min=4, max=4, config vus=4 → shared-iterations giữ đúng ✓
     Nếu min < max: có VU chết hoặc init lỗi (hiếm)

4. Có dropped_iterations không?
     Không có dòng dropped_iterations trong summary → N_drop = 0 ✓
     Nếu có dropped_iterations: hit maxDuration giữa chừng (kho chưa cạn)
     → Tăng maxDuration hoặc tăng vus (Công thức 3)

5. iterations/s (rate) có gần peak_rate dự kiến không?
     CT2: peak = vus / W = 4 / 0.5 = 8.0 iter/s
     Summary: 7.99/s → gần đúng ✓
     Rate trong summary là AVERAGE rate (N_done / T_run), không phải peak
     tức thời. Với sleep cố định, hai con số xấp xỉ bằng nhau.
```

**── Với shared-iterations, summary có thêm dropped_iterations ──**

```text
Khác với constant-vus (KHÔNG có dropped_iterations), shared-iterations
CÓ THỂ có dropped_iterations nếu maxDuration quá ngắn.

Khi drop xảy ra, summary sẽ thêm dòng:
  dropped_iterations...: 8     0.266/s

Kiểm tra:
  N_done + N_drop = iterations (config)
  12 + 8 = 20 ✓   (xem demo shared_iterations_dropped_demo.js)
```

**── Trường hợp clean run (không drop) ──**

Dùng lại output mẫu trên:

```text
N_done = 40 = iterations (config) ✓
N_drop = 0                        ✓
N_int  = 0                        ✓
T_run  = 5.0s < maxDuration (2m) ✓
=> Hệ thống chịu được, scenario hoàn thành đúng kế hoạch
```

**── Trường hợp hit maxDuration ──**

Dùng output từ `shared_iterations_dropped_demo.js` (vus=2, iterations=5,
maxDuration=3s, sleep=2s):

```text
  EXECUTION
  iteration_duration...: avg=2001.2ms
  iterations...........: 4     0.666/s
  dropped_iterations...: 1     0.166/s
  vus..................: 2     min=2  max=2

  running (0m03.0s), 0/2 VUs, 4 complete and 0 interrupted iterations
```

Đọc:
  N_done = 4 < iterations config (5) → có hao hụt
  N_drop = 1 → đúng 1 iter trong kho chưa kịp lấy
  T_run = 3.0s = maxDuration → hit trần
  N_int = 0 → grace đủ, iter đang chạy không bị cắt

Verify cộng số:
  N_done + N_drop + N_int = 4 + 1 + 0 = 5 = iterations (config) ✓

→ Kết luận: maxDuration quá ngắn, kho chưa cạn. Cần tăng maxDuration
  hoặc tăng vus (đảo Công thức 3).

**── So sánh 3 executor qua summary ──**

```text
shared-iterations:  CÓ dropped_iterations (nếu hit maxDuration)
                    vus min = max (VU không tụt)
                    iterations là TỔNG, không per-VU
                    Cần kiểm: N_done, N_drop, W, T_run

constant-vus:       KHÔNG có dropped_iterations
                    vus min = max
                    Chỉ cần kiểm: N_done, W, N_int → đơn giản nhất

per-vu-iterations:  KHÔNG có dropped_iterations
                    vus tụt dần về 0 (min < max)
                    iterations là PER-VU
                    Cần kiểm: interrupted, vus tụt

constant-arrival-rate: CÓ dropped_iterations (do thiếu VU hoặc arrival rate)
                       vus có thể tụt
                       Cần kiểm: dropped_iterations, arrival rate
```

### 8.3. Hành động khi gặp vấn đề

#### "maxDuration tới mà chưa xong!"

Triệu chứng:

```text
N_done < iterations (config)
dropped_iterations > 0
T_run ≈ maxDuration
```

Nguyên nhân: kho iter chưa cạn, mà đã hết thời gian. Cách xử lý:

```text
1. (DỄ NHẤT) Tăng maxDuration
   -> Cho scenario thêm thời gian
   -> Ví dụ: từ "30s" lên "2m"

2. Tăng vus (nhiều VU hơn -> chia kho nhanh hơn)
   -> T_est = iterations × iter_time / vus
   -> Tăng vus đôi -> T_est giảm đôi

3. Giảm iterations (test ít iter hơn)
   -> Đơn giản nếu chỉ cần smoke test

4. Tối ưu code (giảm iter_time)
   -> Bỏ sleep dư, tối ưu logic
   -> iter_time giảm -> T_est giảm tỉ lệ
```

**Tip**: dùng Công thức 3 để tính `T_est` trước khi đặt `maxDuration`.
`maxDuration` nên gấp 2-3 lần `T_est` để có biên an toàn.

#### "Có dropped iterations!"

Triệu chứng:

```text
dropped_iterations > 0
```

Nguyên nhân **duy nhất** trong `shared-iterations`: hit `maxDuration`
trước khi cạn kho. Khác với `*-arrival-rate` (drop do thiếu VU), ở đây
drop chỉ do thời gian.

```text
Công thức tính số iter còn lại:
   N_remain = iterations - N_done
   N_drop ≈ N_remain
   (chính xác: N_drop = totalIters - attemptedIters,
    xem shared_iterations.go:213-228)
```

Cách xử lý: y hệt "maxDuration tới mà chưa xong" ở trên.

#### "VU phân phối lệch — VU0 chạy 8 iter, VU3 chạy 3 iter!"

Triệu chứng (đọc log từng VU):

```text
VU0: 8 iter
VU1: 5 iter
VU2: 4 iter
VU3: 3 iter
Tổng: 20 = iterations ✓
```

Nguyên nhân: **đây là bình thường, không phải bug**. Closed model với
atomic counter chia kho — VU nhanh chộp được iter mới sớm hơn -> chạy
nhiều hơn (xem Section 5.1 và Công thức 1).

```text
Khi nào "lệch" là OK:
  - Tổng iter đúng = iterations config ✓
  - Phân phối khớp với ratio = (1/t_i) / Σ(1/t_j)

Khi nào "lệch" là DỰNG nghi ngờ:
  - Có VU 0 iter -> có thể VU init lỗi
  - Tổng < iterations -> có drop, không phải "lệch"
```

**So sánh với `per-vu-iterations`**: nếu muốn mỗi VU đúng X iter, dùng
executor đó thay vì `shared-iterations`. Bài này không phù hợp khi
yêu cầu phân phối **đều**.

#### "Có interrupted iterations cuối test!"

Triệu chứng (đọc footer progress):

```text
running (Xs), 0/N VUs, A complete and B interrupted iterations
                                       ^^^^^^^^^^^
```

Nguyên nhân: iter chưa kịp xong khi `gracefulStop` hết. Cách xử lý:

```text
1. Tăng gracefulStop
   -> Cho iter cuối thêm thời gian xong
   -> Ví dụ: gracefulStop: "1m" thay vì default 30s

2. Tối ưu code (giảm iter_time)
   -> Iter ngắn hơn -> ít có khả năng vắt qua mốc cuối
```

Ít gặp với `shared-iterations` vì default `gracefulStop=30s` thường đủ.

### 8.4. Bảng từ vựng: ký hiệu nào nghĩa là gì?

> Section 3 dùng nhiều ký hiệu rút gọn cho gọn. Đây là bảng tra để bạn
> không phải lật lại đầu Section 3 mỗi lần.

| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
| --- | --- | --- | --- |
| `iterations` | "i-tờ-rây-sần" | Tổng iter chung scenario phải chạy | iter |
| `vus` | "vi-yu-x" | Số VU song song chia kho | VU |
| `iter_time` (`t`) | "i-tờ thai-im" | Thời gian 1 iter chiếm 1 VU | giây/iter |
| `t_i` | "ti i" | Thời gian 1 iter của VU thứ i | giây |
| `T_est` | "ti et-x" | Thời gian ước lượng scenario chạy | giây |
| `T_run` | "ti rần" | Thời gian thực tế scenario chạy | giây |
| `T_max` | "ti mác-x" | Trần wall-clock = min(maxDuration, T_est) + grace | giây |
| `peak_rate` | "pic rết" | Throughput đỉnh = vus / iter_time | iter/s |
| `ratio_i` | "ra-ti-ô i" | Tỷ lệ iter VU thứ i nhận | tỷ lệ |
| `iter_per_vu` | "i-tờ pờ-vi-yu" | Số iter trung bình mỗi VU | iter |
| `N_done` | "ren đần" | Số iter HOÀN THÀNH | iter |
| `N_drop` | "ren đờ-rốp" | Slot trong kho chưa được lấy | iter |
| `N_int` | "ren in-tờ" | Iter đã start nhưng bị cancel | iter |
| `M_peak` | "em pic" | Số VU bận cao nhất (= vus với closed model) | VU |
| `gracefulStop` | "grây-x-phun stóp" | Grace cuối scenario (default 30s) | giây |
| `maxDuration` | "mác-x đu-rây-sần" | Trần wall-clock (default 10m) | giây |

### 8.5. 3 công thức "1 dòng" để giải mọi case (nhớ vĩnh viễn)

```text
Mỗi VU làm bao nhiêu? ≈ iterations / vus
Hết bao lâu?           T ≈ iterations × iter_time / vus
Throughput đỉnh?       peak ≈ vus / iter_time
```

Học thuộc 3 dòng này là dùng được 80% nhu cầu thực tế với
`shared-iterations`. 3 dòng này tương ứng với 3 câu hỏi:

```text
"Ai làm gì?"     -> iter_per_vu
"Bao giờ xong?"  -> T_est
"Đỉnh đến đâu?"  -> peak_rate
```

### 8.6. Đọc output sau test: tìm số ở đâu?

Sau khi `k6 run` xong, bạn sẽ thấy 3 nhóm số liệu. Phải biết tìm từng
con số ở đâu để **áp vào đúng công thức** đã học ở 8.1.

**Bảng mapping nhanh: số ở đâu → dùng cho công thức nào**:

```text
| Số liệu                  | Đọc ở đâu                      | Dùng cho công thức |
| ------------------------ | ------------------------------ | ------------------ |
| vus, iterations          | Header "X iterations / Y VUs"  | CT 1, 4 (verify)   |
| maxDuration              | Header "maxDuration: ..."      | CT 5 (verify)      |
| W (iter_time)            | Summary iteration_duration     | CT 1, 2, 4         |
| N_done                   | Summary iterations count       | CT 5 (verify)      |
| actual_rate              | Summary iterations rate        | CT 2 verify (peak) |
| dropped_iterations       | Summary dropped (nếu có)       | CT 5               |
| T_run                    | Footer "running (X.Xs)"        | CT 1, 5 (so T_est) |
| N_int                    | Footer "X interrupted"         | CT 5               |
| __ITER per VU            | Log custom (đọc trong code)    | CT 3 (phân phối)   |
```

#### Nhóm 1: Header (in ra ngay đầu test)

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 10m30s max duration (incl. graceful stop):
         * my_scenario: 20 iterations shared among 4 VUs (maxDuration: 10m0s)
```

Đọc các con số:

```text
"4 max VUs"                  <- vus (config)
"10m30s max duration"         <- maxDuration + gracefulStop = 10m + 30s
"20 iterations shared"        <- iterations (config)
"4 VUs"                        <- vus (lần nữa, ở description)
"maxDuration: 10m0s"           <- maxDuration (config)
```

**Khi nào đọc**: ngay đầu để verify config đã parse đúng.

Code ref: `shared_iterations.go:69-73` (function `GetDescription()`).

#### Nhóm 2: Summary cuối test (block "TOTAL RESULTS")

```text
EXECUTION
iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
iterations...........: 20    8.0/s
vus..................: 4     min=4  max=4
vus_max..............: 4     min=4  max=4

NETWORK (nếu code có HTTP)
http_reqs............: 40    16.0/s
```

Đọc các con số:

```text
iteration_duration avg     <- iter_time hiệu dụng (W)
iterations (count)         <- N_done (iter hoàn thành)
iterations (rate)          <- average_rate = N_done / T_run
vus (max)                  <- M_peak (= vus config với closed model)
vus_max                    <- vus config (instance đã init)
http_reqs (count)          <- nếu code có HTTP, ÷ N_done = req per iter
```

**Khi nào đọc**: sau khi test xong, để đánh giá kết quả.

#### Nhóm 3: Footer/progress (ngay trước summary)

```text
running (02.5s), 0/4 VUs, 20 complete and 0 interrupted iterations
```

Đọc các con số:

```text
"02.5s"                          <- T_run (thời gian thực tế chạy)
"0/4 VUs"                        <- VU đang bận / tổng VU init
"20 complete"                    <- N_done (khớp với summary)
"0 interrupted iterations"       <- N_int (KHÔNG có metric Counter riêng)
```

**Lưu ý**: `N_int` chỉ xuất hiện ở đây, không có trong summary. Phải đọc
dòng progress cuối cùng. (Cùng cơ chế với `*-arrival-rate`.)

#### Trường hợp có dropped iterations

Nếu hit `maxDuration`, summary sẽ thêm dòng:

```text
EXECUTION
iterations...........: 12    0.4/s
dropped_iterations...: 8     0.266/s
```

```text
dropped_iterations (count) <- N_drop
                              = totalIters - attemptedIters
                              (xem shared_iterations.go:213-228)
```

Verify cộng số:

```text
N_done + N_drop + N_int = iterations (config)
12 + 8 + 0 = 20 ✓
```

### 8.7. Quy trình 5 bước phân tích output

Sau khi có đủ số liệu từ 8.6, làm 5 bước theo thứ tự. Mỗi bước **dùng
đúng 1 công thức từ 8.1**.

**Bảng mapping nhanh: Bước → Công thức → Số liệu cần**:

```text
| Bước | Công thức dùng       | Input cần              | Output                |
|------|----------------------|------------------------|-----------------------|
| 1    | verify Header        | Header + config        | Verify config OK      |
| 2    | CT 1 (T_est)         | iterations, vus, W     | T_est dự kiến         |
| 3    | CT 5 (so T_run)      | T_run từ footer        | Tỷ lệ T_run/T_est     |
| 4    | CT 5 (drop/int)      | N_drop, N_int          | Diagnose drop/int     |
| 5    | CT 3 (phân phối)     | __ITER per VU (log)    | Verify VU nhanh/chậm  |
```

#### Output mẫu để phân tích (dùng xuyên suốt 5 bước)

**Config đã chạy**:

```js
export const options = {
  scenarios: {
    demo_analyze: {
      executor: "shared-iterations",
      vus: 4,
      iterations: 20,
      maxDuration: "30s",
      gracefulStop: "30s",
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(0.5); }
```

**Output đầy đủ k6 in ra**:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 1m0s max duration (incl. graceful stop):
         * demo_analyze: 20 iterations shared among 4 VUs (maxDuration: 30s)

running (02.5s), 0/4 VUs, 20 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
    iterations...........: 20    8.0/s
    vus..................: 4     min=4  max=4
    vus_max..............: 4     min=4  max=4

  EXECUTION
  scenarios: 1 scenarios completed
```

Áp 5 bước dưới đây vào đúng output này.

#### Bước 1: Verify config có chạy đúng không

```text
Câu hỏi: header có khớp với config?

Header in:    "20 iterations shared among 4 VUs"
Config có:    iterations=20, vus=4
              -> KHỚP ✓

Header in:    "maxDuration: 30s"
Config có:    maxDuration="30s"
              -> KHỚP ✓

Header in:    "1m0s max duration (incl. graceful stop)"
Config có:    maxDuration=30s + gracefulStop=30s = 60s = 1m
              -> KHỚP ✓

KẾT LUẬN: config đã parse đúng -> sang Bước 2
```

#### Bước 2: Tính T_est (Công thức 3)

```text
T_est = iterations × iter_time / vus
     = 20 × 0.5 / 4
     = 2.5s
```

#### Bước 3: So với T_run thực tế (footer)

```text
Footer cho:   "running (02.5s)"  -> T_run = 2.5s
Tính từ Bước 2: T_est = 2.5s

So sánh:
  |T_run - T_est| / T_est = 0% lệch
  -> ước lượng đúng tuyệt đối

Phân loại:
  lệch < 5%   : ước lượng chính xác    <- DEMO RƠI VÀO ĐÂY
  lệch 5-15%  : có biến động nhẹ ở VU
  lệch > 15%  : VU lệch tốc độ nhiều, hoặc backend chậm dần
```

#### Bước 4: Verify N_done và check drop

```text
Summary cho:  iterations = 20      -> N_done = 20
Footer cho:   "20 complete and 0 interrupted" -> N_int = 0
Summary KHÔNG có dropped_iterations -> N_drop = 0

Verify cộng số:
  N_done + N_drop + N_int = 20 + 0 + 0 = 20 = iterations (config) ✓
  (clean run, không có hao hụt)

Diagnose:
  N_drop = 0  -> không hit maxDuration, kho cạn đúng giờ
  N_int = 0   -> grace đủ, không có iter cắt đôi
```

#### Bước 5: Tính throughput đỉnh và phân phối VU

```text
Tính peak_rate (Công thức 2):
  peak_rate = vus / iter_time
           = 4 / 0.5
           = 8 iter/s

Đối chiếu:
  Summary cho: iterations rate = 8.0/s
  Tính ra:     peak_rate = 8 iter/s
  -> KHỚP TUYỆT ĐỐI ✓

Tính iter_per_vu (Công thức 5):
  iter_per_vu ≈ iterations / vus = 20 / 4 = 5

  Vì code đồng đều (cùng sleep(0.5)), kỳ vọng:
    VU0=5, VU1=5, VU2=5, VU3=5
  Nếu thực tế lệch chút (±1-2 iter), vẫn OK.

Kết luận:
  - Test chạy clean, không drop, không interrupt
  - Throughput đỉnh = average rate = 8 iter/s (vì closed model
    giữ ổn định suốt run)
  - Mỗi VU làm trung bình 5 iter
  - Sizing tốt, không cần điều chỉnh

Nếu muốn test với tổng iter LỚN HƠN, scale theo công thức:
  T_est = N × 0.5 / 4 = N/8 giây
  -> N=200: T_est=25s    -> maxDuration="1m" đủ
  -> N=2400: T_est=300s  -> phải tăng maxDuration="6m"
```

---

**Tổng kết cheat sheet**: bạn đã có 5 công thức TOP, 3 công thức 1 dòng,
bảng từ vựng, cách đọc output, và quy trình 5 bước. Đủ để dùng
`shared-iterations` thực tế. Khi gặp case nâng cao (VU lệch tốc độ,
hit maxDuration, edge case timing), quay lại Section 3 và 6 đọc chi
tiết.
