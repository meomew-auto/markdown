# VU Lifecycle và Iteration Counters trong k6

**Ngày phân tích**: 2026-01-14
**Mục đích**: Giải thích chi tiết cách VU ID được gán, iteration counters hoạt động, và VU reuse giữa các scenarios
**Liên quan**: 
- [execution.go](file:///e:/Projects/k6/lib/execution.go)
- [runner.go](file:///e:/Projects/k6/internal/js/runner.go)
- [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go)

---

## 1. Tổng Quan

Bài phân tích này giải thích các câu hỏi:
1. VU ID được assign khi nào?
2. VU ID có đổi không?
3. `iteration` (`__ITER`) reset khi chuyển scenario?
4. `iterationInScenario` reset khi chuyển scenario?
5. VU có được reuse giữa scenarios?

---

## 2. Code Flow

### VU Initialization Flow
```
Scheduler.Init()
    ↓
Scheduler.initVUsAndExecutors()
    ↓ vusToInitialize = GetMaxPlannedVUs(executionPlan)
Scheduler.initVUsConcurrently()
    ↓
Scheduler.initVU()
    ↓ vuIDLocal, vuIDGlobal = GetUniqueVUIdentifiers()
Runner.NewVU(ctx, vuIDLocal, vuIDGlobal, samplesOut)
    ↓
VU struct created with ID fields
    ↓
VU pushed to ExecutionState.vus channel
```

### VU Activation Flow (per scenario)
```
Executor.Run()
    ↓
ExecutionState.GetPlannedVU()
    ↓ vu := <-es.vus (lấy từ buffer channel)
InitializedVU.Activate(params)
    ↓ scenarioName = params.Scenario
ActiveVU created
    ↓
ActiveVU.RunOnce()
    ↓
ActiveVU.incrIteration()
    ↓ u.iteration++ (global)
    ↓ u.scenarioIter[scenarioName]++ (per-scenario)
```

### Demo nhỏ nhất: vì sao `[init]` in trước `[run]`?

Script demo: [examples/vu_creation_demo.js](file:///e:/Khoa%20hoc/k6/examples/vu_creation_demo.js)

```js
console.log(`[init] runtime created for __VU=${__VU}`);

export default function () {
  console.log(`[run] __VU=${__VU} __ITER=${__ITER}`);
  http.get("https://quickpizza.grafana.com/");
}
```

Chạy:

```bash
k6 run -v examples/vu_creation_demo.js
```

Output quan trọng:

```text
INFO[0000] [init] runtime created for __VU=1
INFO[0000] [init] runtime created for __VU=3
INFO[0000] [init] runtime created for __VU=2
INFO[0000] [run] scenario=watch_vus __VU=2 ... __ITER=0
INFO[0000] [run] scenario=watch_vus __VU=1 ... __ITER=0
INFO[0000] [run] scenario=watch_vus __VU=3 ... __ITER=0
INFO[0000] [init] runtime created for __VU=0
```

Giải thích luồng chạy:

1. `console.log()` nằm ở top-level của file JS, tức **init context**. Nó chạy mỗi khi k6
   instantiate một JS runtime mới từ bundle.
2. Scheduler tính `neededVUs=3`, rồi tạo planned VUs bằng:
   `Scheduler.initVU()` → `Runner.NewVU()` → `Bundle.Instantiate(ctx, vuID)`.
3. Khi mỗi planned VU được instantiate, k6 set `__VU` trong runtime (`__VU=1`, `2`, `3`),
   rồi chạy init code của script, nên `[init]` xuất hiện trước `[run]`.
4. Sau khi init xong, executor mới bắt đầu chạy:
   `Executor.Run()` → `GetPlannedVU()` → `Activate()` → `RunOnce()` → gọi `default()`.
   Lúc này mới có log `[run]`.
5. Thứ tự `__VU=1/2/3` không được đảm bảo vì VUs được init và chạy bằng goroutine, nên log
   có thể là `1,3,2` hoặc `2,1,3`.
6. Dòng `[init] __VU=0` ở cuối **không phải load VU**. Đó là runtime nội bộ/transient VU
   dùng cho lifecycle ngoài load, đặc biệt end-of-test summary/`handleSummary()`. Trong code,
   summary path gọi `Runner.newVU(summaryCtx, 0, 0, out)`, nên top-level init code chạy lại với
   `__VU=0`. Nếu chạy với `--summary-mode disabled`, dòng cuối này thường biến mất.

`__VU=0` cũng **không có nghĩa là có thêm một load goroutine thứ 4**. Với demo
`per-vu-iterations` và `vus: 3`, executor lấy 3 planned VUs rồi tạo 3 goroutine chạy load bằng
`go handleVU(initializedVU)`. Runtime `__VU=0` cho summary được tạo sau test để chạy summary code
trong `HandleSummary()`, không phải VU đang bơm traffic song song với 3 VUs. k6 vẫn có nhiều
goroutine nội bộ khác như scheduler, output, metrics, signal handling, HTTP internals; vì vậy
không nên đếm goroutine theo công thức `vus + __VU=0`.

Code-level note: `__VU=0` là một Sobek JS runtime nội bộ/tạm, không phải planned load VU.

Có 2 path thường gặp:

1. **Load script ban đầu**: `NewBundle()` tạo một VM tạm bằng `sobek.New()`, rồi gọi
   `bundle.instantiate(vuImpl, 0)` để chạy init context, đọc exports/options và populate cache.
2. **Lifecycle ngoài load**: `HandleSummary()` và `runPart()` gọi `Runner.newVU(ctx, 0, 0, out)`.
   `newVU()` gọi `Bundle.Instantiate(ctx, idLocal)`, trong đó `moduleVUImpl.runtime = sobek.New()`.

Cuối cùng `setupJSRuntime(rt, vuID, ...)` set:

```go
rt.Set("__VU", vuID)
```

Vì `vuID=0`, top-level JS nhìn thấy `__VU=0`.

Key point: **đếm load VUs bằng `__VU >= 1` hoặc debug log `Initialized VU #...`; không đếm
`__VU=0` là load VU.**

### Planned, Active, Unplanned VUs

`planned VUs` là số VU k6 biết chắc sẽ cần theo execution plan, nên scheduler tạo sẵn trong
Init phase trước khi executor bắt đầu chạy.

```go
vusToInitialize := lib.GetMaxPlannedVUs(e.executionPlan)
```

Sau đó scheduler tạo từng VU và bỏ vào pool:

```text
Scheduler.initVU()
  -> Runner.NewVU(...)
  -> ExecutionState.AddInitializedVU(...)
  -> es.vus channel
```

Phân biệt nhanh:

| Loại | Nghĩa | Tạo khi nào? |
|------|------|--------------|
| `planned VUs` | VUs được tính trước và pre-create | Scheduler Init phase |
| `active VUs` | VUs đang thật sự chạy iteration, hoặc đang graceful wind-down sau iteration đó | Execution phase |
| `unplanned VUs` | VUs có thể tạo thêm nếu runtime thiếu VU | Giữa test run |

Ví dụ `per-vu-iterations`:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 1,
    },
  },
};
```

Kết quả:

```text
planned VUs = 3
active VUs tối đa = 3
unplanned VUs = 0
```

Ví dụ `constant-vus`:

```js
executor: "constant-vus",
vus: 10,
duration: "30s",
```

Kết quả:

```text
planned VUs = 10
```

Với arrival-rate executors, `preAllocatedVUs` là planned VUs, còn `maxVUs` là trần tối đa:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
duration: "30s",
preAllocatedVUs: 10,
maxVUs: 50,
```

