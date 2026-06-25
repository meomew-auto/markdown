# Soak / Endurance Layer -- Overview

## 1. Vi tri trong lo trinh

```text
CDN -> LB -> Microservices -> Redis -> Postgres/DB -> External -> Resource/Capacity
                                                              |
                              CI Regression Gates -----------/
                                      |
                              Soak / Endurance  <-- BAN O DAY
                                      |
                              Async Events Queue
```

Sau khi da co normal SLOs va regression gates, cau hoi tiep theo la:

```text
He thong co giu duoc nhung guarantee do trong 5 phut, 15 phut, 1 gio khong?
Cai gi thay doi theo thoi gian ma 30s test khong the phat hien?
```

Day la **ANALYSIS layer** -- no day nguoi hoc tim nhung slow failures ma short tests bo qua:
memory growth, resource drift, latency creep, backpressure accumulation.

## 2. Mental model: Time-based health

```text
Short test (30s):
  |----|  snapshot: CPU OK, memory OK, latency OK

Soak test (5m+):
  |----|----|----|----|----|----|----|----|----|----|
   warmup  steady state .............................
            ^                                       ^
            |-- memory flat?                       |-- van flat?
            |-- p95 stable?                       |-- van stable?
            |-- 429 ratio ~0?                     |-- van ~0?

Cai thay doi:
  - Memory: leak 0.5MB/phut -> 30s test khong thay, 5m test thay ro
  - Latency: queue build-up cham -> p95 tang dan 2ms/phut
  - Backpressure: 429 tu tu xuat hien khi capacity xuong cap
  - Connections: pool can kiet sau hang tram request
```

## 3. 3 profiles

| Profile | Duration | Use | Canh bao |
| --- | --- | --- | --- |
| **local-short** | 5m | Classroom demo, FE validation | An toan cho local Docker |
| **local-medium** | 15m-30m | Developer verification truoc commit | Can isolated stack |
| **nightly** | 1h+ | CI/nightly hoac instructor machine | **Chi dung khi target stack bi co lap va co the reset** |

> **CANH BAO:** Nightly profile (1h+) tao tai nguyen lien tuc trong 1 gio. Chi chay tren CI hoac
> may instructor voi stack rieng biet. Khong chay nightly tren may ca nhan dung chung stack.

## 4. 4 soak signals

| Signal | Source | Interpretation |
| --- | --- | --- |
| **memory-slope** | `/v1/tests/:id/resources` | Service memory tang deu sau warmup -> leak, cache growth, retained payloads, hoac unbounded buffers |
| **latency-drift** | Summary + response-time timeline | p95/p99 tang trong khi request rate on dinh -> queueing, DB contention, GC, hoac external dependency drift |
| **backpressure-accumulation** | Status breakdown, 429 counts | 429 ratio tang dan -> capacity dang xuong cap hoac rate vuot sustained capacity |
| **scheduler-health** | `dropped_iterations`, active VU trends | Dropped iterations trong open-model soak -> request duration hoac VU pool khong theo kip arrival slots |

### Cach doc signals

```text
memory-slope:
  - Flat after warmup (>60s):  Khoe
  - Rising 0.5-2MB/min:        Theo doi -- co the la cache fill binh thuong
  - Rising >2MB/min or khong cham lai:  LEAK -- can investigate

latency-drift:
  - p95/p99 flat after warmup: Khoe
  - p95 tang 1-3ms/phut:      Theo doi -- co the la GC cycle
  - p95 tang >5ms/phut:        DRIFT -- queueing hoac resource contention

backpressure-accumulation:
  - 429 ratio = 0%:            Khoe (rate trong sustained capacity)
  - 429 ratio = 0-2%:          Borderline
  - 429 ratio tang dan >2%:    BACKPRESSURE -- rate vuot sustained capacity

scheduler-health:
  - dropped_iterations = 0:    Khoe
  - dropped_iterations > 0:    VU pool khong du -- tang preAllocatedVUs hoac giam rate
```

## 5. 3 cases

| Case | Script | Profile | Ops token? | Thoi gian toi thieu |
| --- | --- | --- | --- | ---: |
| soak-01 | `30-capacity-sizing-sweep.js` | `realistic_mix`, rate=3 | Khong | 5m |
| soak-02 | `30-capacity-sizing-sweep.js` | `products_db_read`, rate=3, db_rows=80 | Khong | 5m |
| soak-03 | `03-dependency-recovery-matrix.js` | redis + dns_fail | **CAN** | ~2m |

## 6. Evidence model (soak-specific)

```json
{
  "soak": {
    "duration_seconds": 300,
    "phases": {
      "warmup_0_60s": { "p95_ms": 15, "memory_mb": 45 },
      "steady_60_300s": { "p95_ms": 14, "memory_mb": 46 }
    },
    "signals": {
      "memory_slope_mb_per_min": 0.25,
      "latency_drift_ms_per_min": -0.2,
      "backpressure_429_ratio": 0.0,
      "dropped_iterations": 0
    },
    "verdict": "PASS",
    "verdict_reason": "Memory flat, latency flat, 0 backpressure, 0 drops"
  }
}
```

## 7. Tai sao soak quan trong

```text
Short tests tim ra bugs.
Soak tests tim ra leaks, drift, va accumulation.

Mot vi du:
  - 30s smoke test: 100 reqs, 100% success, p95=12ms -> "System OK"
  - 5m soak test:  900 reqs, 97% success, p95=45ms, memory +8MB
    -> "System co memory leak nho, latency drift sau 3 phut"

Khong co soak, ban chi biet system khoe trong 30 giay.
Co soak, ban biet system khoe trong 5 phut, 15 phut, 1 gio.
```
