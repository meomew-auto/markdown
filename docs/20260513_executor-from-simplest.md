# Executor từ đơn giản nhất trong k6

**Ngày phân tích**: 2026-05-13  
**Mục tiêu**: Đi từng executor từ nhỏ nhất, bắt đầu bằng case không khai báo options.

---

## 1. Case nhỏ nhất: không khai báo `options`

Script:

```js
import http from "k6/http";

export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

Theo code, khi script không khai báo `options.scenarios`, không có `duration`, không có
`iterations`, không có `stages`, k6 tạo scenario mặc định:

```js
export const options = {
  scenarios: {
    default: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10m",
      gracefulStop: "30s",
      exec: "default",
    },
  },
};
```

Kết quả thực tế:

```text
1 planned VU
1 active VU
1 iteration
0 unplanned VUs
```

---

## 2. Code path: shortcut options -> default scenario

File: `lib/executor/execution_config_shortcuts.go`

```go
func DeriveScenariosFromShortcuts(opts lib.Options, logger logrus.FieldLogger) (lib.Options, error) {
    result := opts

    switch {
    ...
    default:
        // No execution parameters whatsoever were specified, so we'll create a per-VU iterations config
        // with 1 VU and 1 iteration.
        result.Scenarios = lib.ScenarioConfigs{
            lib.DefaultScenarioName: NewPerVUIterationsConfig(lib.DefaultScenarioName),
        }
    }

    return result, nil
}
```

Ý nghĩa:

```text
No options
  -> DeriveScenariosFromShortcuts()
  -> NewPerVUIterationsConfig("default")
  -> scenario default
  -> executor per-vu-iterations