Kết quả:

```text
planned VUs = 10
max possible VUs = 50
unplanned VUs có thể tạo thêm = 40
```

Key point: **planned VU không đồng nghĩa với đang chạy**. Nó chỉ có nghĩa là VU đã được tạo
sẵn và đang nằm trong pool để executor lấy ra dùng.

Key point thêm: **active VU cũng không phải VU rảnh ngồi chờ**. Nó chỉ tính khi VU đang chạy
script thực tế, hoặc đang wind-down sau khi đã chạy xong iteration.

### Planned VU init time có tính vào `maxDuration` không?

Với các planned VUs, câu trả lời là:

```text
không tính vào maxDuration / scenario duration
```

Luồng đúng:

```text
k6 load script / đọc options
Scheduler.Init()
  -> initialize planned VUs
  -> init executors
Scheduler.Run()
  -> mark test started
  -> executor.Run()
  -> getDurationContexts()
  -> startTime = time.Now()
  -> bắt đầu tính maxDuration / gracefulStop
```

Nên nếu `vus` rất lớn:

```text
wall-clock từ lúc bấm k6 run
  có thể lâu hơn vì phải chờ init VUs

scenario maxDuration / exec.scenario.startTime / running time
  bắt đầu sau khi planned VUs init xong
```

Nói cách khác:

