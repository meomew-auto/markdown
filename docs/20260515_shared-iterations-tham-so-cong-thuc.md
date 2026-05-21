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
- [Checklist core đã lọc](#13-checklist-core-đã-lọc-cho-shared-iterations)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Khác gì với `per-vu-iterations`](#4-khác-gì-với-per-vu-iterations)
- [Demo phân phối iteration](#5-demo-phân-phối-iteration)
- [Demo đếm từng VU nhanh/chậm](#51-demo-đếm-từng-vu-nhanhchậm)
- [Demo QuickPizza 2 requests](#6-demo-quickpizza-2-requests--iteration)
- [Cheat sheet](#7-cheat-sheet)

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
  nhưng pool chỉ còn 1 iteration cuối
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

### 1.3. Checklist core đã lọc cho `shared-iterations`

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

## 6. Demo QuickPizza `2 requests / iteration`

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

## 7. Cheat sheet

```text
executor = "shared-iterations"

iterations
  = tổng iteration của scenario

vus
  = số VU cùng chia nhau tổng iteration

total_iterations_target
  = iterations

sum(iterations_per_vu_i)
  = completed_iterations

completed_iterations
  = iterations nếu không bị drop/interrupt

average_iteration_rate
  = completed_iterations / summary_runtime_base

summary iterations/s
  = average_iteration_rate của toàn scenario
  không nhân thêm vus

per_vu_rate
  ≈ 1 / effective_iteration_time

peak_total_rate
  ≈ active_vus * per_vu_rate

estimated_http_reqs_count_if_fixed_path
  = completed_iterations * http_requests_per_iteration

estimated_http_reqs_rate_if_fixed_path
  = estimated_http_reqs_count_if_fixed_path / summary_runtime_base

VU nhanh
  có thể chạy nhiều iteration hơn VU chậm
```
