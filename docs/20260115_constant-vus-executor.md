# constant-vus Executor và k6 Execution Phases

**Ngày phân tích**: 2026-01-15
**Mục đích**: Phân tích chi tiết executor time-based đơn giản nhất - `constant-vus`, và các giai đoạn thực thi của k6
**Liên quan**: 
- [constant_vus.go](file:///e:/Projects/k6/lib/executor/constant_vus.go)
- [execution.go](file:///e:/Projects/k6/lib/execution.go)
- [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go)

**File học mới hơn, đầy đủ công thức/demo hơn**:

- [`20260516_constant-vus-quick-index.md`](./20260516_constant-vus-quick-index.md)
- [`20260516_constant-vus-tham-so-cong-thuc.md`](./20260516_constant-vus-tham-so-cong-thuc.md)
- [`20260516_constant_vus_quickpizza_two_requests_worked_example.md`](./20260516_constant_vus_quickpizza_two_requests_worked_example.md)

---

## 1. k6 Execution Phases

### Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1: INITIALIZATION                                           │
│  • Parse options, derive scenarios                                  │
│  • Calculate MaxPlannedVUs                                          │  
│  • Init planned VUs → Push to channel buffer (pool)                │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 2: SETUP (optional)                                         │
│  • Run setup() function                                            │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 3: EXECUTION ← GetPlannedVU() happens here!                 │
│  • Executor.Run() → GetPlannedVU() → Activate() → RunOnce() x N    │
├─────────────────────────────────────────────────────────────────────┤
│  PHASE 4: TEARDOWN (optional)                                      │
│  • Run teardown() function                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Initialization

**File**: [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go#L252-L325)

```go
func (e *Scheduler) initVUsAndExecutors(...) error {
    vusToInitialize := lib.GetMaxPlannedVUs(e.executionPlan)
    doneInits := e.initVUsConcurrently(...)
    
    // Sau khi init xong:
    // - VUs được push vào es.vus channel
    // - Sẵn sàng cho executors lấy
}
```

### Phase 3: Execution

**File**: [execution.go](file:///e:/Projects/k6/lib/execution.go#L459-L489)

```go
func (es *ExecutionState) GetPlannedVU(...) (InitializedVU, error) {
    select {
    case vu := <-es.vus:    // ← LẤY TỪ CHANNEL BUFFER
        return vu, nil
    case <-time.After(MaxTimeToWaitForPlannedVU):
        logger.Warnf("Could not get a VU from the buffer...")
    }
}
```

---

## 2. constant-vus Executor Analysis

### Config Structure

**File**: [constant_vus.go:36-40](file:///e:/Projects/k6/lib/executor/constant_vus.go#L36-L40)

```go
type ConstantVUsConfig struct {
    BaseConfig
    VUs      null.Int           `json:"vus"`      // Số VUs chạy đồng thời
    Duration types.NullDuration `json:"duration"` // Thời gian chạy
}
```

### Default Values

**File**: [constant_vus.go:42-48](file:///e:/Projects/k6/lib/executor/constant_vus.go#L42-L48)

```go
func NewConstantVUsConfig(name string) ConstantVUsConfig {
    return ConstantVUsConfig{
        BaseConfig: NewBaseConfig(name, constantVUsType),
        VUs:        null.NewInt(1, false),   // Default: 1 VU
        // Duration: không có default, bắt buộc phải set
    }
}
```

### Execution Requirements

**File**: [constant_vus.go:87-98](file:///e:/Projects/k6/lib/executor/constant_vus.go#L87-L98)

```go
func GetExecutionRequirements(et *lib.ExecutionTuple) []lib.ExecutionStep {
    return []lib.ExecutionStep{
        {TimeOffset: 0,                            PlannedVUs: vus},  // Start
        {TimeOffset: duration + gracefulStop,      PlannedVUs: 0},    // End
    }
}
```

Đây là cách scheduler biết cần bao nhiêu VUs và trong bao lâu.

---

## 3. Run() Method - Core Logic

**File**: [constant_vus.go:125-206](file:///e:/Projects/k6/lib/executor/constant_vus.go#L125-L206)

### Step 1: Get Config Values

```go
numVUs := clv.config.GetVUs(clv.executionState.ExecutionTuple)
duration := clv.config.Duration.TimeDuration()
gracefulStop := clv.config.GetGracefulStop()
```

### Step 2: Create Contexts

```go
startTime, maxDurationCtx, regDurationCtx, cancel := getDurationContexts(parentCtx, duration, gracefulStop)
```

- `regDurationCtx`: Hết sau `duration` → ngừng tạo iterations mới
- `maxDurationCtx`: Hết sau `duration + gracefulStop` → force stop

### Step 3: Spawn VUs

```go
for i := int64(0); i < numVUs; i++ {
    initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)  // Lấy từ pool
    if err != nil {
        cancel()
        return err
    }
    activeVUs.Add(1)
    go handleVU(initVU)  // Mỗi VU chạy trong goroutine riêng
}
```

### Step 4: VU Loop (handleVU function)

```go
handleVU := func(initVU lib.InitializedVU) {
    ctx, cancel := context.WithCancel(maxDurationCtx)
    defer cancel()

    activeVU := initVU.Activate(getVUActivationParams(...))

    for {                            // INFINITE LOOP!
        select {
        case <-regDurationDone:      // Duration hết?
            return                   // Stop
        default:                     // Chưa hết
            runIteration(activeVU)   // Chạy JS function, lặp nhiều vòng tới khi hết duration
        }
    }
}
```

---

## 4. VU Flow Diagram

```
PHASE 1: INIT                    PHASE 3: EXECUTION
┌─────────────────────┐          ┌───────────────────────────────────┐
│                     │          │                                   │
│  Scheduler.initVU() │          │  ConstantVUs.Run()                │
│        │            │          │        │                          │
│        ▼            │          │        ▼                          │
│  NewVU(id=1)        │          │  for i := 0; i < numVUs; i++ {   │
│  NewVU(id=2)        │          │      GetPlannedVU() ──┐          │
│  NewVU(id=3)        │          │  }                    │ <-es.vus │
│        │            │          │        ┌─────────────┘          │
│        ▼            │          │        │                          │
│  es.vus <- vu ─────────────────────> [VU#1, VU#2, VU#3]            │
│                     │          │        │                          │
│ (VUs pushed to      │          │        ├──> go handleVU(VU#1)     │
│  channel buffer)    │          │        ├──> go handleVU(VU#2)     │
│                     │          │        └──> go handleVU(VU#3)     │
│                     │          │                                   │
│                     │          │  Each handleVU() runs:            │
│                     │          │    for { runIteration(vu) }       │
│                     │          │    until regDurationDone          │
│                     │          │                                   │
│                     │          │  End of duration:                 │
│                     │          │    ReturnVU() ──> es.vus <- vu    │
│                     │          │                                   │
└─────────────────────┘          └───────────────────────────────────┘
```

---

## 5. Timeline Example

```
Config: vus=3, duration=10s, gracefulStop=5s

t=0s                                t=10s              t=15s
│                                     │                  │
├─────────────────────────────────────┤──────────────────┤
│                                     │                  │
│  VU1: [i1][i2][i3]...[iN]           │  finish last     │
│  VU2: [i1][i2][i3]...[iM]           │  iteration       │
│  VU3: [i1][i2][i3]...[iP]           │                  │
│                                     │                  │
│       regDurationCtx active         │   gracefulStop   │
│       (iterations keep running)     │   (no new iters) │
│                                     │                  │
└─────────────────────────────────────┼──────────────────┤
                                      │                  │
                               regDurationDone      maxDurationCtx
                               (stop new iters)     done (force stop)
```

---

## 6. Key Differences vs per-vu-iterations

| Aspect | constant-vus | per-vu-iterations |
|--------|-------------|-------------------|
| **Loop condition** | Time-based | Iteration-based |
| **Config** | `duration` | `iterations` |
| **Số iterations** | Phụ thuộc thời gian chạy thực tế của iteration | Mỗi VU có quota `iterations`; tổng planned là `vus * iterations`, nhưng `maxDuration`/`gracefulStop` có thể làm xuất hiện dropped hoặc interrupted iterations |
| **Khi nào stop** | Khi hết `duration`; iteration đã start có thể hoàn tất trong `gracefulStop` | Khi hoàn thành đủ quota, hoặc chạm `maxDuration`/`gracefulStop` |

---

## 7. Shortcut Conversion

```javascript
// Shortcut
export const options = {
    vus: 10,
    duration: '30s',
};

// Internally converted to:
export const options = {
    scenarios: {
        default: {
            executor: 'constant-vus',
            vus: 10,
            duration: '30s',
        },
    },
};
```

**Conversion code**: [execution_config_shortcuts.go:21-26](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go#L21-L26)

---

## 8. VU Memory Structure - Tại sao nhiều VUs tốn RAM?

### Mỗi VU = 1 Sobek JS Runtime

**File**: [bundle.go:258-280](file:///e:/Projects/k6/internal/js/bundle.go#L258-L280)

```go
// Instantiate creates a new runtime from this bundle.
func (b *Bundle) Instantiate(ctx context.Context, vuID uint64) (*BundleInstance, error) {
    vuImpl := &moduleVUImpl{
        ctx:     ctx,
        runtime: sobek.New(),  // ← MỖI VU TẠO MỘT SOBEK RUNTIME MỚI!
        events: events{
            global: b.preInitState.Events,
            local:  event.NewEventSystem(100, b.preInitState.Logger),
        },
    }
    vuImpl.eventLoop = eventloop.New(vuImpl)  // ← Mỗi VU có event loop riêng
    ...
}
```

### VU bao gồm những gì?

| Component | Code | Mô tả |
|-----------|------|-------|
| **JS Runtime** | `sobek.New()` | Sobek JS engine instance |
| **Event Loop** | `eventloop.New(vuImpl)` | Xử lý async/Promise |
| **Module System** | `modules.NewModuleSystem(...)` | Import modules |
| **HTTP Transport** | `http.Transport` | Connection pooling |
| **Cookie Jar** | `cookiejar.Jar` | Cookie storage |
| **TLS Config** | `tls.Config` | TLS settings |

### Memory Estimate

```
Init 10,000 VUs:
├── Mỗi VU ≈ 2-10MB RAM (tùy script complexity)
├── 10,000 × 5MB = ~50GB RAM
└── OutOfMemory TRƯỚC khi test bắt đầu (Phase 1)
```

### Chết ở giai đoạn nào?

| Giai đoạn | Nguyên nhân | Symptoms |
|-----------|-------------|----------|
| **Phase 1 (Init)** | RAM exhausted | OOM killer, "signal: killed" |
| **Phase 3 (Execution)** | CPU/Network overload | 100% CPU, "too many open files" |

### Rule of Thumb

| VUs | RAM (ước tính) | Khả năng |
|-----|----------------|----------|
| 100 | ~500MB | OK |
| 1,000 | ~5GB | OK nếu đủ RAM |
| 10,000 | ~50GB | Cần server mạnh |
| 100,000 | ~500GB | Cần distributed k6 |

---

## 9. Bản học tiếp: constant-vus từ code core và demo thật

Phần này nối tiếp các bài `per-vu-iterations` và `shared-iterations`.

`constant-vus` là executor kiểu **closed model**: k6 giữ một số VU cố định, mỗi VU chạy xong một iteration thì tự bắt đầu iteration tiếp theo, miễn là chưa hết `duration`.

Nó khác hai executor đã học trước:

| Executor | Điều khiển chính | Tổng iteration biết trước không? |
|----------|------------------|----------------------------------|
| `per-vu-iterations` | mỗi VU chạy đúng N iteration | Có: `vus * iterations` |
| `shared-iterations` | cả scenario chia nhau N iteration | Có: `iterations` |
| `constant-vus` | chạy trong một khoảng thời gian | Không, phải chạy xong mới biết |

### 9.1. Cấu hình nhỏ nhất

```javascript
export const options = {
  scenarios: {
    constant_loop: {
      executor: "constant-vus",
      vus: 2,
      duration: "3s",
      gracefulStop: "2s",
    },
  },
};
```

Các tham số chính:

| Tên | Nghĩa |
|-----|------|
| `executor` | chọn executor, ở đây là `constant-vus` |
| `vus` | số VU chạy song song trong regular duration |
| `duration` | thời gian regular phase, bắt buộc phải có với `constant-vus` |
| `gracefulStop` | thời gian cho iteration đã bắt đầu được hoàn tất sau khi hết `duration` |

Trong code:

- `NewConstantVUsConfig()` đặt default `vus = 1`.
- `duration` không có default, thiếu là validation error.
- `Validate()` bắt `vus > 0`, `duration` phải có và `duration >= 1s`.
- Shortcut `options = { vus: 10, duration: "30s" }` được đổi thành scenario `constant-vus`.

Nguồn core:

```text
lib/executor/constant_vus.go
  ConstantVUsConfig
  NewConstantVUsConfig
  Validate

lib/executor/execution_config_shortcuts.go
  getConstantVUsScenario
  DeriveScenariosFromShortcuts
```

Lưu ý: nếu **không khai báo gì cả**, k6 không dùng `constant-vus`; case mặc định của bài mở đầu vẫn là `per-vu-iterations` với 1 VU, 1 iteration.

### 9.2. Planned VUs và vòng chạy trong core

`GetExecutionRequirements()` của `constant-vus` trả về:

```text
t=0                          PlannedVUs = vus
t=duration + gracefulStop     PlannedVUs = 0
```

Nghĩa là scheduler biết trước cần bao nhiêu planned VUs và pre-init chúng trước khi executor thật sự chạy.

Trong `Run()`:

```go
for range numVUs {
    initVU, err := clv.executionState.GetPlannedVU(clv.logger, true)
    activeVUs.Add(1)
    go handleVU(initVU)
}
```

Với `vus = 2`, executor lấy 2 planned VUs từ pool và chạy 2 goroutine load tương ứng. Đừng hiểu đây là toàn bộ goroutine của process k6, vì k6 còn goroutine cho scheduler, metrics, output, progress bar, runtime nội bộ, v.v. Nhưng riêng phần load VU của executor này là 2 VU chạy song song.

Trong mỗi VU:

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

Cách đọc:

- Một VU chỉ chạy **1 iteration tại một thời điểm**.
- Nhiều VU chạy song song với nhau.
- Khi hết `duration`, VU không bắt đầu iteration mới nữa.
- Iteration đã bắt đầu trước khi hết `duration` có thể chạy tiếp trong `gracefulStop`.
- Hết `duration + gracefulStop` thì `maxDurationCtx` đóng, iteration còn chạy sẽ bị interrupt.

### 9.3. Công thức thời gian

Ký hiệu:

| Ký hiệu | Nghĩa |
|---------|------|
| `V` | số VU, lấy từ `vus` |
| `D` | regular duration, lấy từ `duration` |
| `G` | graceful stop, lấy từ `gracefulStop` |
| `W_effective` | thời gian trung bình một iteration chiếm VU; không min thì gần bằng `iteration_duration.avg`, có `minIterationDuration` thì dùng `max(iteration_duration.avg, minIterationDuration)` |
| `summary_runtime_base` | mẫu số mà Counter summary dùng cho cột `/s`; có thể suy ra từ `count / rate` |
| `completed_iterations` | số iteration hoàn tất |

Công thức khung:

```text
max_wall_time = D + G

per_vu_rate ~= 1 / W_effective

peak_iteration_rate ~= V * per_vu_rate
                    ~= V / W_effective

average_iteration_rate = completed_iterations / summary_runtime_base
```

Với `constant-vus`, **không nên hiểu**:

```text
completed_iterations = vus * iterations
```

vì executor này không có tham số `iterations`.

Cách ước lượng số iteration hoàn tất khi `W` khá đều và `G` đủ cho iteration cuối finish:

```text
iterations_per_vu_approx ~= ceil(D / W)
completed_iterations_approx ~= V * ceil(D / W)
```

Nếu `G` không đủ, iteration cuối có thể bị interrupt, khi đó completed thấp hơn ước lượng.

### 9.4. Demo 1: VU lặp liên tục tới hết duration

File:

```text
examples/constant_vus_loop_demo.js
```

Code:

```javascript
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    constant_loop: {
      executor: "constant-vus",
      vus: 2,
      duration: "3s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(0.7);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
```

Chạy:

```powershell
rtk k6 run .\examples\constant_vus_loop_demo.js
```

Kết quả đã chạy:

```text
scenarios: 1 scenario, 2 max VUs, 5s max duration (incl. graceful stop)
* constant_loop: 2 looping VUs for 3s (gracefulStop: 2s)

iteration_duration...: avg=703.15ms min=700.22ms med=701.23ms max=716.87ms
iterations...........: 10  2.828882/s
vus..................: 2   min=2      max=2
vus_max..............: 2   min=2      max=2

running (3.5s), 0/2 VUs, 10 complete and 0 interrupted iterations
```

Log quan trọng:

```text
t=0.0s __VU=1 __ITER=0
t=0.0s __VU=2 __ITER=0
t=0.7s __VU=1 __ITER=1
t=0.7s __VU=2 __ITER=1
t=1.4s __VU=1 __ITER=2
t=1.4s __VU=2 __ITER=2
t=2.1s __VU=1 __ITER=3
t=2.1s __VU=2 __ITER=3
t=2.8s __VU=1 __ITER=4
t=2.8s __VU=2 __ITER=4
t=3.5s iteration cuối finish
```

Phân tích:

```text
V = 2
D = 3s
G = 2s
W ~= 0.703s

max_wall_time = D + G = 3 + 2 = 5s

per_vu_rate ~= 1 / 0.703 = 1.42 iter/s/VU
peak_iteration_rate ~= 2 * 1.42 = 2.84 iter/s

summary iterations/s = 2.828882 iter/s
summary_runtime_base ~= completed_iterations / iterations_rate
                      ~= 10 / 2.828882
                      ~= 3.53s
```

Vì mỗi iteration mất khoảng `0.7s`, mỗi VU bắt đầu iteration ở khoảng:

```text
0.0s, 0.7s, 1.4s, 2.1s, 2.8s
```

Iteration bắt đầu tại `2.8s` vẫn hợp lệ vì lúc đó chưa hết `duration=3s`. Nó finish ở khoảng `3.5s`, tức là nằm trong `gracefulStop`.

### 9.5. Demo 2: interrupt khi iteration dài hơn gracefulStop

File:

```text
examples/constant_vus_interrupt_demo.js
```

Code:

```javascript
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    interrupted_constant_vus: {
      executor: "constant-vus",
      vus: 1,
      duration: "3s",
      gracefulStop: "1s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  for (let i = 0; i < 10; i += 1) {
    console.log(`[tick] t=${elapsedSeconds()}s i=${i}`);
    sleep(1);
  }

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
```

Chạy:

```powershell
rtk k6 run .\examples\constant_vus_interrupt_demo.js
```

Kết quả đã chạy:

```text
scenarios: 1 scenario, 1 max VUs, 4s max duration (incl. graceful stop)
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

Vì:

```text
D = 3s
G = 1s
max_wall_time = 4s
iteration muốn chạy 10s
```

Iteration đầu tiên bắt đầu lúc `0s`, nhưng tới `4s` vẫn chưa xong, nên bị interrupt. Dòng `[iter-end]` không in ra vì code sau `sleep()` không chạy tiếp sau khi context bị cancel.

### 9.6. Dropped iterations có xuất hiện trong constant-vus không?

Thông thường: **không**.

Lý do: `constant-vus` không có target iteration count và cũng không có lịch start cố định kiểu arrival-rate. Nó chỉ lặp:

```text
while chưa hết duration:
  VU chạy xong iteration cũ thì bắt đầu iteration mới
```

Khi hết `duration`, k6 chỉ ngừng bắt đầu iteration mới. Những iteration "đáng lẽ có thể chạy thêm" không được tính là dropped, vì không có quota nào bị bỏ.

Trong core:

- `per_vu_iterations.go` có `droppedIterationMetric`.
- `shared_iterations.go` có `DroppedIterations`.
- `constant_arrival_rate.go` và `ramping_arrival_rate.go` có dropped khi không có VU rảnh cho slot đã schedule.
- `constant_vus.go` không push `dropped_iterations`.

Với `constant-vus`, case cần chú ý là:

```text
iteration đã started nhưng chưa finish trước duration + gracefulStop
=> interrupted iteration
```

không phải:

```text
iteration chưa started
=> dropped iteration
```

### 9.7. Demo 3: QuickPizza, 2 requests trong 1 iteration

File:

```text
examples/constant_vus_quickpizza_two_requests_demo.js
```

Mỗi iteration làm:

```text
GET https://quickpizza.grafana.com/
GET https://quickpizza.grafana.com/api/quotes
check home status
check quotes status
sleep(1)
```

Chạy:

```powershell
rtk k6 run .\examples\constant_vus_quickpizza_two_requests_demo.js
```

Kết quả đã chạy:

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

Suy ra:

```text
V = 4
D = 5s
G = 5s
completed_iterations = 12
http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24
```

Suy ngược `summary_runtime_base` từ Counter summary:

```text
summary_runtime_base ~= iterations / iterations_rate
                     ~= 12 / 2.333723
                     ~= 5.14s

summary_runtime_base ~= http_reqs / http_reqs_rate
                     ~= 24 / 4.667445
                     ~= 5.14s

summary_runtime_base ~= checks_total / checks_rate
                     ~= 24 / 4.667445
                     ~= 5.14s
```

Trong demo sạch 1 scenario này, `summary_runtime_base` khá gần thời gian run bạn đang nhìn thấy.
Nhưng khi giải thích công thức thì nên giữ đúng tên đó, đừng gọi chung là "runtime thật của
scenario", vì khi có nhiều scenario, có `startTime`, hoặc có `setup()`/`teardown()`, hai cách nhìn
có thể lệch nhau.

Vì 1 iteration có 2 HTTP requests:

```text
http_reqs_rate ~= iterations_rate * 2
               ~= 2.333723 * 2
               ~= 4.667446 req/s
```

Vì 1 iteration có 2 checks:

```text
checks_rate ~= iterations_rate * 2
            ~= 2.333723 * 2
            ~= 4.667446 checks/s
```

`http_req_duration.avg = 261.43ms` chỉ là thời gian trung bình của **một HTTP request**.

`iteration_duration.avg = 1.7s` là thời gian trung bình của **cả một vòng default function**, gồm:

```text
request 1
request 2
check 1
check 2
sleep(1)
JS overhead
```

Do đó không lấy:

```text
1 / http_req_duration.avg
```

để ra `iterations/s`. Muốn ước lượng capacity cho `constant-vus`, dùng thời gian VU bị bận cho cả
iteration, không dùng riêng `http_req_duration`. Nếu không có `minIterationDuration`, thời gian VU
bị bận gần bằng `iteration_duration`; nếu có `minIterationDuration`, dùng
`max(iteration_duration, minIterationDuration)`.

### 9.8. Công thức sizing cho constant-vus

Nếu mục tiêu là giữ `N` user đồng thời:

```text
vus = N
duration = thời gian muốn giữ tải
```

Nếu muốn ước lượng throughput sau khi đã đo được thời gian chiếm VU của một iteration:

```text
W_effective ~= iteration_duration.avg nếu không có minIterationDuration
W_effective ~= max(iteration_duration.avg, minIterationDuration) nếu có minIterationDuration

per_vu_rate ~= 1 / W_effective
total_iteration_rate ~= vus / W_effective
```

Ví dụ từ demo QuickPizza:

```text
W_effective ~= 1.7s
vus = 4

per_vu_rate ~= 1 / 1.7 = 0.588 iter/s/VU
total_iteration_rate ~= 4 / 1.7 = 2.35 iter/s

summary thực tế:
iterations = 12
iterations/s = 2.333723 iter/s
```

Nếu mỗi iteration là 1 business transaction, có thể xem:

```text
TPS ~= iterations/s
```

Nếu mỗi iteration có nhiều request, thì:

```text
RPS ~= http_reqs/s
TPS tùy cách bạn định nghĩa transaction
```

Trong demo QuickPizza:

```text
iterations/s = 2.333723 iter/s
http_reqs/s = 4.667445 req/s
```

Vì 1 iteration = 2 HTTP requests.

### 9.9. Khi nào dùng constant-vus?

Dùng khi câu hỏi là:

```text
Hệ thống chịu được bao nhiêu khi luôn có N user ảo đang hoạt động trong X phút?
```

Ví dụ:

```text
200 users giữ đều trong 10 phút
500 users giữ đều trong 30 phút
2000 users giữ đều sau khi ramp-up xong
```

`constant-vus` phù hợp để giữ mức tải ổn định, nhưng nó **không đảm bảo throughput cố định**. Throughput tăng/giảm theo thời gian iteration:

```text
iteration chậm hơn => mỗi VU quay vòng ít hơn => iterations/s giảm
iteration nhanh hơn => mỗi VU quay vòng nhiều hơn => iterations/s tăng
```

Nếu mục tiêu là:

```text
Luôn bắt đầu đúng 100 iteration/s
```

thì không dùng `constant-vus` làm công cụ chính, mà đi tiếp sang nhóm `arrival-rate` (`constant-arrival-rate`, `ramping-arrival-rate`).

---

## 10. References

- [constant_vus.go](file:///e:/Projects/k6/lib/executor/constant_vus.go)
- [execution.go](file:///e:/Projects/k6/lib/execution.go)
- [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go)
- [execution_config_shortcuts.go](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go)
- [bundle.go](file:///e:/Projects/k6/internal/js/bundle.go)