```text
planned VU init phase
  nằm trước execution phase

executor duration
  bắt đầu khi executor thật sự Run()
```

Code path cần nhớ:

```text
internal/execution/scheduler.go
  initVUsAndExecutors()
    -> initVUsConcurrently()
    -> "Finished initializing needed VUs, start initializing executors..."

internal/cmd/run.go
  execScheduler.Init(...)
  waitInitDone()
  execScheduler.Run(...)

lib/executor/helpers.go
  getDurationContexts()
    -> startTime = time.Now()
```

Nhưng với `unplanned VUs` thì khác:

```text
unplanned VUs có thể được initialize giữa lúc test đang chạy
```

Vì vậy thời gian tạo unplanned VU có thể ảnh hưởng kết quả, nhất là với arrival-rate executors.
Core cũng log cảnh báo kiểu:

```text
Initializing an unplanned VU, this may affect test results
```

Key point:

```text
planned VU init time:
  không ăn vào scenario maxDuration

unplanned VU init time:
  có thể ăn vào run thật vì xảy ra trong execution phase
```

### `shared-iterations` và `per-vu-iterations` có start đủ `vus` không?

Có. Với hai executor này, khi executor bắt đầu chạy:

```text
k6 đã init đủ planned VUs theo config `vus`
executor lấy đủ số VU đó ra khỏi pool
mỗi VU được start trong một goroutine riêng
các VU chạy concurrent/song song
```

Ví dụ:

```js
vus: 4
```

thì luồng là:

```text
init đủ 4 planned VUs
executor lấy 4 VUs ra khỏi pool
start 4 goroutines chạy load
```

Nhưng phải tách cách chia việc:

```text
per-vu-iterations:
  mỗi VU có quota riêng
  ví dụ vus=4, iterations=3
  -> mỗi VU chạy đúng 3 iteration
  -> total = 4 * 3 = 12
  -> VU nhanh xong quota thì idle

shared-iterations:
  tất cả VU lấy việc từ pool chung
  ví dụ vus=4, iterations=12
  -> tổng toàn scenario = 12
  -> VU nào xong trước thì lấy tiếp
  -> số iteration từng VU không cố định
```

Lưu ý:

```text
start đủ vus
  không có nghĩa mọi thời điểm đều có đủ VU đang bận
```

Nghĩa là phải tách:

```text
1. VU đã được start / active
2. VU đang thật sự bận chạy một iteration
```

Ví dụ `per-vu-iterations`:

```text
vus = 4
iterations = 3

t=0s:
  4 VU đều đang chạy iteration

t=2s:
  2 VU nhanh đã xong quota -> idle
  2 VU chậm vẫn đang chạy
```

Lúc này:

```text
executor đã start đủ 4 VU
nhưng chỉ còn 2 VU đang bận chạy iteration
```

Ví dụ `shared-iterations`:

```text
vus = 4
iterations = 10
```

Đầu test:

```text
4 VU cùng lấy việc từ pool
```

