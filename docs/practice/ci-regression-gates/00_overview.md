# CI Regression Gates Layer -- Overview

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource/Capacity → Observability/SLO → CI Regression Gates → Soak/Endurance
```

Đây là layer **phân tích** (analysis layer), xếp sau Observability/SLO. Sau khi đã biết SLO định nghĩa điều gì quan trọng, câu hỏi tiếp theo là:

```text
Làm sao để CI tự động chặn regression trước khi merge?
Khi PR thay đổi code, latency hoặc error rate có vượt ngưỡng cho phép so với baseline không?
Làm sao phân biệt "regression thật" với "capacity boundary có chủ đích"?
```

Layer này không định nghĩa script mới -- nó **tái sử dụng** script từ các layer khác nhưng dạy learner mô hình **baseline vs candidate comparison** và cách CI gate tự động ra quyết định pass/warn/fail.

## 2. Mental model

```text
Baseline run (trước PR)
  ├── Chạy script với RUN_ID = "ci-xx-baseline"
  ├── Thu thập: summary, resource, request breakdown
  └── Lưu thành artifact baseline
        ↓
Candidate run (sau PR)
  ├── Chạy CÙNG script với RUN_ID = "ci-xx-candidate"
  ├── Thu thập: summary, resource, request breakdown
  └── Lưu thành artifact candidate
        ↓
Gate evaluation (tự động)
  ├── So sánh từng metric: candidate vs baseline
  ├── Áp dụng tolerance formula cho từng gate
  └── Trả về: pass / warn / fail