```

---

## 3. Default config của `per-vu-iterations`

File: `lib/executor/per_vu_iterations.go`

```go
func NewPerVUIterationsConfig(name string) PerVUIterationsConfig {
    return PerVUIterationsConfig{
        BaseConfig:  NewBaseConfig(name, perVUIterationsType),
        VUs:         null.NewInt(1, false),
        Iterations:  null.NewInt(1, false),
        MaxDuration: types.NewNullDuration(10*time.Minute, false),
    }
}
```

File: `lib/executor/base_config.go`

```go
func NewBaseConfig(name, configType string) BaseConfig {
    return BaseConfig{
        Name:         name,
        Type:         configType,
        GracefulStop: types.NewNullDuration(30*time.Second, false),
    }
}
```

Default quan trọng:

| Field | Giá trị |
|-------|---------|
| `executor` | `per-vu-iterations` |
| `scenario name` | `default` |
| `exec` | `default` |
| `vus` | `1` |
| `iterations` | `1` per VU |
| `maxDuration` | `10m` |
| `gracefulStop` | `30s` |

---

## 4. Vì sao đây là executor đơn giản nhất?

`per-vu-iterations` là closed model rất dễ đọc:

```text
Mỗi VU chạy đúng N iterations của nó.
Total iterations = vus * iterations.
Không tạo unplanned VUs.
Không chạy theo rate.
Không ramp up/ramp down.
```

Với default:

```text
vus = 1
iterations = 1
total iterations = 1 * 1 = 1
```

Flow:

```text
Scheduler Init:
  GetMaxPlannedVUs(...) = 1
  initVU() -> Runner.NewVU(...) -> AddInitializedVU(VU #1)

Executor Run:
  GetPlannedVU() -> VU #1
  Activate(scenario="default", exec="default")
  RunOnce() -> gọi export default function()
  ReturnVU(VU #1)
```

---

## 5. Thuật ngữ: iteration

### `export default` và `exec`

Trong một file/module JS, chỉ có **một** `default export`. Khi không cấu hình gì thêm, k6 dùng
`exec: "default"`, nên mỗi iteration sẽ gọi function được export default.

Ví dụ anonymous default function:

```js
export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

Có thể đặt tên function nhưng vẫn export default:

```js
function myTest() {
  http.get("https://quickpizza.grafana.com/");
}

export default myTest;
```

Hoặc:

```js
export default function myTest() {
  http.get("https://quickpizza.grafana.com/");
}
```

Cả ba cách trên đều chạy với config mặc định vì k6 vẫn thấy `default`.

Nếu muốn chạy function khác không phải default, export function đó theo tên và khai báo `exec`:

```js
export function loginFlow() {
  http.get("https://quickpizza.grafana.com/");
}

export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      exec: "loginFlow",
    },
  },
};
```

Key point: **một file chỉ có một default export; k6 mặc định chạy default export.** Muốn chạy
function khác thì dùng named export và set `exec`.

### `exec` là gì?

`exec` là **tên function JS mà scenario sẽ chạy cho mỗi iteration**.

Đừng nhầm `exec` với `executor`:

| Field | Ý nghĩa |
| --- | --- |
| `executor` | Cách k6 tạo lịch chạy: `per-vu-iterations`, `constant-vus`, `ramping-vus`, ... |
| `exec` | Function JS nào sẽ được gọi trong mỗi iteration của scenario đó |

Ví dụ:

```js
export function loginFlow() {
  http.get("https://quickpizza.grafana.com/");
}

export function browseFlow() {
  http.get("https://quickpizza.grafana.com/api/pizza");
}

export const options = {
  scenarios: {
    login: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      exec: "loginFlow",
    },
    browse: {
      executor: "per-vu-iterations",
      vus: 2,
      iterations: 3,
      exec: "browseFlow",
    },
  },
};
```

Ở đây cùng một file có 2 scenario:

- scenario `login` chạy function `loginFlow`
- scenario `browse` chạy function `browseFlow`

### `exec` có thể nhận giá trị gì?

Theo code, `exec` là string trong base config của executor:

```go
// lib/executor/base_config.go
Exec null.String `json:"exec"` // function name, externally validated
```

Nếu không khai báo `exec`, k6 dùng default:

```go
// lib/executor/base_config.go
func (bc BaseConfig) GetExec() string {
    exec := bc.Exec.ValueOrZero()
    if exec == "" {
        exec = consts.DefaultFn
    }
    return exec
}

// internal/lib/consts/js.go
DefaultFn = "default"
```

Vì vậy:

| `exec` | Hợp lệ khi nào? |
| --- | --- |
| không khai báo | k6 hiểu là `"default"` |
| `"default"` | file có `export default function ...` hoặc `export default myTest` |
| `"loginFlow"` | file có `export function loginFlow() { ... }` |
| `"browseFlow"` | file có `export function browseFlow() { ... }` |

Không hợp lệ:

| Case | Lỗi |
| --- | --- |
| `exec: ""` | `exec value cannot be empty` |
| `exec: "abc"` nhưng không export function `abc` | `function 'abc' not found in exports` |
| function có trong file nhưng không export | k6 không thấy, vẫn báo not found |
| export ra non-function | không được tính là callable export |

Ví dụ này **không chạy được** vì `loginFlow` không được export:

```js
function loginFlow() {
  http.get("https://quickpizza.grafana.com/");
}

export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      exec: "loginFlow",
    },
  },
};
```

### Code path của `exec`

k6 đi theo luồng này:

```text
Bundle.populateExports()
  -> quét các export trong JS module
  -> export nào là function thì đưa vào callableExports

deriveAndValidateConfig()
  -> validateScenarioConfig()
  -> execFn := conf.GetExec()
  -> Runner.IsExecutable(execFn)
  -> nếu không có trong callableExports thì lỗi

Executor chạy
  -> VU.Activate(params.Exec)
  -> ActiveVU.RunOnce()
  -> u.getCallableExport(u.Exec)
  -> runFn(...)
```

Các đoạn code chính:

```go
// internal/js/bundle.go
if _, ok := sobek.AssertFunction(v); ok && k != consts.Options {
    b.callableExports[k] = struct{}{}
    continue
}
```

```go
// internal/cmd/config.go
execFn := conf.GetExec()
if !isExecutable(execFn) {
    return fmt.Errorf("executor %s: function '%s' not found in exports", conf.GetName(), execFn)
}
```

```go
// internal/js/runner.go
fn := u.getCallableExport(u.Exec)
_, isFullIteration, totalTime, err := u.runFn(ctx, true, fn, cancel, u.setupData)
```

Lưu ý thêm: `setup` và `teardown` là các lifecycle function riêng. Khi học và viết test nên coi
chúng là tên reserved cho lifecycle, không dùng làm `exec` của scenario.

### `maxDuration` và `gracefulStop`

Với `per-vu-iterations`, executor có 2 mốc thời gian quan trọng:

| Field | Ý nghĩa |
| --- | --- |
| `maxDuration` | Hết mốc này executor không start iteration mới nữa |
| `gracefulStop` | Cửa sổ chờ để các iteration đã start được finish; hết cửa sổ này thì iteration còn dở có thể bị interrupt |

Timeline dễ hiểu:

```text
t = 0
|---------------- maxDuration ----------------|
                                              |
                                              v
                         không start iteration mới nữa
                                              |
                                              |--- gracefulStop ---|
                                                                  |
                                                                  v
                                            iteration còn chạy thì bị interrupt
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 100,
      maxDuration: "5s",
      gracefulStop: "3s",
    },
  },
};
```

Ý nghĩa:

```text
0s -> 5s:
  VU được chạy bình thường, executor còn có thể bắt đầu iteration mới.

5s -> 8s:
  executor không bắt đầu iteration mới nữa.
  Nếu có iteration đang chạy dở, k6 chờ nó finish.

sau 8s:
  iteration nào vẫn chưa xong sẽ bị interrupt.
```

Công thức trần thời gian cho một scenario:

```text
scenario max end = startTime + maxDuration + gracefulStop
```

Nếu không khai báo `startTime`:

```text
scenario max end = maxDuration + gracefulStop
```

Nhưng đây là **trần tối đa**, không phải thời gian bắt buộc phải chạy. Nếu `vus * iterations`
xong sớm thì scenario kết thúc sớm.

Ví dụ `vus: 1`, `iterations: 3`, `maxDuration: "10m"`, `gracefulStop: "30s"`:

```text
Nếu 3 iteration chạy xong trong 2s:
  test kết thúc khoảng 2s, không đợi đủ 10m30s.

Nếu iteration bị chậm:
  0 -> 10m: còn được start iteration mới
  10m -> 10m30s: chỉ chờ iteration đang chạy dở
  sau 10m30s: interrupt iteration chưa xong
```

Default của `per-vu-iterations`:

```go
// lib/executor/per_vu_iterations.go
MaxDuration: types.NewNullDuration(10*time.Minute, false)
```

Default chung của các executor:

```go
// lib/executor/base_config.go
var DefaultGracefulStopValue = 30 * time.Second
```

Trong execution plan, `per-vu-iterations` reserve VU tới `maxDuration + gracefulStop`:

```go
// lib/executor/per_vu_iterations.go
{
    TimeOffset: pvic.MaxDuration.TimeDuration() + pvic.GracefulStop.TimeDuration(),
    PlannedVUs: 0,
}
```

Ở runtime, k6 tạo 2 context:

```go
// lib/executor/helpers.go
maxEndTime := startTime.Add(regularDuration + gracefulStop)
maxDurationCtx, maxDurationCancel = context.WithDeadline(parentCtx, maxEndTime)
regDurationCtx, _ = context.WithDeadline(maxDurationCtx, startTime.Add(regularDuration))
```

Nói ngắn gọn:

```text
regDurationCtx done  -> hết maxDuration, không start iteration mới
maxDurationCtx done  -> hết maxDuration + gracefulStop, interrupt iteration còn chạy
```

CLI hiển thị `max duration (incl. graceful stop)` là đang nói phần trần:

```text
maxDuration + gracefulStop
```

Không phải nghĩa là test chắc chắn chạy đủ từng đó thời gian.

### Test copy để tự chạy

Để nhìn rõ cách k6 tính thời gian, dùng 2 file demo này:

- `examples/max_duration_finish_early.js`
- `examples/max_duration_interrupt_demo.js`

Code đầy đủ của file `examples/max_duration_finish_early.js`:

```js
import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - CLI says max duration is 12s (10s maxDuration + 2s gracefulStop).
// - Actual run ends after about 3s because all 3 iterations finish early.
export const options = {
  scenarios: {
    finish_early: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "10s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  if (__VU === 1 && __ITER === 0) {
    console.log(
      `[scenario] startTimeMs=${exec.scenario.startTime} startTimeISO=${new Date(exec.scenario.startTime).toLocaleTimeString()}`,
    );
  }

  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(1);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
```

Code đầy đủ của file `examples/max_duration_interrupt_demo.js`:

```js
import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - CLI says max duration is 5s (3s maxDuration + 2s gracefulStop).
// - Iteration #1 starts but is interrupted around t=5s.
// - Iteration #2 never starts, so it is counted as dropped_iterations.
export const options = {
  scenarios: {
    interrupted_demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "3s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

function sleepWithProgress(totalSeconds, step = 1) {
  for (let elapsed = 0; elapsed < totalSeconds; elapsed += step) {
    sleep(step);
    console.log(`[tick after sleep] t=${elapsedSeconds()}s`);
  }
}

export default function () {
  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleepWithProgress(10, 1);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
```

Note về cách log thời gian trong case interrupt:

- Log sau `sleep(step)` cho thấy từng đoạn đã sleep xong.
- Nếu interrupt xảy ra đúng lúc hết deadline, dòng tick cuối hoặc `[iter-end]` vẫn có thể không in.
- Nếu muốn đo tổng thời gian wall-clock, dùng `Measure-Command` của PowerShell.

#### Case 1: Hoàn thành sớm trước `maxDuration`

Command:

```bash
k6 run examples/max_duration_finish_early.js
```

Nếu muốn đo wall-clock time trên PowerShell:

```powershell
Measure-Command { k6 run examples/max_duration_finish_early.js } |
  Select-Object -ExpandProperty TotalSeconds
```

File này config:

```js
vus: 1,
iterations: 3,
maxDuration: "10s",
gracefulStop: "2s",
```

Mỗi iteration `sleep(1)`, nên 3 iteration xong khoảng 3 giây.

Điều cần quan sát:

- Header của k6 sẽ in:

```text
1 scenario, 1 max VUs, 12s max duration (incl. graceful stop)
```

- Nhưng log thực tế sẽ chỉ đi tới khoảng `t=3.0s`:

```text
[iter-start] ... t=0.0s __ITER=0
[iter-end]   ... t=1.0s __ITER=0
[iter-start] ... t=1.0s __ITER=1
[iter-end]   ... t=2.0s __ITER=1
[iter-start] ... t=2.0s __ITER=2
[iter-end]   ... t=3.0s __ITER=2
```

- Summary sẽ là:

```text
3 complete and 0 interrupted iterations
```

Kết luận:

```text
12s chỉ là trần tối đa.
Work xong sớm thì test kết thúc sớm, không chờ đủ 10s + 2s.
```

#### Case 2: Bị interrupt ở cuối `gracefulStop`

Command:

```bash
k6 run examples/max_duration_interrupt_demo.js
```

Nếu muốn đo wall-clock time trên PowerShell:

```powershell
Measure-Command { k6 run examples/max_duration_interrupt_demo.js } |
  Select-Object -ExpandProperty TotalSeconds
```

File này config:

```js
vus: 1,
iterations: 2,
maxDuration: "3s",
gracefulStop: "2s",
```

Nhưng mỗi iteration lại `sleep(10)`, nên không thể hoàn thành trong khung thời gian đó.

Điều cần quan sát:

- Header sẽ in:

```text
1 scenario, 1 max VUs, 5s max duration (incl. graceful stop)
```

- Chỉ thấy log bắt đầu iteration đầu tiên:

```text
[iter-start] ... t=0.0s __ITER=0
```

- Không có log `[iter-end]`, vì iteration đầu tiên bị cắt ở khoảng `t=5s`.

- Summary sẽ có:

```text
0 complete and 1 interrupted iterations
dropped_iterations: 1
```

- Bạn thường **không thấy** stacktrace kiểu `ERRO ...` trong case này.

Lý do:

```text
đây là interrupt do scheduler/context timeout
không phải script error nghiệp vụ như fail(), throw, hay exception trong JS
```

Core behavior:

- `sleep()` khi thấy `ctx.Done()` thì chỉ stop timer và return
- runner đánh dấu iteration là interrupted
- executor cộng vào `interrupted iterations`
- nhưng path này không log như một script exception thông thường

Ý nghĩa:

```text
iteration #1:
  đã start ở t=0s
  chạy qua mốc 3s
  được chờ thêm 2s gracefulStop
  bị interrupt ở khoảng t=5s

iteration #2:
  chưa kịp start trước khi hết maxDuration
  nên bị tính vào dropped_iterations
```

Ghi chú từ docs Grafana:

```text
với shared-iterations và per-vu-iterations,
dropped_iterations xảy ra khi scenario chạm maxDuration
trước khi tất cả iterations finish
```

Muốn thấy case sạch hơn, không có interrupted iteration mà vẫn có `dropped_iterations`, xem:

```text
examples/per_vu_iterations_dropped_demo.js
examples/shared_iterations_dropped_demo.js
```

Hai demo này để iteration đang chạy finish trong `gracefulStop`, nhưng iteration tiếp theo không
được start/claim vì `maxDuration` đã hết.

#### Biến thể: `gracefulStop: "0s"`

Nếu muốn thấy case **interrupt ngay khi chạm `maxDuration`**, sửa file
`examples/max_duration_interrupt_demo.js`:

```js
gracefulStop: "0s",
```

Khi đó:

```text
scenario max end = 3s + 0s = 3s
```

Kỳ vọng:

- test kết thúc quanh 3 giây thay vì 5 giây
- iteration đầu tiên bị interrupt sớm hơn
- iteration thứ hai vẫn không start

### `exec.scenario.*` không dùng được ở init context

Đây là lỗi rất hay gặp khi mới học `k6/execution`.

Ví dụ **sai**:

```js
import exec from "k6/execution";

console.log(`${exec.scenario.startTime}`);

export default function () {
  // ...
}
```

Lỗi:

```text
GoError: getting scenario information outside of the VU context is not supported
```

Lý do:

- top-level code của file JS chạy trong **init context**
- lúc đó script đang được load/parse, chưa có VU nào đang chạy iteration
- `exec.scenario.*` cần **VU context / scenario context**
- nên gọi ở top-level sẽ lỗi ngay

Phân biệt:

| Chỗ gọi | Có dùng `exec.scenario.*` được không? |
| --- | --- |
| top-level của file | Không |
| code init như `console.log()` ngoài `default()` | Không |
| bên trong `default()` | Có |
| bên trong function được scenario `exec` gọi | Có |

Ví dụ **đúng**:

```js
import exec from "k6/execution";

export default function () {
  console.log(`${exec.scenario.startTime}`);
}
```

Nếu chỉ muốn log 1 lần cho dễ nhìn:

```js
export default function () {
  if (__VU === 1 && __ITER === 0) {
    console.log(
      `startTimeMs=${exec.scenario.startTime} startTimeISO=${new Date(exec.scenario.startTime).toISOString()}`,
    );
  }
}
```

`function elapsedSeconds() { ... }` thì bản thân **không lỗi** nếu chỉ khai báo. Nó chỉ lỗi khi function đó
thực sự được gọi ở init context.

### `sleep()` được tính như nào?

`k6.sleep()` là **sleep đồng bộ của chính VU hiện tại**.

Implementation:

```go
// internal/js/modules/k6/k6.go
func (mi *K6) Sleep(secs float64) {
    ctx := mi.vu.Context()
    timer := time.NewTimer(time.Duration(secs * float64(time.Second)))
    select {
    case <-timer.C:
    case <-ctx.Done():
        timer.Stop()
    }
}
```

Nghĩa là:

- VU gọi `sleep()` thì **iteration vẫn đang chạy**
- chưa return khỏi `default()` / function của `exec`
- nên thời gian sleep **được tính vào elapsed time của iteration**
- và cũng **ăn vào `maxDuration` / `duration`** của executor

Ví dụ:

```js
export default function () {
  sleep(2);
}
```

Nếu iteration hoàn thành bình thường, `iteration_duration` sẽ xấp xỉ 2 giây, vì metric này được tính
từ `startTime` tới `endTime` của `runFn()`:

```go
// internal/js/runner.go
startTime := time.Now()
err = u.moduleVUImpl.eventLoop.Start(func() error {
    v, err = fn(sobek.Undefined(), args...)
    return err
})
endTime := time.Now()
...
Value: metrics.D(endTime.Sub(startTime))
```

### Khi `sleep()` kéo dài qua deadline thì sao?

Nếu VU đang `sleep()` mà scenario chạm `maxDuration + gracefulStop`, context của VU sẽ bị cancel.
Vì `sleep()` đang `select` trên `timer.C` và `ctx.Done()`, nó sẽ thức dậy sớm qua nhánh
`ctx.Done()` rồi return.

Sau đó iteration kết thúc ở trạng thái **interrupted**, không phải full iteration.

Kết quả:

- iteration đó **không được tính** vào metric `iterations`
- thời gian partial đó **không đi vào** `iteration_duration`
- bạn sẽ thấy `interrupted iterations`

Đó là lý do file `examples/max_duration_interrupt_demo.js` chỉ có:

```text
0 complete and 1 interrupted iterations
dropped_iterations: 1
```

chứ không có `iteration_duration`.

### Khi `sleep()` thì goroutine có "dừng" không?

Theo implementation ở trên, goroutine của VU hiện tại bị **block/wait** trên:

```go
select {
case <-timer.C:
case <-ctx.Done():
}
```

Hiểu đơn giản:

- nó **không bận CPU để loop**
- nó đang chờ timer hoặc chờ cancel
- VU đó không chạy JS tiếp trong lúc sleep
- nhưng **các VU khác vẫn chạy bình thường** trên goroutine của chúng

Nói chính xác hơn:

```text
không phải "chết" goroutine
-> mà là goroutine của VU hiện tại đang parked/blocked, đợi wake up
```

### Phân biệt với `minIterationDuration`

Đây là chỗ rất dễ nhầm:

- `minIterationDuration` khai báo ở **global options**, cùng cấp với `scenarios`, không khai báo
  bên trong từng scenario:

```js
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "10s",
      gracefulStop: "2s",
    },
  },
};
```

- `sleep()` bạn viết trong JS:
  - nằm **bên trong** function của iteration
  - nên tính vào `iteration_duration`

- `minIterationDuration`:
  - được runner sleep **sau khi iteration đã xong**
  - nên nó làm chậm lần lặp tiếp theo
  - nhưng **không nằm trong** `iteration_duration`

Code path:

```go
// lib/options.go
MinIterationDuration types.NullDuration `json:"minIterationDuration" envconfig:"K6_MIN_ITERATION_DURATION"`
```

```go
// internal/js/runner.go
_, isFullIteration, totalTime, err := u.runFn(...)

if isFullIteration && u.Runner.Bundle.Options.MinIterationDuration.Valid {
    durationDiff := minIterationDuration - totalTime
    if durationDiff > 0 {
        select {
        case <-time.After(durationDiff):
        case <-u.RunContext.Done():
        }
    }
}
```

Tương tác với `maxDuration` và `gracefulStop`:

- `minIterationDuration` **không cộng vào** metric `iteration_duration`
- nhưng nó **giữ VU bận lâu hơn**, vì `RunOnce()` chỉ return sau khi ngủ bù xong
- vì vậy nó vẫn **ăn vào thời gian thật** của scenario
- nên gián tiếp có thể làm scenario chạm `maxDuration` sớm hơn

Timeline:

```text
JS function chạy xong
-> IterEnd event
-> nếu totalTime < minIterationDuration thì sleep phần còn thiếu
-> RunOnce() mới return
-> executor mới có thể start iteration tiếp theo
```

Ví dụ:

```js
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "5s",
      gracefulStop: "2s",
    },
  },
};

export default function () {
  sleep(0.5);
}
```

Ý nghĩa:

```text
Mỗi iteration:
  JS chạy 0.5s
  runner ngủ bù 1.5s
  tổng thời gian VU bị chiếm ≈ 2s
```

Nên với 1 VU:

```text
iter 1: ~0s -> ~2s
iter 2: ~2s -> ~4s
iter 3: bắt đầu gần ~4s
```

Lúc đó:

- iteration thứ 3 vẫn được start vì nó bắt đầu trước khi chạm `maxDuration=5s`
- nhưng phần sleep bù của nó có thể kéo sang sau mốc 5s
- và nếu sleep bù còn đang chạy tới lúc chạm `maxDuration + gracefulStop`, nó sẽ bị cắt qua
  `u.RunContext.Done()`

Key point:

```text
minIterationDuration không phải executor duration riêng
-> nó không cộng thẳng vào cấu hình maxDuration hay gracefulStop
-> nhưng nó kéo dài thời gian VU bận
-> nên ảnh hưởng thực tế tới việc còn kịp start iteration tiếp theo hay không
```

### Test copy cho `minIterationDuration`

File demo: `examples/min_iteration_duration_demo.js`

Command:

```bash
k6 run examples/min_iteration_duration_demo.js
```

Code đầy đủ:

```js
import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - JS work in each iteration takes about 0.5s.
// - minIterationDuration pads each completed iteration to about 2s.
// - iteration_duration stays around 0.5s, because the padding happens after the iteration function returns.
// - Total run time is around 6s for 3 iterations with 1 VU.
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    min_iter_demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "10s",
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

  sleep(0.5);

  console.log(
    `[js-end]     scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
```

Output cần nhìn:

```text
[iter-start] scenario=min_iter_demo t=0.0s __VU=1 __ITER=0
[js-end]     scenario=min_iter_demo t=0.5s __VU=1 __ITER=0

[iter-start] scenario=min_iter_demo t=2.0s __VU=1 __ITER=1
[js-end]     scenario=min_iter_demo t=2.5s __VU=1 __ITER=1

[iter-start] scenario=min_iter_demo t=4.0s __VU=1 __ITER=2
[js-end]     scenario=min_iter_demo t=4.5s __VU=1 __ITER=2

running (06.0s), 0/1 VUs, 3 complete and 0 interrupted iterations
min_iter_demo ✓ [ 100% ] 1 VUs  06.0s/10s  3/3 iters, 3 per VU

iteration_duration...: avg=500ms
iterations...........: 3 0.499/s
```

Giải thích output:

```text
JS thật mỗi iteration chỉ chạy khoảng 0.5s.
Nhưng iteration kế tiếp không start ở 0.5s, mà start ở 2.0s.

Lý do:
  minIterationDuration = 2s
  JS chạy 0.5s
  runner sleep bù khoảng 1.5s
```

Điểm quan trọng:

```text
testRunDuration ≈ 6.0s
iteration_duration_avg ≈ 0.5s
```

Nghĩa là `minIterationDuration` kéo dài wall-clock runtime, nhưng không làm
`iteration_duration` tăng lên 2s.

### Công thức tính thời gian tổng quát

Các công thức dưới đây dùng cho cách hiểu đơn giản với `per-vu-iterations`.
Thực tế có thêm overhead nhỏ của runtime/log/network, nên số đo thật có thể lệch một chút.

#### 1. Thời gian JS thật của một iteration

```text
js_iteration_time
  = thời gian chạy function được exec gọi
  = code JS + HTTP calls + checks + sleep() tự viết trong function
```

Ví dụ:

```js
export default function () {
  http.get("https://quickpizza.grafana.com/");
  sleep(1);
}
```

Thì:

```text
js_iteration_time ≈ http.get time + 1s sleep
```

`sleep()` nằm trong `default()` nên được tính vào `iteration_duration`.

#### 2. Khi có `minIterationDuration`

```text
vu_occupied_time_per_iteration
  = max(js_iteration_time, minIterationDuration)
```

Ví dụ:

```text
js_iteration_time = 0.5s
minIterationDuration = 2s

vu_occupied_time_per_iteration = max(0.5s, 2s) = 2s
```

Nếu JS thật lâu hơn min:

```text
js_iteration_time = 5s
minIterationDuration = 2s

vu_occupied_time_per_iteration = max(5s, 2s) = 5s
```

Key point:

```text
minIterationDuration chỉ sleep bù khi iteration chạy ngắn hơn min.
Nó không làm iteration đang dài hơn min bị ngắn lại.
```

#### 3. Runtime ước lượng của một VU

Với `per-vu-iterations`, mỗi VU chạy đúng `iterations` vòng riêng của nó.

```text
one_vu_runtime
  ≈ iterations_per_vu * max(js_iteration_time, minIterationDuration)
```

Ví dụ:

```text
iterations = 3
js_iteration_time = 0.5s
minIterationDuration = 2s

one_vu_runtime ≈ 3 * max(0.5s, 2s)
               ≈ 3 * 2s
               ≈ 6s
```

Đây chính là case `examples/min_iteration_duration_demo.js`:

```text
iter 0 start t=0.0s, js end t=0.5s
iter 1 start t=2.0s, js end t=2.5s
iter 2 start t=4.0s, js end t=4.5s
testRunDuration ≈ 6.0s
iteration_duration_avg ≈ 0.5s
```

#### 4. Runtime ước lượng của scenario với nhiều VU

Các VU chạy song song.

Nếu các VU có thời gian tương tự nhau:

```text
scenario_runtime
  ≈ iterations_per_vu * max(js_iteration_time, minIterationDuration)
```

Không nhân thêm `vus`.

Ví dụ:

```text
vus = 3
iterations = 3
js_iteration_time = 0.5s
minIterationDuration = 2s

mỗi VU runtime ≈ 3 * 2s = 6s
3 VU chạy song song
scenario_runtime ≈ 6s
```

Không phải:

```text
3 VUs * 3 iterations * 2s = 18s
```

Nếu các VU có thời gian khác nhau, scenario thường bị quyết định bởi VU chậm nhất:

```text
scenario_runtime ≈ max(one_vu_runtime của tất cả VUs)
```

#### 5. Trần thời gian của scenario

`maxDuration` và `gracefulStop` tạo ra trần:

```text
scenario_max_end = startTime + maxDuration + gracefulStop
```

Nếu không khai báo `startTime`:

```text
scenario_max_end = maxDuration + gracefulStop
```

Ví dụ:

```text
maxDuration = 10s
gracefulStop = 2s

scenario_max_end = 12s
```

Đây là lý do CLI in:

```text
12s max duration (incl. graceful stop)
```

Nhưng nếu work xong sớm:

```text
estimated scenario_runtime = 3s
scenario_max_end = 12s

actual runtime ≈ 3s
```

#### 6. Công thức kết hợp runtime thật và trần

Nếu không bị interrupt:

```text
actual_scenario_runtime
  ≈ min(estimated_scenario_runtime, maxDuration + gracefulStop)
```

Nhưng cần hiểu thêm 2 mốc:

```text
0 -> maxDuration:
  executor còn được start iteration mới

maxDuration -> maxDuration + gracefulStop:
  không start iteration mới nữa
  chỉ chờ iteration đang chạy dở finish

sau maxDuration + gracefulStop:
  iteration còn chạy bị interrupt
```

#### 7. Công thức với `sleep()` dài hơn deadline

Ví dụ:

```js
export const options = {
  scenarios: {
    interrupted_demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "3s",
      gracefulStop: "2s",
    },
  },
};

export default function () {
  sleep(10);
}
```

Tính:

```text
js_iteration_time = 10s
minIterationDuration = không khai báo
vu_occupied_time_per_iteration = 10s

scenario_max_end = 3s + 2s = 5s
```

Timeline:

```text
t=0s:
  iteration #1 start
  sleep(10)

t=3s:
  hết maxDuration
  không start iteration mới nữa

t=5s:
  hết maxDuration + gracefulStop
  iteration #1 bị interrupt

iteration #2:
  chưa từng được start
  bị tính vào dropped_iterations
```

Kết quả:

```text
complete iterations = 0
interrupted iterations = 1
dropped_iterations = 1
testRunDuration ≈ 5s
```

#### 8. Công thức với `minIterationDuration` làm chạm deadline

Ví dụ:

```js
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 5,
      maxDuration: "5s",
      gracefulStop: "2s",
    },
  },
};