Gần cuối:

```text
pool chỉ còn 1 iteration cuối
-> chỉ 1 VU đang chạy iteration cuối
-> 3 VU còn lại không còn việc để claim
```

Về cuối test:

- `per-vu-iterations`: VU nhanh có thể đã xong quota và idle
- `shared-iterations`: pool gần hết thì có thể chỉ còn vài VU chạy nốt iteration cuối

### Unplanned VUs: tạo thêm giữa lúc test chạy

`unplanned VUs` là VUs không được tạo sẵn trong Scheduler Init phase, nhưng có thể được tạo thêm
giữa lúc test đang chạy nếu executor cần thêm VU và vẫn chưa vượt `maxVUs`.

Trường hợp phổ biến là arrival-rate executors:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
duration: "30s",
preAllocatedVUs: 10,
maxVUs: 50,
```

Ý nghĩa:

```text
preAllocatedVUs = 10  -> planned VUs, tạo trước test
maxVUs = 50           -> trần tối đa executor được dùng
unplanned VUs = 40    -> có thể tạo thêm runtime nếu thiếu
```

Luồng runtime:

```text
arrival-rate đến giờ start iteration
  -> thử lấy VU rảnh từ pool local
  -> nếu có VU rảnh: chạy iteration
  -> nếu không có VU rảnh:
       drop iteration hiện tại
       nếu còn quota unplanned:
         signal tạo thêm VU
         GetUnplannedVU()
         InitializeNewVU()
         scheduler.initVU()
         Runner.NewVU()
         activate VU mới
```

Code chính:

```go
// constant_arrival_rate.go
if vusPool.TryRunIteration() {
    continue
}
// không có VU rảnh -> dropped iteration
if remainingUnplannedVUs > 0 {
    makeUnplannedVUCh <- struct{}{}
    remainingUnplannedVUs--
}
```

```go
// execution.go
func (es *ExecutionState) GetUnplannedVU(ctx context.Context, logger *logrus.Entry) (InitializedVU, error) {
    remVUs := atomic.AddInt64(es.uninitializedUnplannedVUs, -1)
    if remVUs < 0 {
        return es.GetPlannedVU(logger, false)
    }
    return es.InitializeNewVU(ctx, logger)
}
```

`per-vu-iterations` **không tạo unplanned VUs**. Nó là closed model: scheduler biết trước đúng số
VU cần dùng qua `vus`, tạo sẵn chừng đó planned VUs, rồi executor chỉ gọi `GetPlannedVU()`.

Ví dụ:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 2,
```

Kết quả:

```text
planned VUs = 3
unplanned VUs = 0
total iterations = 3 * 2 = 6
```

Key point: **unplanned VUs chủ yếu thuộc nhóm arrival-rate executors** (`constant-arrival-rate`,
`ramping-arrival-rate`). Nếu một arrival-rate test phải tạo unplanned VUs trong lúc chạy, kết quả
có thể bị nhiễu vì k6 vừa tạo JS runtime vừa bắn traffic; nên sizing nghiêm túc thường đặt
`preAllocatedVUs` đủ cao để ít hoặc không cần unplanned VUs.

---

## 3. Key Components

### 3.1 VU ID Assignment

