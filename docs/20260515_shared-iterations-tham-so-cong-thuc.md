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
docs/20260515_shared_iterations_quickpizza_two_requests_worked_example.md
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

### 8.1. 5 công thức TOP cần thuộc lòng

#### Công thức 1: "Chia kho thế nào?" (Phân phối iter giữa các VU)

```text
ratio_i = (1/t_i) / Σ(1/t_j)
iterations_per_vu_i ≈ ratio_i × iterations
```

**Tiếng Việt**: "Tỷ lệ iter VU thứ i nhận = (1 chia thời gian 1 iter của
VU đó) chia cho (tổng 1/thời gian của tất cả VU)". VU nhanh nhận nhiều,
VU chậm nhận ít.

**Ví dụ đời thường**:

```text
3 nhân viên cùng đóng gói 90 cái hộp:
  - A nhanh: 1 hộp/phút  -> 1/1 = 1
  - B vừa:  1 hộp/2 phút -> 1/2 = 0.5
  - C chậm: 1 hộp/3 phút -> 1/3 ≈ 0.33
  Tổng = 1 + 0.5 + 0.33 ≈ 1.83

Tỷ lệ:
  A: 1/1.83    ≈ 54.6%  -> A đóng ≈ 49 hộp
  B: 0.5/1.83  ≈ 27.3%  -> B đóng ≈ 25 hộp
  C: 0.33/1.83 ≈ 18.0%  -> C đóng ≈ 16 hộp
                          ----------
                          Tổng = 90 hộp ✓
```

**Áp vào k6**:

```text
vus=3, iterations=90
  - VU0 sleep(1)   -> t0 = 1.0s  -> 1/t = 1.0
  - VU1 sleep(2)   -> t1 = 2.0s  -> 1/t = 0.5
  - VU2 sleep(3)   -> t2 = 3.0s  -> 1/t = 0.33
  Σ(1/t) ≈ 1.83

iter VU0 ≈ 1.00/1.83 × 90 ≈ 49
iter VU1 ≈ 0.50/1.83 × 90 ≈ 25
iter VU2 ≈ 0.33/1.83 × 90 ≈ 16
                              ---
                              90 ✓
```

**Khi nào dùng**: muốn dự đoán VU nào sẽ chạy nhiều iter, hoặc giải
thích tại sao log thấy VU0 chạy 49 iter còn VU2 chạy 16 iter.

**Lưu ý**: chỉ đúng khi clean run (cạn kho). Nếu hit `maxDuration`
giữa chừng, tỷ lệ vẫn giữ nhưng tổng < `iterations`.

#### Công thức 2: "Đỉnh là bao nhiêu?" (Throughput đỉnh)

```text
peak_rate ≈ vus / iter_time
```

**Tiếng Việt**: "Throughput đỉnh = số VU chia cho thời gian 1 iter".
Giống `constant-vus` lúc đầu run, vì cả 2 đều closed model với cùng
vus chạy song song.

**Ví dụ đời thường**:

```text
4 nhân viên đóng gói, mỗi cái mất 0.5 phút
=> mỗi phút đóng được 4 / 0.5 = 8 cái
=> peak = 8 cái/phút
```

**Áp vào k6**:

```text
vus=4, iter_time=0.5s (sleep(0.5))
=> peak_rate ≈ 4 / 0.5 = 8 iter/s
=> trong giây đầu, scenario tạo ra ~8 iter
```

**Khi nào dùng**: ước lượng trước scenario sẽ tạo bao nhiêu req/s đỉnh,
để xem hệ backend chịu nổi không.

#### Công thức 3: "Hết bao lâu?" (Thời gian chạy ước lượng)

```text
T_est ≈ iterations × iter_time / vus
```

**Tiếng Việt**: "Tổng thời gian chạy = (tổng iter × thời gian 1 iter)
chia cho số VU". Vì iter chia đều cho `vus` VU chạy song song.

**Ví dụ đời thường**:

```text
90 cái hộp, mỗi cái 1 phút, 3 nhân viên:
=> 90 × 1 / 3 = 30 phút
```

**Áp vào k6**:

```text
iterations=20, iter_time=0.5s, vus=4
=> T_est ≈ 20 × 0.5 / 4 = 2.5s

(So với output thực: scenario chạy ~2.5-3s, khớp)
```

**Khi nào dùng**: trước khi chạy, để biết test mất bao lâu — và quan
trọng là để chọn `maxDuration` đủ lớn (xem Công thức 4).

**Lưu ý**: chỉ là ước lượng. Nếu VU nhanh chậm khác nhau, T thực có
thể lệch chút. Nhưng sai số không quá 10-20%.

#### Công thức 4: "Trần wall-clock" (Tổng thời gian tối đa scenario)

```text
T_max = min(maxDuration, T_est) + gracefulStop
```

**Tiếng Việt**: "Thời gian tối đa scenario kéo dài = lấy số NHỎ HƠN
giữa (maxDuration) và (T ước lượng), cộng grace cuối".

**Ví dụ đời thường**:

