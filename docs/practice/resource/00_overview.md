# Resource / Capacity Layer — Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource/Capacity
```

Đây là layer **cuối cùng**. Sau khi đã xác nhận mọi layer hoạt động đúng, câu hỏi cuối cùng là:

```text
Hệ thống tiêu thụ bao nhiêu CPU, memory, disk, DB, external latency cho mỗi request?
Tăng knobs (cpu_ms, db_rows, memory_kb) → metrics có tăng monotonic không?
Container resource (CPU %, RAM, network, disk) có được audit đúng không?
Ở rate nào thì hệ thống bắt đầu drop iteration?
```

## 2. Mental model

```text
API knobs (query params)
  cpu_ms, db_rows, db_writes, memory_kb, disk_kb, json_items, gzip_kb, external_ms
        ↓
  Service xử lý → response chứa:
    performance.resource_model  — xác nhận knobs đã được áp dụng
    performance.breakdown       — đo actual cost (cpu_ms, db_ms, external_ms...)
    performance.observed_resource_delta — Go runtime metrics (CPU, heap, goroutines)
        ↓
  Container-level (live resource):
    CPU %, RAM MB, network I/O, disk I/O — từ Docker stats
        ↓
  Dashboard Capacity tab:
    GET /v1/tests/:id/resources — persisted history
    GET /v1/resources/live — realtime container snapshot
```

## 3. 5 capability proofs

| Case | Capability | VUs | Ops token? |
| --- | --- | ---: | --- |
| res-01 | Resource model correctness | 1 | Không |
| res-02 | Resource trend monotonicity | 1 | Không |
| res-03 | Container resource audit | 1 | Không |
| res-04 | Non-K8s production approximation | 4 | Không |
| res-05 | Capacity sizing sweep | arrival-rate | Không |

## 4. Evidence model

```json
{
  "performance": {
    "resource_model": {
      "cpu_target_ms": 8,
      "db_rows": 120,
      "memory_kb": 512,
      "disk_kb": 64,
      "json_target_items": 100
    },
    "breakdown": {
      "cpu_ms": 2, "db_ms": 5, "external_ms": 0
    },
    "observed_resource_delta": {
      "cpu_total_ms_delta": 10,
      "heap_alloc_mb_delta": 0.69,
      "gc_cycles_delta": 1
    },
    "bottleneck": "db_ms",
    "bottleneck_percent": 55
  }
}
```

## 5. Resource trend families (res-02)

```text
cpu:       off(0) → medium(8) → high(24)
db_read:   off(0) → medium(40) → high(120)
db_write:  off(0) → medium(4) → high(12)
payload:   off(0) → medium(20) → high(100)
memory:    off(0) → medium(512KB) → high(2048KB)
disk:      off(0) → medium(32KB) → high(128KB)
gzip:      off(0) → medium(32KB) → high(256KB)
external:  off(0) → medium(40ms) → high(120ms)
```

## 6. Production lesson

Resource layer trả lời câu hỏi "với traffic dự kiến, cần bao nhiêu resource?":
- **res-01**: Knobs có map đúng vào metrics không? (trust foundation)
- **res-02**: Tăng knobs → metrics có tăng không? (monotonicity)
- **res-03**: Container resources có được expose không? (audit)
- **res-04**: System behavior dưới realistic load? (prod approx)
- **res-05**: Capacity limit ở đâu? (sweep)
