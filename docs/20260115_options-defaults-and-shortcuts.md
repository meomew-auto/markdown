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

---

## 2. Code Flow

```
Script Load → Parse Options → DeriveScenariosFromShortcuts()
                                        ↓
                              Check which shortcut is used
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
| `scenarios` | As defined | `{ scenarios: {...} }` |
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

## 9. Ví Dụ Tương Đương

### Script không có options
```javascript
export default function() {
    console.log('Hello');
}
```

Tương đương với:
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

### Script với shortcuts
```javascript
export const options = {
    vus: 10,
    duration: '30s',
};
```

Tương đương với:
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

### Script chỉ có `vus`
```javascript
export const options = {
    vus: 10,
};
```

Tương đương với:
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

---

## 10. References

- [execution_config_shortcuts.go](file:///e:/Projects/k6/lib/executor/execution_config_shortcuts.go)
- [per_vu_iterations.go](file:///e:/Projects/k6/lib/executor/per_vu_iterations.go)
- [options.go](file:///e:/Projects/k6/lib/options.go)