export default function () {
  sleep(0.5);
}
```

Tính:

```text
js_iteration_time = 0.5s
minIterationDuration = 2s
vu_occupied_time_per_iteration = max(0.5s, 2s) = 2s
```

Timeline gần đúng:

```text
iter #1: start 0s,  JS end 0.5s, RunOnce end 2s
iter #2: start 2s,  JS end 2.5s, RunOnce end 4s
iter #3: start 4s,  JS end 4.5s, RunOnce end 6s

t=5s:
  hết maxDuration trong lúc iter #3 đang sleep bù minIterationDuration
  không start thêm iteration #4

t=6s:
  iter #3 xong trong gracefulStop nên vẫn complete
```

Nếu `gracefulStop` đủ dài:

```text
complete iterations ≈ 3
dropped_iterations ≈ 2
interrupted iterations ≈ 0
testRunDuration ≈ 6s
```

Nếu `gracefulStop` quá ngắn, ví dụ `gracefulStop: "0s"`:

```text
t=5s:
  hết maxDuration + gracefulStop ngay
  iter #3 có thể bị cắt khi đang sleep bù

complete iterations ≈ 2
interrupted iterations ≈ 1
dropped_iterations ≈ 2
```

Key point cuối:

```text
sleep() trong JS:
  tính vào js_iteration_time và iteration_duration nếu iteration complete

