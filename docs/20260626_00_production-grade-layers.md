# Production-Grade Layers — Synthesis

> **Date:** 2026-06-26
> **Scope:** Observability/SLO, CI Regression Gates, Soak/Endurance
> **Position:** Sau Resource layer — đây là 3 layer phân tích, không phải layer hạ tầng
> **Dashboard:** http://localhost:13001/ → tab Production (mới)

---

## 1. Vị trí trong lộ trình

```text
CDN → LB → Microservices → Redis → Postgres/DB → External → Resource
                                                              ↓
                                    ┌─────────────────────────┴──────────────────────┐
                                    ↓                         ↓                        ↓
                              Observability/SLO        CI Regression Gates        Soak/Endurance
```

Đây là 3 layer **phân tích (analysis)**, không phải hạ tầng. Chúng reuse script từ các layer trước nhưng dạy learner cách **đọc và quyết định** — không phải cách chạy infrastructure.

| Layer | Hỏi gì | Dạy gì |
| --- | --- | --- |
| **Observability/SLO** | Hệ thống có đang healthy không? | Đọc SLI cards, trace correlation, phân biệt incident vs backpressure |
| **CI Regression Gates** | PR này có làm hỏng performance không? | Baseline vs candidate, gate formula, pass/warn/fail decision |
| **Soak/Endurance** | Sau 5 phút / 1 giờ thì sao? | Memory slope, latency drift, backpressure accumulation |

---

## 2. Observability / SLO

### Mental model
```text
k6 run → metrics push → dashboard summary
                            ↓
                      SLI cards được tính:
                        availability = 1 - http_req_failed_rate
                        latency_p95 = http_req_duration_p95
                        capacity_protection = 429/tolerated + dropped_iterations
                        resource_headroom = container CPU/memory trend
                            ↓
                      SLO decision: PASS / WARN / FAIL
                            ↓
                      Nếu FAIL → trace correlation:
                        request_id → trace_id → operation → service → resource sample
```

### 3 cases
| Case | Script | Mục đích |
| --- | --- | --- |
| obs-01 | 24-order-service-trace-correlation.js | Từ 1 request chậm → trace toàn bộ chain |
| obs-02 | 32-per-vu-business-core.js | Business flow bình thường → SLI cards xanh? |
| obs-03 | 29-nonk8s-prod-approx.js (cpu_throttle) | 429 dưới áp lực → incident hay expected? |

### 4 SLO contracts
| SLO | SLI | Target |
| --- | --- | --- |
| API Availability | 1 - http_req_failed_rate | >= 99% |
| API Latency p95 | http_req_duration_p95 | <= 500ms (green path) |
| Capacity Protection | 429 ratio + dropped_iterations | 0 (green); explained (pressure) |
| Resource Headroom | Container CPU/memory trend | No sustained saturation |

---

## 3. CI Regression Gates

### Mental model
```text
Baseline run (đã biết tốt)           Candidate run (PR/build mới)
        ↓                                       ↓
  Summary + Resources + Breakdown        Summary + Resources + Breakdown
        ↓                                       ↓
              ┌──────────────────────────────────┐
              │     GATE EVALUATION               │
              │  Per metric: pass / warn / fail   │
              │  Overall:   pass / warn / fail    │
              └──────────────────────────────────┘
```

### 6 gate metrics
| Gate | Metric | Rule | Severity |
| --- | --- | --- | --- |
| Availability | http_req_failed_rate | candidate <= max(1%, baseline + 0.5%) | FAIL |
| Latency p95 | http_req_duration_p95 | candidate <= baseline × 1.20 + 25ms | FAIL |
| Latency p99 | http_req_duration_p99 | candidate <= baseline × 1.30 + 50ms | WARN |
| Throughput | req/s | candidate >= baseline × 0.90 | WARN |
| Resource CPU | CPU p95 | candidate <= baseline × 1.25 + 5pp | WARN |
| Resource Memory | Memory max | candidate <= baseline + 10pp | WARN |

### Compare artifact
```json
{
  "schema": "k6-dashboard-ci-regression-gate/v1",
  "baselineRunId": 150,
  "candidateRunId": 151,
  "gateResults": { "availability": "pass", "latencyP95": "pass", ... },
  "overallStatus": "pass"
}
```

### 3 cases
| Case | Script | Kiểm tra gì |
| --- | --- | --- |
| ci-01 | 32-per-vu-business-core.js | Business flow không regression |
| ci-02 | 30-capacity-sizing-sweep.js (products_db_read) | DB path latency không tăng |
| ci-03 | 29-nonk8s-prod-approx.js (cpu_throttle) | Degradation predictable, không 5xx bất ngờ |

---

## 4. Soak / Endurance

