# Observability / SLO Layer -- Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource/Capacity → Observability/SLO → CI Regression Gates
```

Đây là layer **phân tích** (analysis layer), không phải infrastructure layer. Sau khi đã chạy qua toàn bộ infrastructure stack, câu hỏi tiếp theo là:

```text
Hệ thống có đang đáp ứng SLO với người dùng không?
Một request chậm ánh xạ ngược về operation nào, service nào, container nào?
429 là incident hay backpressure có chủ đích?
```

Layer này không định nghĩa script mới -- nó tái sử dụng script từ các layer khác nhưng dạy learner đọc SLI cards, correlate traces, và ra production-style health decision.

## 2. Mental model

```text
SLI Cards (4 cards)
  ├── API availability: 1 - http_req_failed_rate ≥ 99%
  ├── API latency p95: http_req_duration_p95 ≤ 500ms
  ├── Capacity protection: 429/tolerated + dropped_iterations
  └── Resource headroom: container CPU/memory trend
        ↓
  Trace Correlation (obs-01)
    Request ID → Trace ID → Operation → Service → Resource evidence chain
        ↓
  SLO Decision (obs-02, obs-03)
    Green path: all SLIs pass → system healthy
    Pressure path: 429 appears → classify: incident? guardrail? capacity signal?
```

## 3. 4 SLO cards

### SLO-1: API Availability

| Field | Value |
| --- | --- |
| **SLI** | `1 - http_req_failed_rate` |
| **Target** | ≥ 99% |
| **Dashboard formula** | `100 - http_req_failed_rate * 100` |
| **Notes** | Dùng script-specific expected statuses. Pressure case map 429 thành backpressure, không tính vào failure rate. |

### SLO-2: API Latency p95

| Field | Value |
| --- | --- |
| **SLI** | `http_req_duration_p95` |
| **Target** | ≤ 500ms (green-path profiles) |
| **Dashboard formula** | `summary.http_req_duration_p95` |
| **Notes** | Pressure/capacity case phải hiển thị target caveat thay vì blind fail. |

### SLO-3: Capacity Protection

| Field | Value |
| --- | --- |
| **SLI** | `429/tolerated status ratio + dropped_iterations` |
| **Target** | 0 cho green run; visible và explained cho capacity-boundary run |
| **Dashboard formula** | `breakdown status counts + summary.dropped_iterations` |
| **Notes** | 429 với low latency và dropped_iterations=0 thường là backend self-protection, không phải k6 scheduler failure. |

### SLO-4: Resource Headroom

| Field | Value |
| --- | --- |
| **SLI** | Container CPU/memory/network/disk trend trong suốt run |
| **Target** | Không có sustained saturation cho green run |
| **Dashboard formula** | `GET /v1/tests/:id/resources` |
| **Notes** | Resource samples được persist bởi metrics-server khi `RESOURCE_STATS_ENABLED=true`. |

## 4. 3 cases

| Case | Capability | Script | VUs | Ops token? |
| --- | --- | --- | ---: | --- |
| obs-01 | Trace & request correlation | `24-order-service-trace-correlation.js` | 1 | **Có** |
| obs-02 | Green-path SLO decision | `32-per-vu-business-core.js` | 4-8 | Không |
| obs-03 | Pressure SLO exception | `29-nonk8s-prod-approx.js` | 4 | Không |

## 5. Evidence model

```json
{
  "run": {
    "run_id": "fe-obs-trace",
    "scenario": "order_trace_correlation",
    "test_run_id": 148
  },
  "sli_cards": {
    "api_availability": {
      "value": 100.0,
      "target": ">= 99%",
      "verdict": "pass",
      "evidence": "summary.http_req_failed_rate = 0.0"
    },
    "api_latency_p95": {
      "value_ms": 12.5,
      "target": "<= 500ms",
      "verdict": "pass",
      "evidence": "summary.http_req_duration_p95 = 12.5ms"
    },
    "capacity_protection": {
      "tolerated_429": 0,
      "dropped_iterations": 0,
      "verdict": "pass",
      "evidence": "summary.nonk8s_prod_approx_tolerated_errors = 0"
    },
    "resource_headroom": {
      "cpu_max_pct": 12.3,
      "memory_max_mb": 156.7,
      "verdict": "pass",
      "evidence": "GET /v1/tests/148/resources"
    }
  },
  "trace_correlation": {
    "request_id": "req-trace-confirm-...",
    "trace_id": "fe-obs-trace:confirm:...",
    "operation": "order_confirm",
    "service": "order-service",
    "resource_evidence": "cpu_ms=0, db_writes=1, external_ms=20"
  },
  "decision": {
    "verdict": "green",
    "rationale": "All 4 SLIs pass. Trace correlation chain complete. No anomalies."
  }
}
```

Evidence chain hoạt động như sau:
1. **Summary** (`/v1/tests/:id/summary`) -- aggregate totals: http_req_failed_rate, p95, dropped_iterations
2. **Series/Debug JSON** -- timeline breakdown: which second had the spike, which endpoint contributed
3. **Resource samples** (`/v1/tests/:id/resources`) -- container CPU/memory at each timestamp
4. **Trace headers** -- `X-Request-ID`, `X-Trace-ID`, `X-Test-Run-ID` trong response headers và body

Ba nguồn dữ liệu này kết hợp để tạo ra SLO decision:
- Summary cho biết CÓ vấn đề không (availability < 99%?)
- Series cho biết VẤN ĐỀ XẢY RA KHI NÀO (spike ở giây thứ mấy?)
- Resource cho biết NGUYÊN NHÂN (CPU saturation? memory leak?)
- Trace cho biết REQUEST NÀO bị ảnh hưởng (operation → service → dependency)

## 6. Production lesson

Observability/SLO layer trả lời câu hỏi "system có healthy không?" bằng evidence, không bằng cảm tính:
- **obs-01**: Một request chậm phải trace được về operation, service, và resource (correlation)
- **obs-02**: Green path phải pass tất cả 4 SLI cards -- không chỉ "không lỗi" (SLO decision)
- **obs-03**: 429 không phải lúc nào cũng là incident -- phân biệt backpressure có chủ đích với failure thật (SLO exception)