minIterationDuration:
  không tính vào iteration_duration
  nhưng tính vào thời gian VU bị chiếm

maxDuration:
  mốc ngừng start iteration mới

gracefulStop:
  cửa sổ chờ iteration đang dở finish
```

### Công thức `iterations/s` riêng cho `per-vu-iterations`

Theo Grafana docs, `per-vu-iterations` có tính chất quan trọng:

```text
Mỗi VU chạy đúng N iterations của riêng nó.
Total completed iterations = vus * iterations.
Test kết thúc khi VU chậm nhất chạy xong N iterations.
VU nào chạy xong sớm sẽ idle, không lấy thêm iteration từ VU khác.
```

Nguồn: <https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/per-vu-iterations/>

#### Per-vu có chạy song song không?

Có. Với `per-vu-iterations`, k6 lấy `vus` VU ra khỏi pool rồi start mỗi VU trong một goroutine
riêng:

```text
for range numVUs:
  GetPlannedVU(...)
  go handleVU(initializedVU)
```

Mỗi `handleVU()` tự chạy vòng lặp `iterations` lần của VU đó:

```text
VU 1: iter 0 -> iter 1 -> ... -> iter N-1
VU 2: iter 0 -> iter 1 -> ... -> iter N-1
VU 3: iter 0 -> iter 1 -> ... -> iter N-1
```

Các VU này chạy concurrent/song song về mặt lịch Go runtime. Không nên hiểu là chắc chắn mỗi VU
có một OS thread riêng; Go scheduler có thể multiplex nhiều goroutine lên ít thread hơn.

Code core:

```text
lib/executor/per_vu_iterations.go:
  Run()
  for range numVUs
  activeVUs.Add(1)
  go handleVU(initializedVU)