```text
Đóng 90 hộp, ước 30 phút, sếp giới hạn 1h:
  min(60, 30) = 30 phút
  + grace 5 phút
  = 35 phút (tối đa scenario kéo dài)
```

**Áp vào k6**:

```text
Case A: T_est < maxDuration (ngon, kho cạn trước hạn)
  iterations=20, iter_time=0.5s, vus=4 -> T_est ≈ 2.5s
  maxDuration=10m
  T_max = min(10m, 2.5s) + 30s = 2.5s + 30s ≈ 32.5s

  Thực tế: scenario xong sau ~2.5s, không dùng grace.

Case B: T_est > maxDuration (kẹt, hit trần)
  iterations=20, iter_time=10s, vus=2 -> T_est ≈ 100s
  maxDuration=30s
  T_max = min(30s, 100s) + 30s = 60s

  Thực tế: scenario chạy 30s thì cắt, có dropped/interrupted.
```

**Khi nào dùng**: trước khi chạy, để biết scenario tối đa kéo dài bao
lâu, đặt `gracefulStop` cho phù hợp.

#### Công thức 5: "Mỗi VU làm bao nhiêu?" (Số iter trung bình mỗi VU)

```text
iter_per_vu ≈ iterations / vus
```

**Tiếng Việt**: "Số iter trung bình mỗi VU = tổng iter chia cho số VU".
Là **xấp xỉ thô** — thực tế VU nhanh hơn nhận nhiều, VU chậm hơn nhận
ít (xem Công thức 1).

**Ví dụ đời thường**:

```text
20 hộp chia cho 4 nhân viên:
  trung bình mỗi người 5 hộp
  (nhưng người nhanh có thể đóng 7, người chậm 3)
```

**Áp vào k6**:

```text
iterations=20, vus=4
=> iter_per_vu ≈ 5

Nếu VU đều tốc độ:
  VU0=5, VU1=5, VU2=5, VU3=5
Nếu VU lệch tốc độ (sleep khác nhau):
  có thể VU0=8, VU1=5, VU2=4, VU3=3 (tổng vẫn 20)
```

**Khi nào dùng**: ước lượng nhanh không cần biết tốc độ từng VU. Nếu
muốn chính xác hơn, dùng Công thức 1.

**Lưu ý**: chỉ chính xác khi tất cả VU đều cùng iter_time. Lệch nhau
thì dùng Công thức 1 (ratio).

### 8.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

```text
Bước 1: Quyết tổng iter cần (iterations)
   -> Ví dụ: muốn test 200 lượt request

Bước 2: Quyết số VU song song (vus)
   -> Ví dụ: 4 VU (vừa phải, không quá tải máy local)
   -> Ràng buộc: vus <= iterations

Bước 3: Đo iter_time (chạy thử 1 VU, xem iteration_duration)
   -> Ví dụ: 0.5s

Bước 4: Tính T_est (Công thức 3)
   T_est = iterations × iter_time / vus
        = 200 × 0.5 / 4 = 25s

Bước 5: Đặt maxDuration > T_est ít nhất 50%
   -> maxDuration = "1m" cho an toàn
   (default 10m thừa, nhưng không sao)
```

**Config xong**:

```js
{
  executor: "shared-iterations",
  vus: 4,
  iterations: 200,
  maxDuration: "1m",
}
```

#### Tình huống 2: "Đã có target tổng iter, cần bao nhiêu VU?"

```text
Câu hỏi: muốn xong 100 iter trong 10s, mỗi iter 0.5s, cần mấy VU?

Bước 1: Đảo ngược Công thức 3
   T_est = iterations × iter_time / vus
   <=> vus = iterations × iter_time / T_est

Bước 2: Áp số
   vus = 100 × 0.5 / 10 = 5 VU

Bước 3: Làm tròn LÊN (ceil) cho an toàn
   vus = ceil(5) = 5 (đã là số nguyên)
   -> nếu ra 4.7, lấy 5

Bước 4: Verify lại
   T_est = 100 × 0.5 / 5 = 10s ✓
```

**Công thức rút gọn**:

```text
vus = ceil(iterations × iter_time / target_duration)
```

#### Tình huống 3: "Đã chạy xong, đọc summary"

```text
3 con số quan trọng:
   iterations          = N_done   (số iter hoàn thành)
   dropped_iterations  = N_drop   (slot trong kho chưa lấy được)
   vus                 = M_peak   (số VU bận, thường = vus config)

3 câu hỏi cần trả lời:
   1) Có drop không?         N_drop > 0 = hit maxDuration giữa chừng
   2) iterations đủ không?    N_done có khớp config?
                              N_done + N_drop = iterations (config) ✓
   3) Thời gian chạy thực?    đọc footer "running (X.Xs)"
                              -> so với T_est xem khớp không
```

**Trường hợp clean run** (không drop):

```text
N_done = iterations (config)
N_drop = 0
T_run < maxDuration
=> hệ thống chịu được, scenario hoàn thành
```

**Trường hợp hit maxDuration**:

```text
N_done < iterations (config)
N_drop > 0
T_run = maxDuration (gần đúng)
=> kho chưa cạn nhưng hết giờ -> tăng maxDuration hoặc tăng vus
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
