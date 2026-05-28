# k6 Options Defaults và Shortcut Conversion

**Ngày phân tích**: 2026-01-15
**Mục đích**: Giải thích cách k6 xử lý khi không có options, và cách shortcut options được convert thành scenarios
**Liên quan**: 
- [execution_config_shortcuts.go](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go)
- [options.go](file:///e:/Projects/k6/lib/options.go)

---

## 1. Tổng Quan

Khi bạn viết k6 script, `options` **KHÔNG bắt buộc**. k6 có logic để:
1. Áp dụng default values nếu không có options
2. Convert shortcut options thành full scenarios

Trong core hiện tại, nhóm shortcut quan trọng là:

```text
iterations
duration
stages
vus-only
```

Nhưng khi đọc code, đừng hiểu đây là 4 nhánh chạy "song song". `DeriveScenariosFromShortcuts()`
đi theo **thứ tự switch** rất cụ thể. Nhánh nào match trước thì dừng ở đó.

---

## 2. Code Flow

```
Script Load → Parse Options → DeriveScenariosFromShortcuts()
                                        ↓
                              Check shortcut theo thứ tự switch
                                        ↓
                    ┌──────────────────────────────────────────┐
                    │                                          │
                    ▼                         ▼                ▼
            iterations set?    duration set?    stages set?    only vus set?
                    │                 │               │               │
                    ▼                 ▼               ▼               ▼
            shared-iterations   constant-vus   ramping-vus   shared-iterations
                                                                   (vus=N, iterations=N)
                    └────────────────────────────────────────────────────┘
                                        │
                                        ▼
                               no execution shortcut?
                                        │
                                        ▼
                              per-vu-iterations
                              (1 VU, 1 iteration)
```

Đọc đời thường theo đúng thứ tự:

```text
1. có iterations?
   -> shared-iterations

2. nếu không, có duration?
   -> constant-vus

3. nếu không, có stages?
   -> ramping-vus

4. nếu không, có mỗi vus?
   -> shared-iterations với vus = N, iterations = N
   -> nếu đồng thời có scenarios thì root vus sẽ override scenarios và k6 log warning

5. nếu không, có scenarios không rỗng?
   -> dùng đúng scenarios user khai báo

6. còn lại:
   -> fallback về per-vu-iterations mặc định 1 VU, 1 iteration
```

---

## 3. Key Code: `DeriveScenariosFromShortcuts()`

**File**: [execution_config_shortcuts.go](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go#L49-L128)

```go
// DeriveScenariosFromShortcuts checks for conflicting options and turns any
// shortcut options (i.e. duration, iterations, stages, vus-only) into the proper
// long-form scenario/executor configuration in the scenarios property.
func DeriveScenariosFromShortcuts(opts lib.Options, logger logrus.FieldLogger) (lib.Options, error) {
    result := opts

    switch {
    case opts.Iterations.Valid:
        // iterations → shared-iterations executor
        result.Scenarios = getSharedIterationsScenario(opts.Iterations, opts.Duration, opts.VUs)

    case opts.Duration.Valid:
        // duration → constant-vus executor
        result.Scenarios = getConstantVUsScenario(opts.Duration, opts.VUs)

    case len(opts.Stages) > 0:
        // stages → ramping-vus executor
        result.Scenarios = getRampingVUsScenario(opts.Stages, opts.VUs)

    case opts.VUs.Valid && opts.Stages == nil && !opts.Iterations.Valid && !opts.Duration.Valid:
        // vus-only → shared-iterations executor with iterations = vus
        ds := NewSharedIterationsConfig(lib.DefaultScenarioName)
        ds.VUs = opts.VUs
        ds.Iterations = opts.VUs
        result.Scenarios = lib.ScenarioConfigs{lib.DefaultScenarioName: ds}

    case len(opts.Scenarios) > 0:
        // Explicit scenarios - do nothing

    default:
        // NO execution parameters → per-vu-iterations (1 VU, 1 iter)
        result.Scenarios = lib.ScenarioConfigs{
            lib.DefaultScenarioName: NewPerVUIterationsConfig(lib.DefaultScenarioName),
        }
    }

    return result, nil
}
```

---

## 4. Default Values

### 4.1 Khi KHÔNG có options nào

```go
// lib/executor/per_vu_iterations.go:37-45
func NewPerVUIterationsConfig(name string) PerVUIterationsConfig {
    return PerVUIterationsConfig{
        BaseConfig:  NewBaseConfig(name, perVUIterationsType),
        VUs:         null.NewInt(1, false),           // ← 1 VU
        Iterations:  null.NewInt(1, false),           // ← 1 iteration
        MaxDuration: types.NewNullDuration(10*time.Minute, false),
    }
}
```

**Kết quả**: Script chạy **1 VU**, **1 iteration**, sau đó stop.

### 4.2 DefaultScenarioName

```go
// lib/options.go:21
const DefaultScenarioName = "default"
```

---

## 5. Shortcut → Executor Mapping

| Shortcut Options | Executor Created | Example |
|------------------|------------------|---------|
| `iterations` | `shared-iterations` | `{ iterations: 100 }` |
| `duration` | `constant-vus` | `{ duration: '30s' }` |
| `stages` | `ramping-vus` | `{ stages: [...] }` |
| `vus` only | `shared-iterations` với `vus = N`, `iterations = N` | `{ vus: 10 }` |
| `scenarios` không rỗng | dùng đúng scenarios user khai báo | `{ scenarios: {...} }` |
| **None** | `per-vu-iterations` (1 VU, 1 iter) | No options |

---

## 6. Helper Functions

### 6.1 getConstantVUsScenario
```go
// execution_config_shortcuts.go:21-26
func getConstantVUsScenario(duration types.NullDuration, vus null.Int) lib.ScenarioConfigs {
    ds := NewConstantVUsConfig(lib.DefaultScenarioName)
    ds.VUs = vus
    ds.Duration = duration
    return lib.ScenarioConfigs{lib.DefaultScenarioName: ds}
}
```

### 6.2 getSharedIterationsScenario
```go
// execution_config_shortcuts.go:39-47
func getSharedIterationsScenario(iters null.Int, duration types.NullDuration, vus null.Int) lib.ScenarioConfigs {
    ds := NewSharedIterationsConfig(lib.DefaultScenarioName)
    ds.VUs = vus
    ds.Iterations = iters
    if duration.Valid {
        ds.MaxDuration = duration
    }
    return lib.ScenarioConfigs{lib.DefaultScenarioName: ds}
}
```

### 6.3 getRampingVUsScenario
```go
// execution_config_shortcuts.go:28-37
func getRampingVUsScenario(stages []lib.Stage, startVUs null.Int) lib.ScenarioConfigs {
    ds := NewRampingVUsConfig(lib.DefaultScenarioName)
    ds.StartVUs = startVUs
    for _, s := range stages {
        if s.Duration.Valid {
            ds.Stages = append(ds.Stages, Stage{Duration: s.Duration, Target: s.Target})
        }
    }
    return lib.ScenarioConfigs{lib.DefaultScenarioName: ds}
}
```

### 6.4 vus-only shortcut
```go
case opts.VUs.Valid && opts.Stages == nil && !opts.Iterations.Valid && !opts.Duration.Valid:
    ds := NewSharedIterationsConfig(lib.DefaultScenarioName)
    ds.VUs = opts.VUs
    ds.Iterations = opts.VUs
    result.Scenarios = lib.ScenarioConfigs{lib.DefaultScenarioName: ds}
```

Đọc đời thường:

```text
chỉ khai báo vus: N
=> k6 không rơi về per-vu-iterations mặc định
=> k6 tạo shared-iterations với N VU và tổng N iteration
```

---

## 7. Warning Messages

Với core hiện tại, `vus`-only không còn là case "bị ignore".
Nó có nhánh shortcut riêng:

```go
ds := NewSharedIterationsConfig(lib.DefaultScenarioName)
ds.VUs = opts.VUs
ds.Iterations = opts.VUs
```

Nghĩa là:

```text
options = { vus: 10 }
=> executor thật là shared-iterations
=> vus = 10
=> iterations = 10
```

Nhưng có một case dễ nhầm:

```js
export const options = {
  vus: 10,
  scenarios: {
    a: { executor: "constant-vus", vus: 1, duration: "10s" },
  },
};
```

Theo code hiện tại:

```text
nhánh vus-only vẫn match
=> root vus override scenarios
=> k6 log warning: `vus=10` overrides scenarios configuration
```

Nói cách khác: có root `vus` không có nghĩa là `scenarios` chắc chắn được ưu tiên. Trong switch hiện
tại, nhánh `vus` đứng trước nhánh `len(opts.Scenarios) > 0`.

---

## 8. Conflict Errors

Không thể dùng đồng thời:
- `iterations` + `stages`
- `iterations` + `scenarios`
- `duration` + `stages`
- `duration` + `scenarios`
- `stages` + `scenarios`

```go
// execution_config_shortcuts.go:55-59
if len(opts.Stages) > 0 {
    return result, ExecutionConflictError(
        "using `iterations` and `stages` options simultaneously is not allowed",
    )
}
```

---

## 9. Ví Dụ Quy Đổi

Ở phần này mình không dùng chữ "tương đương" theo nghĩa tuyệt đối nữa, vì shortcut thường chỉ set
một phần field; ngoài ra core còn áp dụng thêm các default ngầm từ `BaseConfig` và config executor.

Hiểu đúng hơn:

```text
block dưới đây là dạng dài tối thiểu mà shortcut suy ra
các default ngầm như gracefulStop, exec, maxDuration vẫn tiếp tục được áp dụng từ core
```

### Script không có options
```javascript
export default function() {
    console.log('Hello');
}
```

Dạng dài tối thiểu dễ nhìn:
```javascript
export const options = {
    scenarios: {
        default: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m',
        },
    },
};
```

Đây là case ít gây nhầm nhất vì block default đã gần như đầy đủ:

```text
executor = per-vu-iterations
vus = 1
iterations = 1
maxDuration = 10m
gracefulStop = 30s
exec mặc định = default
```

### Script với shortcuts
```javascript
export const options = {
    vus: 10,
    duration: '30s',
};
```

Dạng dài tối thiểu k6 suy ra:
```javascript
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

Và khi chạy, core còn áp dụng thêm default ngầm:

```text
gracefulStop = 30s từ BaseConfig
exec mặc định = default
```

### Script chỉ có `vus`
```javascript
export const options = {
    vus: 10,
};
```

Dạng dài tối thiểu k6 suy ra:
```javascript
export const options = {
    scenarios: {
        default: {
            executor: 'shared-iterations',
            vus: 10,
            iterations: 10,
        },
    },
};
```

Và khi chạy, core còn áp dụng thêm default ngầm:

```text
maxDuration = 10m từ shared-iterations config
gracefulStop = 30s từ BaseConfig
exec mặc định = default
```

---

## 10. References

- [execution_config_shortcuts.go](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go)
- [per_vu_iterations.go](file:///e:/Projects/k6/lib/executor/per_vu_iterations.go)
- [options.go](file:///e:/Projects/k6/lib/options.go)