```

#### Thời gian tạo planned VUs có ăn vào `maxDuration` không?

Không, với planned VUs thì không ăn vào `maxDuration` của scenario.

Luồng đúng:

```text
Scheduler.Init()
  -> initialize planned VUs
  -> init executors

Scheduler.Run()
  -> executor.Run()
  -> getDurationContexts()
  -> startTime = time.Now()
  -> bắt đầu tính maxDuration / gracefulStop
```

Nên nếu tạo rất nhiều VUs:

```text
wall-clock từ lúc bấm k6 run
  có thể lâu hơn vì phải chờ init VUs

scenario runtime / exec.scenario.startTime / maxDuration
  bắt đầu sau khi planned VUs init xong
```

Nhưng với `unplanned VUs` thì khác. Arrival-rate executors có thể tạo thêm VU giữa lúc run:

```text
Initializing an unplanned VU, this may affect test results
```

Trường hợp đó thời gian tạo VU có thể ảnh hưởng kết quả, vì nó xảy ra trong execution phase.

Tóm tắt:

```text
planned VU init time:
  không tính vào scenario maxDuration

unplanned VU init time:
  có thể ảnh hưởng run thật

VUs:
  chạy concurrent/song song
  nhưng mỗi VU chạy iteration tuần tự trong chính nó
```

#### k6 biết tại một thời điểm có bao nhiêu VU active như thế nào?

k6 không đo bằng cách nhìn OS thread/goroutine từ bên ngoài. Core tự giữ counter trong
`ExecutionState`:

```text
activeVUs int64
```

Luồng chính:

```text
GetPlannedVU(..., true)
  -> ModCurrentlyActiveVUsCount(+1)

ReturnVU(..., true)
  -> ModCurrentlyActiveVUsCount(-1)
```

Với `per-vu-iterations`, khi một VU được lấy ra để chạy thì active count tăng. Khi VU đó chạy đủ
N iterations và được return về pool thì active count giảm. Vì vậy trong demo `10/10 VUs` rồi sau
đó còn `02/10 VUs` nghĩa là:

```text
02 active VUs / 10 initialized VUs
```

Không phải chỉ còn 2 VU được tạo. 10 VU vẫn đã initialized, nhưng 8 VU nhanh đã finish và idle.

Core dùng counter này ở 2 chỗ dễ thấy:

```text
internal/execution/scheduler.go:
  FormatStatus()
    -> GetCurrentlyActiveVUsCount() / GetInitializedVUsCount()

  emitVUsAndVUsMax()
    -> metric vus     = GetCurrentlyActiveVUsCount()
    -> metric vus_max = GetInitializedVUsCount()
    -> emit mỗi 1 giây
```

Metric liên quan:

```text
metrics/builtin.go:
  vus     = Gauge
  vus_max = Gauge
```

Ghi chú nhỏ: comment trong core nói `GetCurrentlyActiveVUsCount()` dùng cho UI/information, không
nên dùng làm cơ chế đồng bộ nội bộ. Nó vẫn là nguồn để progress line và metric `vus` biết đang có
bao nhiêu VU active tại thời điểm sample.

#### 1. Tổng iterations

```text
total_iterations = vus * iterations_per_vu
```

Ví dụ:

```text
vus = 10
iterations_per_vu = 20

total_iterations = 10 * 20 = 200
```

#### 2. Các tham số cần biết trước khi tính

Các công thức trong phần này dùng các ký hiệu:

```text
vus
  số VU của scenario

iterations_per_vu
  số iteration mỗi VU phải chạy

t_i
  thời gian chiếm VU của 1 iteration ở VU thứ i

js_iteration_time_i
  thời gian JS iteration thật sự chạy
  = code JS + HTTP calls + checks + sleep() tự viết trong function

minIterationDuration
  thời gian tối thiểu cho 1 iteration hoàn chỉnh
```

Vì sao `code JS`, `http.get()`, `check()`, `sleep()` đều nằm trong `js_iteration_time_i`?

Trong core, `RunOnce()` gọi exported function thông qua `runFn()`:

```text
internal/js/runner.go:
  RunOnce()
    -> runFn(ctx, true, fn, ...)

  runFn()
    startTime := time.Now()
    fn(...) // Actually run the JS script
    endTime := time.Now()
    iterationSamples(startTime, endTime, ...)

  iterationSamples()
    iteration_duration = endTime - startTime