### Mental model
```text
Time →
  0s        60s        120s       180s       240s       300s
  ├─────────┼──────────┼──────────┼──────────┼──────────┤
  warmup    steady state → → → → → → → → → → → → → → → end
  
  Quan sát:
  ┌──────────────┬──────────────────────────────────────┐
  │ Memory       │ ─── (phẳng) → OK                     │
  │              │ ╱╱╱ (tăng đều) → leak/ cache growth  │
  ├──────────────┼──────────────────────────────────────┤
  │ Latency p95  │ ─── (phẳng) → OK                     │
  │              │ ╱╱╱ (tăng) → queueing/contention     │
  ├──────────────┼──────────────────────────────────────┤
  │ 429 ratio    │ ─── (phẳng) → OK                     │
  │              │ ╱╱╱ (tăng) → capacity degrading      │
  ├──────────────┼──────────────────────────────────────┤
  │ Dropped iter │ 0 suốt → scheduler OK                │
  │              │ >0 → VU pool không theo kịp          │
  └──────────────┴──────────────────────────────────────┘
```

### 3 profiles
| Profile | Duration | Dùng khi |
| --- | --- | --- |
| local-short | 5 phút | Classroom demo, FE validation |
| local-medium | 15-30 phút | Dev verification trước commit |
| nightly | 1h+ | CI/nightly, máy instructor |

### 4 soak signals
| Signal | Source | Dấu hiệu xấu |
| --- | --- | --- |
| Memory slope | /v1/tests/:id/resources | Memory tăng đều sau warmup → leak |
| Latency drift | Summary + timeline | p95/p99 tăng dù rate không đổi |
| Backpressure accumulation | Status breakdown | 429 ratio tăng theo thời gian |
| Scheduler health | dropped_iterations + VU trend | Drop tăng → VU pool cạn |

### 3 cases
| Case | Script | Hỏi gì |
| --- | --- | --- |
| soak-01 | 30-capacity-sizing-sweep.js (realistic_mix, rate=3) | Mixed flow ổn định sau 5 phút? |
| soak-02 | 30-capacity-sizing-sweep.js (products_db_read, rate=3) | DB read sustained, memory không drift? |
| soak-03 | 03-dependency-recovery-matrix.js (redis, dns_fail) | Phục hồi nhiều lần, không degradation tích lũy? |

---

## 5. Validation Smoke (2026-06-26)

| Run | Layer | Script | Kết quả |
| --- | --- | --- | --- |
| #148 | obs-01 | 24-order-service-trace-correlation.js | 3 reqs, 100% checks, 1 resource sample ✅ |
| #149 | obs-02 | 32-per-vu-business-core.js | 30 reqs, 100% checks, 2 resource samples ✅ |
| #150 | ci-01 baseline | 32-per-vu-business-core.js | 17 reqs, p95=9.20ms, 4 resource samples ✅ |
| #151 | ci-01 candidate | 32-per-vu-business-core.js | 17 reqs, p95=9.29ms, 5 resource samples ✅ |
| #152 | soak-01 short | 30-capacity-sizing-sweep.js | 121 reqs, 60s, 30 resource samples ✅ |

**Kết quả:** Tất cả smoke pass. Resource persistence hoạt động (1-30 samples tùy duration).

**CI gate so sánh #150 vs #151:**
- Availability: pass (cả 2 đều 0% fail)
- Latency p95: pass (9.20ms → 9.29ms, trong tolerance 20%)
- Latency p99: pass
- Overall: PASS ✅

---

## 6. Dashboard Integration

### Tab Production (mới)
Gom 3 panel trong 1 tab:
- **SLO Decision:** Chọn run → hiển thị pass/warn/fail cho 4 SLI
- **CI Regression Gate:** Chọn baseline + candidate → gate evaluation
- **Soak Readiness:** Resource sample count + memory slope

### Tab cũ được reuse
- **Overview:** Chart/summary chính cho từng run
- **Resources:** CPU/RAM/network/disk timeline
- **Compare:** Diff raw giữa 2 run
- **Capacity:** Resource history + live container snapshot

---

## 7. Learner Journey (hoàn chỉnh)

Sau khi hoàn thành toàn bộ 8 layer (6 infrastructure + 3 analysis):

1. **CDN** → Hiểu edge caching, cache hit/miss ratio
2. **LB** → Hiểu load balancing, routing, health checks
3. **Microservices** → Hiểu service contracts, circuit breaker, stateful flows
4. **Redis** → Hiểu shared state, atomicity, session consistency
5. **Postgres/DB** → Hiểu DB pressure, connection pool, fault recovery
6. **External** → Hiểu external dependency, retry, webhook idempotency
7. **Resource** → Hiểu resource model, trend monotonicity, capacity ceiling
8. **Observability/SLO** → Đọc SLI, trace correlation, SLO decision
9. **CI Regression Gates** → Baseline/candidate, gate formula, pass/warn/fail
10. **Soak/Endurance** → Memory slope, latency drift, backpressure accumulation

**Learner có thể:**
- Chạy performance test có hệ thống từ edge đến database
- Đọc chart và phân biệt rate-limited vs resource-saturated pattern
- Thiết lập SLO/SLI cho API
- Thiết lập CI regression gate để chặn PR làm chậm hệ thống
- Chạy soak test để tìm memory leak và latency drift
- Đọc resource telemetry (CPU/RAM/network/disk) correlation với traffic