```

**Nguyên tắc cốt lõi:** Không đánh giá candidate một mình (có vẻ "xanh" nhưng chậm hơn baseline 30% vẫn là regression). Luôn so sánh với baseline.

## 3. 6 gate metrics

Mỗi gate metric có formula tolerance riêng và severity riêng:

| Gate | Metric | Rule | Severity |
| --- | --- | --- | --- |
| **availability** | `http_req_failed_rate` | `candidate <= max(0.01, baseline + 0.005)` | **fail** |
| **latencyP95** | `http_req_duration_p95` | `candidate <= baseline * 1.20 + 25ms` | **fail** |
| **latencyP99** | `http_req_duration_p99` | `candidate <= baseline * 1.30 + 50ms` | **warn** |
| **throughput** | `iterations` hoặc `http_reqs per second` | `candidate >= baseline * 0.90` | **warn** |
| **resourceCPU** | Container CPU p95 từ `/v1/tests/:id/resources` | `candidate <= baseline * 1.25 + 5pp` | **warn** |
| **resourceMemory** | Container memory % max từ `/v1/tests/:id/resources` | `candidate <= baseline + 10pp` | **warn** |

**Severity semantics:**
- **fail** (2 gates): Vi phạm → CI block merge. Đây là regression nghiêm trọng.
- **warn** (4 gates): Vi phạm → CI cảnh báo, không block, nhưng team phải review.

### Tại sao fail ít, warn nhiều

Latency P95 và availability là user-facing -- user cảm nhận trực tiếp. Latency P99 là tail latency, quan trọng nhưng nhiễu hơn. Throughput và resource có thể dao động do môi trường. Thiết kế này phản ánh production CI gate thực tế: không block mọi thứ, nhưng fail những thứ user thấy.

## 4. Compare artifact schema

Sau khi chạy baseline + candidate, FE export artifact JSON để CI agent đọc:

```json
{
  "schema": "k6-dashboard-ci-regression-gate/v1",
  "baselineRunId": "ci-01-baseline",
  "candidateRunId": "ci-01-candidate",
  "caseId": "ci-01-green-path-regression",
  "summaryDiff": {
    "http_req_failed_rate": { "baseline": 0.0, "candidate": 0.0, "delta": 0.0 },
    "http_req_duration_p95": { "baseline": 9.2, "candidate": 9.29, "delta_pct": 0.98 },
    "http_req_duration_p99": { "baseline": 12.1, "candidate": 12.3, "delta_pct": 1.65 },
    "iterations": { "baseline": 48, "candidate": 48, "delta_pct": 0.0 }
  },
  "resourceDiff": {
    "cpu_p95_pct": { "baseline": 8.2, "candidate": 8.5, "delta_pp": 0.3 },
    "memory_max_pct": { "baseline": 12.1, "candidate": 12.3, "delta_pp": 0.2 }
  },
  "requestBreakdownDiff": {
    "products_GET": { "baseline_p95": 8.5, "candidate_p95": 8.6 }
  },
  "gateResults": {
    "availability": { "verdict": "pass", "baseline": 0.0, "candidate": 0.0 },
    "latencyP95": { "verdict": "pass", "baseline": 9.2, "candidate": 9.29, "threshold": 36.04 },
    "latencyP99": { "verdict": "pass", "baseline": 12.1, "candidate": 12.3, "threshold": 65.73 },
    "throughput": { "verdict": "pass", "baseline": 48, "candidate": 48, "threshold": 43 },
    "resourceCPU": { "verdict": "pass", "baseline": 8.2, "candidate": 8.5, "threshold": 15.25 },
    "resourceMemory": { "verdict": "pass", "baseline": 12.1, "candidate": 12.3, "threshold": 22.1 }
  },
  "overallStatus": "pass"
}
```

**overallStatus logic:**
- Có bất kỳ gate fail → `"fail"`
- Không fail, có bất kỳ gate warn → `"warn"`
- Tất cả pass → `"pass"`

## 5. 3 cases

| Case | Capability | Script | VUs | Pattern |
| --- | --- | --- | ---: | --- |
| ci-01 | Green-path API regression gate | `load-target/k6/app/32-per-vu-business-core.js` | 4-8 | Baseline vs Candidate |
| ci-02 | DB read/write regression gate | `load-target/k6/app/30-capacity-sizing-sweep.js` | arrival-rate | Baseline vs Candidate |
| ci-03 | Protected capacity regression gate | `load-target/k6/app/29-nonk8s-prod-approx.js` | 4 | Baseline vs Candidate |

Cả 3 case đều dùng cùng pattern: **chạy 2 lần** (baseline + candidate), so sánh kết quả, gate đánh giá pass/warn/fail. Không case nào cần `OPS_AUTH_TOKEN`.

## 6. Baseline vs candidate: pattern phổ quát

```text
                      BASELINE                      CANDIDATE
                      ────────                      ─────────
  Khi nào chạy:       Trước PR (main branch)        Sau PR (feature branch)
  RUN_ID:              ci-xx-baseline                ci-xx-candidate
  Env vars:            Giống hệt candidate           Giống hệt baseline
  Code:                Main                          Feature branch
  Dữ liệu:             Dữ liệu test cố định          Dữ liệu test cố định (giống baseline)
  
  SO SÁNH:             candidate vs baseline → pass/warn/fail per metric
```

**Quan trọng:** Env vars phải GIỐNG HỆT nhau giữa baseline và candidate. Sự khác biệt duy nhất là code thay đổi trong PR. Nếu thay đổi env vars (vd tăng `db_rows`), đó không còn là regression test -- đó là capacity exploration.

## 7. Production lesson

CI Regression Gates layer trả lời câu hỏi "PR này có làm hệ thống tệ đi không?" bằng evidence, không bằng cảm tính:

- **ci-01 (Green path):** PR thay đổi business logic → CI chạy script baseline + candidate → so sánh latency và error rate → block nếu regression
- **ci-02 (DB path):** PR thay đổi DB query/index → CI so sánh DB-path latency, 429 rate, resource → block nếu DB chậm hơn
- **ci-03 (Protected capacity):** PR không được tạo ra unexpected errors khi hệ thống chịu áp lực -- degradation phải predictable

**SLOs define what matters; regression gates enforce it.**

SLO cho biết "latency p95 phải dưới 500ms". Regression gate cho biết "PR này không được làm latency p95 tăng quá 20% so với baseline, kể cả khi baseline đang 9ms (thấp hơn nhiều so với SLO 500ms)". Gate bảo vệ xu hướng, không chỉ ngưỡng tuyệt đối.
