# Vòng đời VU trong k6: open model, closed model, và counters

Bài này là bài mở đầu cho chuỗi học k6. Mục tiêu là nhìn được bức tranh lớn trước:
VU là gì, ai quyết định nhịp chạy, lúc nào VU được tạo, lúc nào được dùng, và các counter
`__VU` / `__ITER` / `exec.vu.*` thật sự nghĩa là gì.

## Mục lục nhanh

- [1. Bức tranh lớn](#1-bức-tranh-lớn)
- [2. Hai mô hình tải](#2-hai-mô-hình-tải)
- [3. VU lifecycle trong core](#3-vu-lifecycle-trong-core)
- [4. Ba loại VU](#4-ba-loại-vu)
- [5. Slot và drop](#5-slot-và-drop)
- [6. JS variables gắn với VU lifecycle](#6-js-variables-gắn-với-vu-lifecycle)
- [7. Đọc tiếp bài nào](#7-đọc-tiếp-bài-nào)
- [References](#references)

## 1. Bức tranh lớn

Trong k6, luồng suy nghĩ nên đọc theo thứ tự này:

```text
test script
  -> scenario
  -> executor
  -> scheduler
  -> VU pool
  -> active VU
  -> 1 iteration
```

Nếu nói ngắn:

```text
scenario chọn executor
executor quyết định nhịp load
scheduler chuẩn bị VU
VU thực thi iteration
```

Đây là 3 khái niệm cốt lõi:

```text
VU = worker chạy script
iteration = 1 lần chạy default() hoặc function được chỉ định
slot = 1 mốc start đã được lên lịch
```

Điểm quan trọng nhất của bài này:

```text
closed model = nhịp chạy phụ thuộc việc VU chạy xong hay chưa
open model   = nhịp chạy phụ thuộc lịch start
```

## 2. Hai mô hình tải

### 2.1 Closed model

Closed model là kiểu tải mà một VU xong việc rồi mới tự lấy việc tiếp theo.
Nhịp load vì vậy phụ thuộc thời gian chạy iteration.

Nhóm executor thường gặp:

```text
constant-vus
ramping-vus
per-vu-iterations
shared-iterations
```

Hiểu đơn giản:

```text
VU đang bận thì không start iteration mới
VU rảnh xong mới chạy tiếp
```

Ví dụ:

```js
executor: "constant-vus",
vus: 10,
duration: "30s",
```

Ở đây k6 giữ một số VU cố định và để chúng loop theo tốc độ tự nhiên của script.
Nếu iteration chậm hơn, throughput giảm. Nếu iteration nhanh hơn, throughput tăng.

### 2.2 Open model

Open model là kiểu tải mà k6 bắn ra các mốc start theo lịch thời gian.
Iteration mới được start theo schedule, không đợi iteration trước xong rồi mới chạy tiếp.

Nhóm executor thường gặp:

```text
constant-arrival-rate
ramping-arrival-rate
```

Hiểu đơn giản:

```text
đến giờ start thì phải có VU rảnh
không có VU rảnh thì mốc đó bị drop
```

Ví dụ:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
preAllocatedVUs: 10,
maxVUs: 50,
```

Ở đây k6 cố start 100 iteration / giây.
`preAllocatedVUs` là phần VU có sẵn từ đầu.
`maxVUs` là trần tổng số VU được phép có.

### 2.3 Một câu nhớ nhanh

```text
closed model = VU giữ nhịp
open model   = lịch start giữ nhịp
```

## 3. VU lifecycle trong core

Core chia vòng đời VU thành 3 pha dễ đọc:

```text
1. Scheduler Init phase
2. Execution phase
3. Teardown / shutdown
```

### 3.1 Scheduler Init phase

Ở pha init, scheduler nhìn toàn execution plan rồi tính số VU cần chuẩn bị.

```go
vusToInitialize := lib.GetMaxPlannedVUs(executionPlan)
```

`GetMaxPlannedVUs()` lấy mức planned VU lớn nhất ở bất kỳ thời điểm nào của execution plan,
không phải cộng tất cả executor lại một cách máy móc.

Sau đó scheduler tạo VU và đẩy vào pool chung:

```text
Scheduler.initVU()
  -> Runner.NewVU()
  -> ExecutionState.AddInitializedVU()
  -> es.vus
```

Đây là ý chính:

```text
planned VU = VU đã được init sẵn và đang chờ trong pool
```

Lưu ý quan trọng:

```text
planned VU chưa phải active VU
planned VU chỉ là worker đã sẵn sàng
```

### 3.2 Execution phase

Khi executor chạy thật, nó lấy VU ra từ pool bằng `GetPlannedVU()`.
Sau đó VU được `Activate()`, chạy 1 lần `RunOnce()`, rồi được trả lại bằng `ReturnVU()`.

Flow cơ bản:

```text
GetPlannedVU()
  -> Activate()
  -> RunOnce()
  -> ReturnVU()
```

Đây là điểm dễ nhầm:

```text
active VU không có nghĩa là VU đang ngồi không
active VU là VU đang chạy script thật, hoặc đang wind-down
```

Core còn có counter riêng cho việc này:

- `GetInitializedVUsCount()` = tổng VU đã init
- `GetCurrentlyActiveVUsCount()` = VU đang chạy hoặc đang wind-down

### 3.3 VU có thể được tạo hết lúc init không?

Có, nhưng chỉ với phần `planned VUs`.

Nói kỹ hơn:

```text
closed model
  -> thường init đủ planned VUs trước khi execution phase bắt đầu

open model
  -> init trước phần chắc chắn cần dùng
  -> phần vượt lên chỉ sinh thêm nếu còn quota
```

Với arrival-rate executors:

```text
preAllocatedVUs = phần init trước
maxVUs          = trần tổng VU
maxVUs - preAllocatedVUs = phần có thể sinh thêm trong lúc chạy
```

Nếu `maxVUs == preAllocatedVUs`, thì không còn chỗ cho unplanned VU nữa.

## 4. Ba loại VU

### Planned VUs

```text
VU đã được tạo trước và nằm trong pool chờ executor lấy
```

Thường do scheduler tạo ở init phase.

### Active VUs

```text
VU đang thực sự chạy iteration, hoặc đang hoàn tất nốt phần wind-down
```

Đây là số VU đang "bận việc".

### Unplanned VUs

```text
VU được tạo thêm giữa lúc test đang chạy nếu còn quota
```

Loại này chủ yếu xuất hiện ở open model, đặc biệt arrival-rate executors.

### Nhìn nhanh theo core

`es.vus` là pool chung chứa VU đã init xong nhưng chưa dùng ngay.
Executors chỉ mượn rồi trả lại, không tự giữ riêng.

| Loại | Nghĩa | Khi nào có |
|------|------|------------|
| planned VUs | VU đã init sẵn | Scheduler Init phase |
| active VUs | VU đang chạy thật | Execution phase |
| unplanned VUs | VU tạo thêm khi thiếu | Giữa test run |

## 5. Slot và drop

### 5.1 Slot là gì?

`slot` là **một mốc start đã được lên lịch** cho 1 iteration.
Nó không phải là một ô 1 giây, cũng không phải một khoảng chờ để gom việc.

Ví dụ với `rate: 4, timeUnit: "1s"`:

```text
0.00s -> slot 1
0.25s -> slot 2
0.50s -> slot 3
0.75s -> slot 4
1.00s -> slot 5
```

Trong `constant-arrival-rate`, các slot cách đều nhau.
Trong `ramping-arrival-rate`, khoảng cách giữa slot thay đổi theo đường ramp.

### 5.2 Drop là gì?

`drop` nghĩa là slot đã đến giờ nhưng không có VU rảnh ngay.

Core làm đúng theo đường này:

```text
1. tới giờ slot
2. thử lấy VU bằng TryRunIteration()
3. có VU rảnh -> chạy
4. không có VU rảnh -> slot bị drop
5. nếu còn quota, k6 mới khởi tạo thêm unplanned VU ở nền
6. VU mới chỉ giúp slot sau
```

Điểm mấu chốt:

```text
unplanned VU không cứu được slot vừa bị drop
```

Ví dụ:

```text
t = 20.0s: slot đến hạn, không có VU rảnh -> drop
t = 20.0s: k6 bắt đầu tạo thêm 1 VU ở nền
t = 22.0s: VU mới xong
=> từ đây nó mới giúp được các slot sau
```

### 5.3 Ramping arrival-rate khác gì?

Khác ở chỗ schedule không đều.
Rate tăng hay giảm theo stage curve, nhưng logic ở slot vẫn y nguyên:

```text
tới giờ start -> cần VU rảnh ngay
không có -> drop
```

## 6. JS variables gắn với VU lifecycle

### 6.1 `__VU`, `exec.vu.idInInstance`, `exec.vu.idInTest`

Trong JS script, `exec.vu` chỉ có ở execution context.
Nếu ở init context, `exec.vu` không dùng được.

Ý nghĩa:

```text
__VU                    = id của VU trong instance hiện tại
exec.vu.idInInstance    = cùng nghĩa với __VU
exec.vu.idInTest        = id global trên toàn test
```

Ví dụ:

```js
import exec from "k6/execution";

export default function () {
  console.log(exec.vu.idInInstance);
  console.log(exec.vu.idInTest);
}
```

### 6.2 `__ITER`, `exec.vu.iterationInInstance`, `exec.vu.iterationInScenario`

`__ITER` là counter theo VU và không reset khi VU đổi scenario.
Core tăng counter trước khi set vào runtime, nên lần chạy đầu tiên sẽ thấy `0`.

Ý nghĩa:

```text
__ITER                       = counter toàn cục của VU
exec.vu.iterationInInstance  = cùng nghĩa với __ITER
exec.vu.iterationInScenario  = counter theo từng scenario
```

Ví dụ dễ nhớ:

```text
VU chạy scenario A:
  __ITER = 0, 1, 2

VU đó quay sang scenario B:
  __ITER tiếp tục tăng
  exec.vu.iterationInScenario bắt đầu lại từ 0
```

### 6.3 `exec.scenario.*`

`exec.scenario` là metadata của scenario hiện tại.
Nó không phải slot schedule.

Những field hay gặp:

```text
name
executor
startTime
progress
iterationInInstance
iterationInTest
```

`startTime` ở đây là thời điểm scenario bắt đầu trong test.
Nó khác với `slot`, vì `slot` là mốc start của từng iteration.

## 7. Đọc tiếp bài nào

Nếu bạn mới học k6, nên đọc theo thứ tự này:

```text
1. bài này: bức tranh lớn
2. bài sâu hơn về VU lifecycle và counters
3. bài riêng cho từng executor: constant-vus, per-vu-iterations, shared-iterations
4. bài riêng cho arrival-rate: constant-arrival-rate, ramping-arrival-rate
```

Bài sâu hơn đã có sẵn:

- [`20260114_vu-lifecycle-and-iteration-counters.md`](./20260114_vu-lifecycle-and-iteration-counters.md)

## References

Core files đã đối chiếu:

- `lib/helpers.go`
- `lib/execution.go`
- `internal/execution/scheduler.go`
- `internal/js/runner.go`
- `internal/js/modules/k6/execution/execution.go`
- `lib/executor/constant_arrival_rate.go`
- `lib/executor/ramping_arrival_rate.go`

---

Nếu cần, bài tiếp theo có thể là:

- `constant-vus`
- `per-vu-iterations`
- `shared-iterations`
- `constant-arrival-rate`
- `ramping-arrival-rate`