```

Nghĩa là bất kỳ thứ gì chạy bên trong `default()` hoặc function được scenario `exec` trỏ tới đều
nằm trong khoảng `startTime -> endTime`.

Ví dụ:

```js
export default function () {
  // code JS thường
  const a = 1 + 2;

  // HTTP call đồng bộ trong iteration
  const res = http.get("https://quickpizza.grafana.com/");

  // check chạy trong iteration
  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  // sleep tự viết trong function
  sleep(1);
}
```

Thì gần đúng:

```text
js_iteration_time
  ≈ thời gian chạy JS thường
   + thời gian http.get()
   + thời gian evaluate check()
   + 1s sleep
```

Ghi chú: `check()` còn emit metric riêng tên `checks`, nhưng metric đó chỉ là pass/fail rate. Nó
không phải duration riêng của check. Thời gian chạy check vẫn nằm trong `iteration_duration` vì
check chạy bên trong function của iteration.

Nếu có `minIterationDuration`:

```text
t_i = max(js_iteration_time_i, minIterationDuration)
```

Nếu không có `minIterationDuration`:

```text
t_i = js_iteration_time_i
```

#### 3. `0.2s`, `0.5s`, `0.515s` lấy từ đâu?

Có 3 kiểu hay gặp:

```text
1. Script tự set delay cố định
2. Script có sleep cố định + thêm HTTP work
3. Script không cố định, phải ước từ kết quả chạy
```

Case 1, như demo của ta:

```js
const FAST_ITERATION_SECONDS = 0.2;
const SLOW_ITERATION_SECONDS = 0.5;

sleep(delay);
```

Lúc này:

```text
VU nhanh: t_i ≈ 0.2s
VU chậm:  t_i ≈ 0.5s
```

Vì đây là workload mình tự thiết kế trong code.

Case 2, như ví dụ docs có:

```js
http.get(...);
sleep(0.5);
```

Lúc này:

```text
js_iteration_time ≈ http.get time + 0.5s
```

Nên docs mới viết gần đúng:

```text
iteration_time ≈ 0.515s
```

Ở ví dụ này không có `minIterationDuration`, nên `effective_iteration_time` gần bằng
`iteration_time`. Nếu có `minIterationDuration`, phải dùng:

```text
effective_iteration_time = max(js_iteration_time, minIterationDuration)
```

Ý của `0.515s` là:

```text
500ms sleep + khoảng 15ms request/JS overhead
```

Nó là số ước lượng hợp lý từ script + kết quả chạy, không phải hằng số core của k6.

Case 3, nếu script không có `sleep()` cố định và response time thay đổi:

```text
không thể tính chính xác tuyệt đối trước khi chạy
```

Lúc đó thường làm như sau:

```text
bước 1: đọc code để ước workload của 1 iteration
bước 2: chạy thử
bước 3: nhìn iteration_duration hoặc log/progress để lấy số gần đúng
```

#### 4. Iteration rate tối đa khi tất cả VU còn active

Nếu mỗi VU có thời gian chiếm VU mỗi iteration là `t_i`:

```text
per_vu_rate_i = 1 / t_i
```

Iteration rate tối đa tại thời điểm tất cả VU còn đang chạy:

```text
peak_iteration_rate_if_all_vus_active = sum(1 / t_i)
```

Nếu tất cả VU giống nhau:

```text
peak_iteration_rate_if_all_vus_active ≈ vus / effective_iteration_time
```

Lưu ý quan trọng:

```text
peak_iteration_rate_if_all_vus_active là công thức mình tự tính để học và dự đoán.
Nó không phải metric core k6 mặc định.
```

k6 core có metric `iterations`, nhưng summary mặc định chỉ in rate trung bình toàn test:

```text
iterations...........: 200 19.98/s
```

Dòng `19.98/s` là:

```text
completed iterations / total test duration
```

Nó là **average iteration rate**, không phải peak.

Muốn nhìn peak gần đúng bằng output mặc định, có thể lấy delta từ progress log từng giây:

```text
running (01.0s), 10/10 VUs, 34 complete
running (02.0s), 10/10 VUs, 78 complete
running (03.0s), 10/10 VUs, 122 complete
running (04.0s), 10/10 VUs, 166 complete
```

Tính:

```text
78 - 34 = 44 iterations/s
122 - 78 = 44 iterations/s
166 - 122 = 44 iterations/s
```

Đây là peak gần đúng của demo, nhưng vẫn là **mình tự tính từ progress output**, không phải k6
in sẵn một metric tên peak.

Tóm lại:

```text
iterations/s trong summary = k6 core tính trung bình toàn test
peak_iteration_rate_if_all_vus_active = công thức mình tự tính để dự đoán peak
```

Code core liên quan:

```text
metrics/builtin.go:
  iterations được đăng ký là Counter

metrics/sink.go:
  CounterSink.Rate(duration) = count / duration
```

Vì vậy summary có thể in `iterations...........: 200 19.98/s`, nhưng đó là average rate từ
counter `iterations`, không phải peak 1 giây cao nhất.

Ví dụ docs:

```text
vus = 10
effective_iteration_time ≈ 0.515s

per_vu_rate ≈ 1 / 0.515 ≈ 1.94 iters/s ≈ 2 iters/s
peak_iteration_rate ≈ 10 * 2 = 20 iters/s
```

#### 5. Runtime của từng VU

Với `per-vu-iterations`, mỗi VU có workload cố định:

```text
vu_runtime_i ≈ iterations_per_vu * t_i
```

Nếu có `minIterationDuration`:

```text
t_i = max(js_iteration_time_i, minIterationDuration)
```

Nếu không có `minIterationDuration`:

```text
t_i = js_iteration_time_i
```

#### 6. Runtime của scenario

Vì các VU chạy song song:

```text
scenario_runtime ≈ max(vu_runtime_i)
```

Tức là:

```text
scenario kết thúc khi VU chậm nhất chạy xong iterations_per_vu
```

Đây là điểm khác với `shared-iterations`: VU nhanh không được lấy thêm việc từ VU chậm.

#### 7. Iteration rate trung bình toàn test

```text
average_iteration_rate = completed_iterations / actual_scenario_runtime
```

Ở đoạn overview này, công thức trên đang nói theo cách nhìn "runtime của scenario". Nếu bạn đọc cột
`/s` trong summary Counter của k6 thì mẫu số phải hiểu là `summary_runtime_base`, không mặc định là
`actual_scenario_runtime`.

Các đại lượng trong công thức:

```text
vus
  số VU của scenario
  lấy từ options.scenarios.<name>.vus

iterations_per_vu
  số iteration mỗi VU phải chạy
  lấy từ options.scenarios.<name>.iterations
  với per-vu-iterations, đây là "iterations for each VU"

completed_iterations
  tổng iteration đã hoàn thành
  nếu không bị interrupt/drop:
  completed_iterations = vus * iterations_per_vu

t_i
  thời gian chiếm VU của 1 iteration ở VU thứ i

vu_runtime_i
  thời gian VU thứ i cần để chạy đủ iterations_per_vu
  vu_runtime_i ≈ iterations_per_vu * t_i

actual_scenario_runtime
  thời gian scenario chạy thật
  với per-vu-iterations:
  actual_scenario_runtime ≈ max(vu_runtime_i)
```

Nếu không bị interrupt/drop:

```text
average_iteration_rate ≈ (vus * iterations_per_vu) / max(vu_runtime_i)
```

Ví dụ đều nhau:

```text
vus = 10
iterations_per_vu = 20
iteration_time = t_i = 0.5s

completed_iterations = vus * iterations_per_vu
                     = 10 * 20
                     = 200

vu_runtime = 20 * 0.5s = 10s
scenario_runtime ≈ 10s
average_iteration_rate ≈ 200 / 10s = 20 iters/s
```

Ở đây `iterations_per_vu = 20` không phải k6 tự đo. Nó là input mình khai báo trong scenario:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 20,
    },
  },
};
```