- **File**: [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go#L124-L140)
- **Function**: `initVU()`
- **Purpose**: Gán VU ID duy nhất trước khi test bắt đầu

```go
// internal/execution/scheduler.go:124-140
func (e *Scheduler) initVU(
    ctx context.Context, samplesOut chan<- metrics.SampleContainer, logger logrus.FieldLogger,
) (lib.InitializedVU, error) {
    // Get the VU IDs here, so that the VUs are (mostly) ordered by their
    // number in the channel buffer
    vuIDLocal, vuIDGlobal := e.state.GetUniqueVUIdentifiers()
    vu, err := e.state.Test.Runner.NewVU(ctx, vuIDLocal, vuIDGlobal, samplesOut)
    ...
}
```

**Key point**: VU ID được gán **một lần duy nhất** trong `initVU()` và không bao giờ thay đổi.

### 3.2 VU Struct và Iteration Counters

- **File**: [runner.go](file:///e:/Projects/k6/internal/js/runner.go#L699-L722)
- **Purpose**: Lưu trữ VU state và iteration counters

```go
// internal/js/runner.go:699-722
type VU struct {
    BundleInstance

    Runner    *Runner
    ...
    ID        uint64 // local to the current instance    ← VU ID (fixed)
    IDGlobal  uint64 // global across all instances      ← VU ID (fixed)
    iteration int64  //                                  ← Global iteration counter

    ...
    // count of iterations executed by this VU in each scenario
    scenarioIter map[string]uint64  // ← Per-scenario iteration counter (MAP!)
}
```

**Key point**: 
- `iteration`: Counter toàn cục, chỉ tăng, không reset
- `scenarioIter`: Map theo scenario name, cho phép track iteration riêng cho mỗi scenario

### 3.3 Iteration Increment Logic

- **File**: [runner.go](file:///e:/Projects/k6/internal/js/runner.go#L1005-L1018)
- **Function**: `incrIteration()`
- **Purpose**: Tăng cả global và per-scenario iteration counters

```go
// internal/js/runner.go:1005-1018
func (u *ActiveVU) incrIteration() {
    u.iteration++                    // ← Global: ALWAYS increments
    u.state.Iteration = u.iteration

    if _, ok := u.scenarioIter[u.scenarioName]; ok {
        u.scenarioIter[u.scenarioName]++   // ← Scenario exists: increment
    } else {
        u.scenarioIter[u.scenarioName] = 0 // ← New scenario: start from 0
    }
    ...
}
```

**Key point**: Khi VU gặp scenario mới lần đầu, `scenarioIter` bắt đầu từ 0.

### 3.4 VU Pool (Shared Channel Buffer)

- **File**: [execution.go](file:///e:/Projects/k6/lib/execution.go#L71-L110)
- **Purpose**: VU pool chung cho tất cả executors

```go
// lib/execution.go:71-110
type ExecutionState struct {
    ...
    // vus is the shared channel buffer that contains all of the VUs that have
    // been initialized and aren't currently being used by a executor.
    //
    // Different executors cooperatively borrow VUs from here when they are
    // needed and return them when they are done with them.
    vus chan InitializedVU
    ...
}
```

**Key point**: VUs được chia sẻ qua channel, executors "mượn" và "trả" VUs.

### 3.5 GetPlannedVU và ReturnVU

- **File**: [execution.go](file:///e:/Projects/k6/lib/execution.go#L459-L550)
- **Purpose**: Lấy VU từ pool và trả lại

```go
// lib/execution.go:459-489
func (es *ExecutionState) GetPlannedVU(logger *logrus.Entry, modifyActiveVUCount bool) (InitializedVU, error) {
    for i := 1; i <= MaxRetriesGetPlannedVU; i++ {
        select {
        case vu := <-es.vus:  // ← Lấy VU từ channel
            ...
            return vu, nil
        case <-time.After(MaxTimeToWaitForPlannedVU):
            logger.Warnf("Could not get a VU from the buffer for %s", ...)
        }
    }
    ...
}

// lib/execution.go:543-550
func (es *ExecutionState) ReturnVU(vu InitializedVU, wasActive bool) {
    es.vus <- vu  // ← Trả VU về channel
    ...
}
```

### 3.6 ReturnVU: trả về pool, không destroy VU

`ReturnVU()` nghĩa là trả `InitializedVU` gốc về pool chung `ExecutionState.vus`, không phải hủy
VU hay tạo lại VU mới.

Flow cơ bản:

```text
GetPlannedVU()  -> lấy VU khỏi es.vus pool
Activate()      -> gắn RunContext/scenario/exec/env/tags, tạo ActiveVU wrapper
RunOnce()       -> chạy default() hoặc function được config
ReturnVU()      -> trả InitializedVU gốc về es.vus pool
```

Với `per-vu-iterations`:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 2,
```

Mỗi VU chạy đủ 2 iterations rồi mới return:

```text
VU #1: __ITER=0 -> __ITER=1 -> ReturnVU(VU #1)
VU #2: __ITER=0 -> __ITER=1 -> ReturnVU(VU #2)
VU #3: __ITER=0 -> __ITER=1 -> ReturnVU(VU #3)
```

`ReturnVU()` không chạy sau từng iteration. Nó chạy khi activation context kết thúc, ví dụ:
executor hoàn thành, scenario hết duration, ramp-down, maxDuration/gracefulStop hoặc test bị
cancel.

Sau khi return, VU không chết. Nó trở lại trạng thái initialized/idle trong pool:

```text
active VU -> returned initialized VU -> idle trong es.vus
```

Nếu còn executor/scenario khác cần VU sau đó, `GetPlannedVU()` có thể lấy lại chính VU này. Khi
reuse:

- `__VU` / `VU.ID` giữ nguyên.
- JS runtime/Sobek runtime của VU vẫn là runtime đó.
- VU được `Activate()` lại với scenario/env/tags/exec mới.
- `__ITER` là counter theo VU, nên tiếp tục tăng, không reset.
- `exec.vu.iterationInScenario` là counter theo scenario, nên với scenario mới bắt đầu từ `0`.

Key point: **ReturnVU = trả về pool để có thể reuse; không phải destroy VU.**

---

## 4. Findings / Phát Hiện

### 4.1 VU ID Behavior
- ✅ VU ID được gán **một lần** trong initialization phase
- ✅ VU ID **cố định** suốt đời VU, không đổi khi reuse

### 4.2 Iteration Counter Behavior
- ✅ `iteration` (exposed as `__ITER`): **Never resets**, tăng liên tục
- ✅ `scenarioIter` (exposed as `exec.vu.iterationInScenario`): **Resets per scenario**
  - Thực ra không "reset" mà là **start fresh** cho mỗi scenario mới trong map

### 4.3 VU Reuse Behavior
- ✅ VUs **CÓ THỂ** được reuse giữa scenarios
- ⚠️ Trong practice, reuse chỉ xảy ra khi:
  1. Scenarios chạy **tuần tự** (không song song)
  2. Số VUs available < tổng VUs cần cho tất cả scenarios

### 4.4 Pre-initialization
- k6 tính `MaxPlannedVUs` = tổng VUs cần cho tất cả scenarios
- Tất cả VUs được init **trước khi** test bắt đầu
- Nếu scenarios chạy song song, mỗi scenario lấy VUs riêng từ pool

---

## 5. Diagram: VU Lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│                     INITIALIZATION PHASE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  MaxPlannedVUs = scenario_a.vus + scenario_b.vus = 4                │
│                                                                     │
│  initVU() → VU #1 (ID=1, iteration=0, scenarioIter={}) ──┐         │
│  initVU() → VU #2 (ID=2, iteration=0, scenarioIter={}) ──┼──▶ vus  │
│  initVU() → VU #3 (ID=3, iteration=0, scenarioIter={}) ──┤  channel│
│  initVU() → VU #4 (ID=4, iteration=0, scenarioIter={}) ──┘         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       EXECUTION PHASE                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  [Scenario A - Executor]                                            │
│    GetPlannedVU() → VU #1                                           │
│    Activate(scenario="a")                                           │
│    RunOnce() → iteration=1, scenarioIter={"a": 0}                   │
│    RunOnce() → iteration=2, scenarioIter={"a": 1}                   │
│    RunOnce() → iteration=3, scenarioIter={"a": 2}                   │
│    ReturnVU(VU #1)                                                  │
│                                                                     │
│  [Scenario B - Executor] (reuses VU #1)                             │
│    GetPlannedVU() → VU #1 (same VU!)                                │
│    Activate(scenario="b")                                           │
│    RunOnce() → iteration=4, scenarioIter={"a": 2, "b": 0}  ← NEW!   │
│    RunOnce() → iteration=5, scenarioIter={"a": 2, "b": 1}           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Summary Table

| Property | JS Variable | Behavior on Scenario Change | Source |
|----------|-------------|----------------------------|--------|
| VU ID | `__VU`, `exec.vu.idInTest` | **No change** | `VU.ID` |
| Global Iteration | `__ITER` | **Continues** (no reset) | `VU.iteration` |
| Scenario Iteration | `exec.vu.iterationInScenario` | **Starts from 0** | `VU.scenarioIter[scenario]` |

---

## 7. Kết Luận / Recommendations

1. **Sử dụng `exec.vu.iterationInScenario`** khi cần iteration counter độc lập cho mỗi scenario
2. **Sử dụng `__ITER`** khi cần iteration counter toàn cục cho VU
3. **Không giả định VU reuse** - behavior phụ thuộc vào timing của scenarios
4. **VU ID là stable identifier** - có thể dùng để correlate logs/metrics

## 8. References

- [k6 VU Lifecycle Documentation](https://k6.io/docs/misc/glossary/#virtual-user)
- [k6 Execution Context](https://k6.io/docs/using-k6/execution-context-variables/)
- Source files analyzed:
  - [execution.go](file:///e:/Projects/k6/lib/execution.go)
  - [runner.go](file:///e:/Projects/k6/internal/js/runner.go)
  - [scheduler.go](file:///e:/Projects/k6/internal/execution/scheduler.go)

---

## 9. ⚠️ CORRECTION: Kết Quả Test Thực Tế

> [!CAUTION]
> Phân tích ban đầu **SAI** ở một điểm quan trọng về cách k6 tính MaxPlannedVUs!

### Test Case

```javascript
// iteration_test.js
scenarios: {
    first:  { vus: 1, iterations: 2, maxDuration: '5s', startTime: 0 },
    second: { vus: 1, iterations: 2, maxDuration: '5s', startTime: '3s' },
}
```

### Dự đoán ban đầu (SAI ❌)

```
MaxPlannedVUs = max(1, 1) = 1  // Vì scenarios KHÔNG chạy song song
→ Chỉ init 1 VU
→ VU sẽ được reuse
→ __ITER sẽ tiếp tục từ 2 trong second scenario
```

### Kết quả thực tế (ĐÚNG ✅)

```
[first]  VU=2 | __ITER=0 | scenarioIter=0
[first]  VU=2 | __ITER=1 | scenarioIter=1
[second] VU=1 | __ITER=0 | scenarioIter=0
[second] VU=1 | __ITER=1 | scenarioIter=1

vus_max: 2
```

### Giải thích

1. **k6 init 2 VUs** (không phải 1 như dự đoán ban đầu)
2. **Lý do**: k6 tính overlap dựa trên `maxDuration`, không phải thời gian thực tế
   - `first`: 0s → 5s (maxDuration)
   - `second`: 3s → 8s (startTime + maxDuration)
   - **Overlap on paper**: 3s → 5s → cần 2 VUs concurrent
3. **Không có VU reuse** vì mỗi scenario dùng VU khác nhau
4. **`__ITER` đều = 0** vì là 2 VU riêng biệt, mỗi VU có counter riêng

### Key Insight

```
MaxPlannedVUs = max(sum of VUs at each time point based on maxDuration)
              ≠ max(sum of VUs at each time point based on actual runtime)
```

k6 **pre-calculates** VU requirements **trước khi test chạy**, dựa trên worst-case scenario (maxDuration), không thể biết iterations sẽ xong sớm hơn.

### Để force VU reuse

```javascript
scenarios: {
    first:  { vus: 1, iterations: 2, maxDuration: '2s' },  // 0s → 2s
    second: { vus: 1, iterations: 2, startTime: '3s', maxDuration: '2s' },  // 3s → 5s
}
// No overlap: 2s < 3s → MaxPlannedVUs = 1 → VU reuse!
```