k6 cũng in lại ý này trong header:

```text
20 iterations for each of 10 VUs
```

#### 8. Vì sao max iteration rate đạt được nhưng không giữ được?

Nếu VU không đều nhau:

```text
vus = 10
iterations_per_vu = 20

8 VUs nhanh: mỗi iteration 0.2s
2 VUs chậm: mỗi iteration 0.5s
```

Số `2 VUs chậm` ở đây được lấy từ:

```text
slow_vus = vus - fast_vus
         = 10 - 8
         = 2
```

Peak iteration rate khi tất cả VU còn active:

```text
peak_iteration_rate = 8 / 0.2 + 2 / 0.5
                    = 40 + 4
                    = 44 iters/s
```

Runtime từng nhóm:

```text
fast_vu_runtime = 20 * 0.2s = 4s
slow_vu_runtime = 20 * 0.5s = 10s
```

Scenario runtime:

```text
scenario_runtime ≈ max(4s, 10s) = 10s
```

Average iteration rate:

```text
average_iteration_rate = 200 / 10s = 20 iters/s
```

Nghĩa là block tính của demo này đi theo thứ tự:

```text
1. đọc tham số:
   vus = 10
   fast_vus = 8
   slow_vus = 10 - 8 = 2
   iterations_per_vu = 20
   fast_iteration_time = 0.2s
   slow_iteration_time = 0.5s

2. tính total_iterations:
   10 * 20 = 200

3. tính peak_iteration_rate khi tất cả còn active:
   8 / 0.2 + 2 / 0.5 = 44 iters/s

4. tính runtime của VU nhanh và chậm:
   20 * 0.2 = 4s
   20 * 0.5 = 10s

5. lấy VU chậm nhất làm scenario runtime:
   max(4s, 10s) = 10s

6. tính average_iteration_rate toàn test:
   200 / 10 = 20 iters/s
```

Hiện tượng:

```text
0s -> 4s:
  10 VUs đều active, iteration rate cao

4s -> 10s:
  8 VUs nhanh đã xong và idle
  chỉ còn 2 VUs chậm chạy tiếp
  iteration rate tụt mạnh
```

Efficiency:

```text
efficiency = average_iteration_rate / peak_iteration_rate
           = 20 / 44
           ≈ 45%
```

Đây chính là ý trong docs: vì iterations được chia đều theo VU, VU nhanh có thể finish sớm và idle
trong phần còn lại của test, làm average iteration rate thấp hơn peak. Docs dùng chữ
`throughput` theo nghĩa chung; trong output k6 mặc định, thứ mình nhìn thấy ở đây là
rate của metric `iterations`.

### Demo `iterations/s` cho `per-vu-iterations`

File demo: `examples/per_vu_iterations_throughput_demo.js`

Command:

```bash
k6 run examples/per_vu_iterations_throughput_demo.js
```

Code đầy đủ:

```js
import exec from "k6/execution";
import { sleep } from "k6";

const VUS = 10;
const ITERATIONS_PER_VU = 20;
const FAST_VUS = 8;
const FAST_ITERATION_SECONDS = 0.2;
const SLOW_ITERATION_SECONDS = 0.5;

// Expected formulas:
// - total_iterations = VUS * ITERATIONS_PER_VU = 200
// - peak_iteration_rate_if_all_vus_active =
//     FAST_VUS / FAST_ITERATION_SECONDS + (VUS - FAST_VUS) / SLOW_ITERATION_SECONDS
//     = 8 / 0.2 + 2 / 0.5 = 44 iters/s
// - slowest_vu_runtime = ITERATIONS_PER_VU * SLOW_ITERATION_SECONDS = 10s
// - expected_average_iteration_rate = total_iterations / slowest_vu_runtime = 20 iters/s
//
// The fast VUs finish around 4s and then stay idle. The scenario ends when the
// slowest VU finishes its 20 iterations, around 10s.
export const options = {
  scenarios: {
    per_vu_throughput: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERATIONS_PER_VU,
      maxDuration: "30s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

function iterationSecondsForVU(vuID) {
  return vuID <= FAST_VUS ? FAST_ITERATION_SECONDS : SLOW_ITERATION_SECONDS;
}

export default function () {
  const vuID = exec.vu.idInTest;
  const delay = iterationSecondsForVU(vuID);

  if (__ITER === 0) {
    console.log(`[vu-start] vu=${vuID} delay=${delay}s t=${elapsedSeconds()}s`);
  }

  sleep(delay);

  if (__ITER === ITERATIONS_PER_VU - 1) {
    console.log(`[vu-done]  vu=${vuID} delay=${delay}s t=${elapsedSeconds()}s`);
  }
}
```

Output quan trọng khi chạy demo:

```text
running (04.0s), 10/10 VUs, 166 complete and 0 interrupted iterations
running (05.0s), 02/10 VUs, 178 complete and 0 interrupted iterations
...
running (10.0s), 02/10 VUs, 198 complete and 0 interrupted iterations

running (10.0s), 00/10 VUs, 200 complete and 0 interrupted iterations
per_vu_throughput ✓ [ 100% ] 10 VUs  10.0s/30s  200/200 iters, 20 per VU

iterations...........: 200 19.99/s
```

Log VU finish:

```text
[vu-done] vu=1..8  delay=0.2s t=4.0s
[vu-done] vu=9..10 delay=0.5s t=10.0s
```

Kết luận từ demo:

```text
Peak iteration rate cao nhất chỉ xảy ra khi tất cả VU còn active.
Khi VU nhanh finish sớm, chúng idle.
Scenario vẫn phải chờ VU chậm nhất.
Average iteration rate = total completed iterations / total duration.
```

Nếu mục tiêu của bài test là **giữ iterations/s ổn định trong suốt cả test**, thì
`per-vu-iterations` thường không phải lựa chọn tốt nhất. Executor này tự nhiên có tail-off ở cuối
test khi một số VU finish sớm. Muốn giữ rate ổn định hơn, thường phải nhìn sang nhóm
arrival-rate executors.

#### Vì sao "maximum throughput is reached, but not maintained"?

Câu này trong docs dùng `throughput` theo nghĩa chung. Trong bài này mình đang diễn dịch nó thành
`iteration rate` / `iterations/s`, không phải một metric core riêng tên `throughput`.

Câu đó nghĩa là:

```text
reached:
  có một giai đoạn iteration rate đạt mức cao nhất

not maintained:
  iteration rate đó không giữ được tới cuối test
```

Với `per-vu-iterations`, nguyên nhân nằm ở cách chia việc:

```text
mỗi VU được giao cố định N iterations
VU nhanh không lấy thêm iteration của VU chậm
VU nhanh xong sớm thì idle
test chỉ kết thúc khi VU chậm nhất chạy xong N iterations
```

Trong demo:

```text
8 VUs nhanh:
  delay = 0.2s/iteration
  20 iterations -> xong khoảng 4s

2 VUs chậm:
  delay = 0.5s/iteration
  20 iterations -> xong khoảng 10s
```

Timeline:

```text
0s -> 4s:
  10/10 VUs active
  iteration rate cao nhất

4s -> 10s:
  8 VUs nhanh đã xong và idle
  chỉ còn 2/10 VUs chậm active
  iteration rate tụt

10s:
  2 VUs chậm cuối cùng xong
  scenario kết thúc
```

Công thức nhìn theo từng giai đoạn:

```text
iteration rate khi tất cả còn active
  = 8 / 0.2 + 2 / 0.5
  = 40 + 4
  = 44 iters/s
```

Sau khi 8 VUs nhanh xong:

```text
iteration rate còn lại
  = 2 / 0.5
  = 4 iters/s
```

Vì vậy iteration rate ban đầu có thể rất cao, nhưng cuối test sẽ giảm mạnh.

Output progress thể hiện đúng điều đó:

```text
running (04.0s), 10/10 VUs, 166 complete
running (05.0s), 02/10 VUs, 178 complete
running (06.0s), 02/10 VUs, 182 complete
...
running (10.0s), 02/10 VUs, 198 complete
```

Từ `t=5s` trở đi chỉ còn `02/10 VUs`, nên tốc độ tăng completed iterations chậm lại:

```text
178 -> 182 -> 186 -> 190 -> 194 -> 198
```

Mỗi giây chỉ thêm khoảng 4 iterations, đúng với:

```text
2 VUs * 2 iters/s = 4 iters/s
```

Nếu tất cả VU giống hệt nhau thì iteration rate có thể gần như giữ được tới sát cuối rồi rơi nhanh.
Nhưng trong thực tế luôn có jitter: network khác nhau, response time khác nhau, CPU scheduling,
logic branch khác nhau. Vì vậy một số VU thường finish sớm hơn và idle trước khi test kết thúc.

Key point:

```text
per-vu-iterations tối ưu cho:
  mỗi VU phải chạy đúng N iterations

per-vu-iterations không tối ưu cho:
  giữ iterations/s ổn định trong suốt test
```

#### TPS trong k6 là metric nào?

k6 **không có metric mặc định tên `TPS`**.

`TPS` nghĩa là:

```text
transactions per second
```

Nhưng "transaction" là khái niệm nghiệp vụ, còn k6 chỉ biết các metric cụ thể như:

```text
iterations
http_reqs
custom metrics
```

Vì vậy map như sau:

| Bạn coi transaction là gì? | Metric k6 nên nhìn |
| --- | --- |
| 1 user flow hoàn chỉnh | `iterations/s` |
| 1 HTTP request | `http_reqs/s` |
| 1 bước nghiệp vụ tự định nghĩa | custom `Counter` / thời gian test |

Ví dụ 1 iteration là một flow mua hàng:

```js
export default function () {
  http.get("/home");
  http.post("/login");
  http.post("/checkout");
}
```

Nếu summary in:

```text
iterations...........: 200 20/s
http_reqs............: 600 60/s
```

Thì hiểu là:

```text
20 completed user flows/s
60 HTTP requests/s
```

Nếu đang nói TPS ở mức **business transaction**, thì TPS ở đây là:

```text
TPS ≈ iterations/s = 20
```

Nếu đang nói throughput ở mức **request**, thì:

```text
request throughput ≈ http_reqs/s = 60
```

#### Vì sao với `per-vu-iterations` ta hay nói `iterations/s`?

Vì executor này định nghĩa work bằng:

```text
vus * iterations_per_vu
```

Tức là đơn vị workload gốc của executor là **iteration**, không phải request.

Config:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 20,
    },
  },
};
```

Nghĩa là:

```text
mỗi VU chạy 20 iterations
tổng work = 10 * 20 = 200 iterations
```

Do đó khi hỏi:

```text
executor này chạy được bao nhiêu work mỗi giây?
```

câu trả lời tự nhiên là:

```text
iterations/s = completed iterations / actual_scenario_runtime
```

Đây là cách nhìn throughput theo runtime của scenario. Nếu suy từ summary Counter thì phải đổi mẫu
số thành `summary_runtime_base`.

Nếu mỗi iteration đại diện cho 1 business transaction:

```text
TPS = iterations/s
```

Nếu mỗi iteration chứa nhiều request, ví dụ 3 request:

```text
estimated_http_reqs_rate ≈ iterations/s * 3
```

Cách nhân này chỉ đúng nếu mỗi completed iteration luôn chạy đủ 3 HTTP requests. Nếu code có
branch/error/interrupt làm số request không cố định, đọc `http_reqs` thực tế từ summary hoặc custom
metric.

Key point:

```text
per-vu-iterations:
  workload được đếm bằng iterations
  nên throughput của executor thường đọc bằng iterations/s

JMeter TPS:
  chỉ map sang iterations/s nếu 1 iteration k6 = 1 transaction trong JMeter
```

### `iteration`

Một `iteration` là **một lần VU chạy function được config**.

Với script cơ bản:

```js
export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

1 iteration nghĩa là:

```text
gọi export default function() đúng 1 lần
```

Trong core, một iteration tương ứng với:

```text
ActiveVU.RunOnce()
  -> lấy function theo exec, mặc định là "default"
  -> tăng counter
  -> gọi JS function
```

Cách hiểu gần gũi: `iteration` giống **một lượt chạy body của vòng lặp**, không phải toàn bộ
vòng lặp.

Với `per-vu-iterations`, có thể hình dung:

```js
for (let vu = 1; vu <= vus; vu++) {
  go(function virtualUser() {
    for (let i = 0; i < iterations; i++) {
      default(); // 1 iteration
    }
  });
}
```

Với `constant-vus`, có thể hình dung:

```js
while (chưa hết duration) {
  default(); // 1 iteration
}
```

Nói ngắn:

```text
iteration không phải toàn bộ vòng lặp;
iteration là một lượt chạy trong vòng lặp.
```

### `iterations`

`iterations` là số lần lặp mà executor cần chạy.

Nhưng ý nghĩa cụ thể phụ thuộc executor:

| Executor | Nghĩa của `iterations` |
|----------|------------------------|
| `per-vu-iterations` | mỗi VU chạy chừng đó iterations |
| `shared-iterations` | tổng số iterations được chia cho các VUs |

Ví dụ `per-vu-iterations`:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 2,
```

Nghĩa là:

```text
VU #1 chạy 2 iterations
VU #2 chạy 2 iterations
VU #3 chạy 2 iterations
total iterations = 3 * 2 = 6
```

Ví dụ `shared-iterations`:

```js
executor: "shared-iterations",
vus: 3,
iterations: 6,
```

Nghĩa là:

```text
tổng cộng 6 iterations
3 VUs cùng chia nhau chạy
mỗi VU chạy bao nhiêu không cố định
```

### `__ITER`

`__ITER` là counter iteration **theo từng VU**.

Ví dụ cùng một VU chạy 3 lần:

```text
VU #1 iteration đầu  -> __ITER=0
VU #1 iteration hai  -> __ITER=1
VU #1 iteration ba   -> __ITER=2
```

Nếu VU được reuse sang scenario khác, `__ITER` vẫn tiếp tục tăng, không reset.

### `exec.vu.iterationInScenario`

`exec.vu.iterationInScenario` là counter iteration **theo scenario**.

Nếu cùng VU được reuse sang scenario mới:

```text
Scenario A, VU #1: iterationInScenario = 0, 1, 2
Scenario B, VU #1: iterationInScenario = 0, 1
```

`__ITER` vẫn tiếp tục tăng, nhưng `iterationInScenario` bắt đầu từ `0` cho scenario mới.

### `vus`

`vus` là số Virtual Users executor sẽ dùng.

Trong `per-vu-iterations`:

```text
total iterations = vus * iterations
```

Trong default no-options:

```text
vus = 1
iterations = 1
total iterations = 1
```

---

## 6. Các shortcut khác để so sánh sau

`DeriveScenariosFromShortcuts()` chọn executor theo shortcut:

| Options user khai báo | Executor được derive |
|-----------------------|----------------------|
| Không khai báo gì | `per-vu-iterations` |
| `iterations` | `shared-iterations` |
| `duration` | `constant-vus` |
| `stages` | `ramping-vus` |
| `vus` đơn lẻ | `shared-iterations` với `iterations = vus` |
| `scenarios` | Dùng đúng scenario user khai báo |

Ghi chú: `vus` đơn lẻ không còn là "chạy vô hạn"; code tạo `shared-iterations` với số
iterations bằng số VUs.

---

## 7. Lệnh kiểm tra

Chạy script không options:

```bash
k6 run -v examples/http_get.js
```

Hoặc từ source repo:

```bash
go run . run -v examples/http_get.js
```

Log cần chú ý:

```text
scenarios: 1 scenario, 1 max VUs
* default: 1 iterations for each of 1 VUs
Start of initialization neededVUs=1
Initialized VU #1
Starting executor ... type=per-vu-iterations
```
