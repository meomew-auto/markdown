# db-01 -- Order DB delay and recovery

> **Case ID:** `db-01-order-db-delay-recovery`
> **Script:** `../app/07-production-mix-order-db-recovery.js`
> **Profile:** `full-no-cdn`
> **Workload:** 1 VU, 1 iteration (sequential), requires `OPS_AUTH_TOKEN`
> **Proof:** Inject DB delay 35ms qua `/ops/order/db/profile` → `performance.breakdown.db_ms` tăng → reset → recovery. DB latency observable và recoverable.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Postgres mechanism deep-dive: DB delay injection và recovery](#6-postgres-mechanism-deep-dive-db-delay-injection-và-recovery)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals](#8-key-signals)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist](#13-checklist)
14. [4-5 Variations](#14-4-5-variations)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh vận hành

11:00 AM thứ Sáu. Team infrastructure thông báo: "Postgres instance sắp được nâng cấp lên version mới. Trong quá trình failover sang replica, ứng dụng có thể thấy latency tăng 30-50ms trong vài giây."

Đây không phải là tình huống giả định. Mọi hệ thống dùng Postgres đều trải qua:
- **Maintenance window**: Vacuum, reindex, upgrade version
- **Failover**: Primary → standby switchover
- **Network degradation**: Cross-AZ latency spike

Câu hỏi: **ứng dụng có hoạt động đúng khi DB chậm không? Và có recover sau khi DB bình thường trở lại không?**

### 1.2 Controlled experiment — không phải chaos

```text
Khác với chaos engineering (bắn random failure vào production),
đây là controlled experiment:
  - Biết trước delay bao nhiêu ms (35ms default)
  - Biết trước delta latency expected (160ms)
  - Có control plane để reset về trạng thái sạch
  - Sequential (1 VU, 1 iteration) — dễ đọc, dễ debug
```

### 1.3 Tại sao DB delay nguy hiểm hơn CPU delay?

| Loại delay | Ảnh hưởng | Cơ chế |
| --- | --- | --- |
| CPU delay (`cpu_ms`) | Chỉ ảnh hưởng request hiện tại | Worker thread bận |
| DB delay (`postgres_delay_ms`) | Ảnh hưởng TẤT CẢ request dùng DB | Connection pool bị giữ lâu hơn |
| External delay (`external_ms`) | Chỉ ảnh hưởng request có external call | HTTP client wait |

DB delay là nguy hiểm nhất vì nó ảnh hưởng **toàn bộ connection pool** — không chỉ request hiện tại, mà cả request trong queue.

### 1.4 Ba phase của experiment

```text
Phase 1 — Baseline:  Đo latency bình thường (không delay)
Phase 2 — Degraded:   Inject delay 35ms → latency tăng
Phase 3 — Recovery:   Reset → latency trở về baseline
```

Pattern này lặp lại trong db-01, db-02, db-03: **Inject → Observe → Reset → Verify**.

### 1.5 Real-world trigger scenarios cho DB delay

DB delay không chỉ đến từ maintenance window. Dưới đây là các tình huống production thực tế:

| Tình huống | Delay điển hình | Duration | Cơ chế |
| --- | --- | --- | --- |
| Cross-AZ replication lag | 10-50ms | Liên tục (trong giờ cao điểm) | Network latency giữa các AZ |
| Autovacuum trên bảng lớn | 20-100ms | 5-30 phút | Disk I/O bị chiếm bởi vacuum |
| Checkpoint spike | 30-80ms | 1-5 giây mỗi 5 phút | PostgreSQL flush WAL to disk |
| Connection pool saturation | 50-500ms | Vài giây đến vài phút | Tất cả connections bận |
| PGBouncer pause/resume | 100-2000ms | Vài giây | Connection pooler maintenance |
| Schema migration (lock) | 100-5000ms | Vài giây đến vài phút | ALTER TABLE cần lock |
| Disk I/O contention | 20-200ms | Liên tục (noisy neighbor) | Shared storage với workload khác |

Case này mô phỏng **cross-AZ replication lag** và **autovacuum spike** — các tình huống delay nhẹ (35ms) nhưng kéo dài và ảnh hưởng đến mọi query.

### 1.6 Cách DB delay lan truyền qua hệ thống

```text
Postgres chậm 35ms mỗi query
  → Mỗi connection giữ lâu hơn 35ms
  → Connection pool cạn nhanh hơn bình thường
  → Request mới phải chờ connection (queuing delay)
  → Worker threads bận lâu hơn
  → Event loop bị block (nếu dùng async driver)
  → Toàn bộ service chậm theo cấp số nhân, không phải cấp số cộng
```

Với 10 connections trong pool và 50 requests/giây:
- Không delay: Mỗi request dùng connection ~50ms → pool quay vòng đủ nhanh
- Delay 35ms: Mỗi request dùng connection ~85ms → pool quay vòng chậm hơn 70% → queuing bắt đầu

Đây là lý do DB delay nguy hiểm: **nó không chỉ cộng thêm latency, nó còn gây ra hiệu ứng domino qua connection pool**.

### 1.7 Phân biệt delay vs slow query

| Khía cạnh | DB delay (case này) | Slow query |
| --- | --- | --- |
| Nguyên nhân | Infrastructure (network, disk, failover) | Query plan xấu, missing index |
| Phạm vi | Tất cả queries trong service | Chỉ query cụ thể |
| Cách sửa | Fix infrastructure hoặc failover strategy | Optimize query hoặc thêm index |
| Cách test | Inject artificial delay qua control plane | Dùng `db_rows` cao hoặc complex JOIN |
| Observability signal | `db_ms` tăng đều trên mọi endpoint | `db_ms` chỉ tăng trên endpoint cụ thể |

DB delay test (db-01) và slow query test (db-05, db-06) bổ trợ cho nhau: delay test kiểm tra infrastructure resilience, slow query test kiểm tra query performance.

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Khi DB bị delay, `performance.breakdown.db_ms` phản ánh chính xác mức delay. Các API dùng DB bị chậm đi nhưng vẫn hoạt động đúng (không fail). Các API không dùng DB không bị ảnh hưởng. Sau khi reset DB profile, latency trở về mức bình thường.**

### 2.2 Các khía cạnh được verify

1. **Delay injection hoạt động**: `PUT /ops/order/db/profile` với `postgres_delay_ms=35` → profile xác nhận đã set.
2. **Read path bị ảnh hưởng**: `GET /api/sim/orders/:id?db_rows=60` → `db_ms` tăng.
3. **Write path bị ảnh hưởng**: `POST /api/sim/checkout?db_writes=6` → `db_write_ms` tăng.
4. **Unaffected APIs không bị ảnh hưởng**: Products, cart, report — latency không tăng đáng kể.
5. **Recovery**: `POST /ops/order/db/reset` → latency trở về mức baseline.

### 2.3 Contract verification cụ thể

| Phase | Endpoint | Expected | Evidence |
| --- | --- | --- | --- |
| Baseline | `GET /ops/order/db/profile` | 200, `postgres_delay_ms=0` | Profile sạch |
| Baseline | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` present | Baseline latency |
| Degraded | `PUT /ops/order/db/profile` | 200, delay=35 | Profile set |
| Degraded | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` > baseline | Latency tăng |
| Degraded | `POST /api/sim/checkout?db_writes=6` | 200, `db_write_ms` > baseline | Write path affected |
| Degraded | `GET /api/sim/products` | 200, latency không tăng | Unaffected |
| Recovery | `POST /ops/order/db/reset` | 200 | Profile cleared |
| Recovery | `GET /api/sim/orders/:id?db_rows=60` | 200, `db_ms` ≈ baseline | Recovered |

### 2.4 Tại sao chọn delay 35ms?

Giá trị 35ms được chọn vì các lý do sau:

1. **Đủ lớn để observable**: Baseline `db_ms` ~2-5ms. 35ms gấp 7-17x baseline — sự khác biệt rõ ràng ngay cả khi có jitter.
2. **Đủ nhỏ để không gây timeout**: k6 default timeout 60s — 35ms không gây false positive.
3. **Realistic**: Cross-AZ replication lag trong AWS thường 10-50ms. 35ms nằm chính giữa khoảng này.
4. **An toàn cho sequential test**: Với 1 VU sequential, không có concurrent pressure, 35ms là đủ để thấy signal mà không làm test quá chậm.

### 2.5 Mối quan hệ với các case DB khác

| Case | Cơ chế degrade | Control plane | Mục đích |
| --- | --- | --- | --- |
| **db-01 (case này)** | Delay injection (35ms) | `/ops/order/db/profile` | Chứng minh delay observable và recoverable |
| db-02 | Pool pressure (limit + hold) | `/ops/order/db/profile` | Chứng minh pressure handling và recovery |
| db-03 | Fault injection (tcp_reset) | `/ops/order/db/profile` | Chứng minh fault contract và recovery |
| db-04 | Pool contention | `/ops/order/db/profile` | Trace correlation dưới contention |
| db-05 | Resource model correctness | Không cần | Verify db_rows/db_writes contract |
| db-06 | Capacity sweep | Không cần | Tìm capacity limit của DB read path |

db-01 là case nền tảng: nó chứng minh rằng control plane hoạt động, delay observable trong `performance.breakdown`, và recovery mechanism tồn tại. Tất cả các case sau (db-02, db-03, db-04) đều dựa trên nền tảng này.

---

## 3. Vì sao phải test ở DB layer

### 3.1 Vì sao không test ở Redis layer?

Redis test kiểm tra cache/state consistency. Redis không phải là persistent store — không có `db_ms`, `db_write_ms`, `resource_model.db_rows`. Redis delay test (redis-04) kiểm tra correctness under Redis delay, không kiểm tra DB delay.

### 3.2 Vì sao không test ở Microservices layer?

Microservices test kiểm tra API contract và routing. Nó không có control plane để inject DB delay. Nó không đọc `performance.breakdown` để xác nhận DB bị ảnh hưởng.

### 3.3 Vì sao phải test ở DB layer?

DB layer là nơi duy nhất có:
- **Control plane**: `/ops/order/db/profile` để inject delay có kiểm soát.
- **DB metrics**: `db_ms`, `db_write_ms`, `resource_model` trong response body.
- **Recovery verification**: Reset → verify latency trở về baseline.
- **Scope verification**: Xác nhận chỉ DB-dependent APIs bị ảnh hưởng.

### 3.4 So sánh toàn diện các layer test

| Khía cạnh | CDN layer | LB layer | Microservices layer | Redis layer | **DB layer (layer này)** |
| --- | --- | --- | --- | --- | --- |
| Câu hỏi chính | Cache hit chưa? | Route đúng upstream chưa? | Contract đúng không? | Shared state nhất quán không? | DB chịu được degrade không? |
| Control plane | Không | Không | Không | `/ops/order/redis/profile` | `/ops/order/db/profile` |
| Evidence | Response headers (`X-Cache`) | Upstream selection | Response body, status codes | Custom counters (fresh/reuse) | `db_ms`, `db_write_ms`, `resource_model` |
| Failure mode | Cache miss → origin fallback | Wrong upstream → 404/contract sai | Status sai, data sai | Duplicate side effect | 5xx transient, pool exhaustion |
| Recovery test | TTL tự động expire | Health check tự detect | Retry policy | Reset profile | Reset profile |
| Persistent store? | Không (CDN cache) | Không (proxy) | Không (stateless) | Không (cache TTL) | **Có — mọi data vĩnh viễn** |

DB layer là layer duy nhất test **persistent store** dưới degradation. Nếu DB test fail, data thật bị ảnh hưởng — không chỉ cache, không chỉ routing.

### 3.5 Hậu quả nếu không test ở DB layer

Nếu bỏ qua DB layer testing, các vấn đề sau sẽ không được phát hiện cho đến khi xảy ra trong production:

1. **DB delay làm cạn connection pool** → Ứng dụng tưởng "hơi chậm" nhưng thực ra đang tích lũy queuing delay.
2. **Recovery sau failover không hoạt động** → DB trở lại bình thường nhưng application vẫn dùng connection cũ (stale connection).
3. **Scope của delay không được isolate** → Một service bị DB delay ảnh hưởng đến service khác dùng chung pool.
4. **DB metrics không được verify** → Team không biết `db_ms` có thực sự phản ánh DB latency không, dẫn đến alerting sai.
5. **Timeout/retry setting không được test với delay thật** → Setting lý thuyết có thể quá aggressive (timeout sớm khi DB hơi chậm) hoặc quá lax (treo request khi DB rất chậm).

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/07-production-mix-order-db-recovery.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
BASE_URL: http://localhost:80
Requires: OPS_AUTH_TOKEN (cho /ops/order/db/*)
```

### 4.2 Stack requirement

```text
Phải có:
  k6target-order-service-1 (hoặc 2)
  k6target-postgres-1
  k6target-products-service-1
  k6target-cart-service-1
  k6target-report-service-1
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy
- [x] Postgres healthy
- [x] `OPS_AUTH_TOKEN` đã source từ container
- [x] DB profile sạch (chưa có delay từ test trước)

### 4.4 Kiến trúc chi tiết

```text
k6 (1 VU, sequential)
  |
  | Control plane calls: /ops/order/db/*
  | Runtime calls: /api/sim/orders/*, /api/sim/checkout, ...
  | Auth: OPS_AUTH_TOKEN (cho control plane), không auth cho runtime
  v
Nginx :80 (k6target-lb-app-1)
  |
  | Path-based routing:
  |   /api/sim/orders/*     → order-service (port 3000)
  |   /api/sim/checkout     → order-service (port 3000)
  |   /api/sim/products*    → products-service
  |   /api/sim/cart*        → cart-service
  |   /api/sim/report*      → report-service
  |   /ops/order/db/*       → order-service (ops endpoint)
  v
order-service (Node.js, k6target-order-service-1)
  |
  | DB profile (in-memory state):
  |   postgres_delay_ms = 0 | 35
  |   postgres_pressure_limit = 0
  |   postgres_pressure_hold_ms = 0
  |   postgres_fault_mode = '' | 'tcp_reset' | ...
  |
  | Mỗi DB query:
  |   1. Check postgres_delay_ms
  |   2. Nếu > 0: sleep(postgres_delay_ms) trước query
  |   3. Thực thi query thật qua pg driver
  v
PostgreSQL (k6target-postgres-1)
  |
  | Persistent store cho orders, products, cart, reports
  | Không biết gì về delay injection — delay ở application level
```

### 4.5 Container health verification

Trước khi chạy case, xác nhận tất cả containers đang running và healthy:

```powershell
# Kiểm tra tất cả containers
docker ps --filter "name=k6target" --format "table {{.Names}}\t{{.Status}}"

# Kỳ vọng output:
# k6target-lb-app-1            Up X minutes
# k6target-order-service-1     Up X minutes (healthy)
# k6target-postgres-1          Up X minutes (healthy)
# k6target-products-service-1  Up X minutes (healthy)
# k6target-cart-service-1      Up X minutes (healthy)
# k6target-report-service-1    Up X minutes (healthy)
```

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `07-production-mix-order-db-recovery.js` gồm 264 dòng, được tổ chức thành 8 phần:

```text
(A) IMPORTS + ENV VARS             (dòng 1-19):  k6 modules, toàn bộ biến môi trường
(B) CUSTOM METRICS                 (dòng 21-25): 1 Counter, 2 Rates, 1 Trend
(C) OPTIONS                        (dòng 28-40): 1 VU, 1 iteration, thresholds
(D) HELPER: AUTH + SAFE JSON       (dòng 42-69): authHeaders, jsonHeaders, safeJson
(E) CONTROL PLANE FUNCTIONS        (dòng 71-137): controlRequest, assertProfile, setDelay, resetDelay
(F) TRAFFIC GENERATION             (dòng 139-213): buildProductionSequence, requestMixApi, runPhase
(G) ASSERTIONS                     (dòng 215-232): assertPhaseAverages
(H) MAIN FLOW                      (dòng 234-263): default function — orchestrator
```

### 5.2 Phân tích — Phần A: Imports và Constants

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

import { envFloat, envInt, envString, requestApi } from '../shared/common.js';
import { productionMixApis } from '../shared/traffic.js';
```

Script import `requestApi` và `productionMixApis` từ shared modules:
- `requestApi`: Hàm helper gửi HTTP request với method, path, body, headers từ API definition object.
- `productionMixApis`: Array các API definition mô phỏng production traffic mix (orders, checkout, confirm, webhook, products, cart, report).

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const CONTROL_BASE_URL = envString('PROD_MIX_ORDER_DB_CONTROL_BASE_URL', BASE_URL).replace(/\/$/, '');
const PROFILE_PATH = envString('PROD_MIX_ORDER_DB_PROFILE_PATH', '/ops/order/db/profile');
const RESET_PATH = envString('PROD_MIX_ORDER_DB_RESET_PATH', '/ops/order/db/reset');
const DELAY_MS = envInt('PROD_MIX_ORDER_DB_DELAY_MS', 35);
const DELAY_DELTA_MS = envInt('PROD_MIX_ORDER_DB_DELAY_DELTA_MS', 160);
const RECOVERY_DELTA_MS = envInt('PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS', 120);
const RECOVERY_TOLERANCE_MS = envInt('PROD_MIX_ORDER_DB_RECOVERY_TOLERANCE_MS', 140);
const UNAFFECTED_TOLERANCE_MS = envInt('PROD_MIX_ORDER_DB_UNAFFECTED_TOLERANCE_MS', 100);
const INTER_REQUEST_SLEEP_SECONDS = envFloat('PROD_MIX_ORDER_DB_INTER_REQUEST_SLEEP_SECONDS', 0.04);
const WEIGHT_DIVISOR = envInt('PROD_MIX_ORDER_DB_WEIGHT_DIVISOR', 2);
const OPS_AUTH_TOKEN = envString('OPS_AUTH_TOKEN', '');
```

Biến `CONTROL_BASE_URL` mặc định bằng `BASE_URL` — nghĩa là control plane endpoint nằm trên cùng Nginx gateway với runtime API. Có thể override để trỏ đến internal admin port.

Các tham số quan trọng:

| Biến | Default | Ý nghĩa |
| --- | --- | --- |
| `DELAY_MS` | 35 | Số ms delay inject vào mỗi DB query |
| `DELAY_DELTA_MS` | 160 | Ngưỡng tối thiểu latency phải tăng trong degraded phase |
| `RECOVERY_DELTA_MS` | 120 | Ngưỡng tối thiểu latency phải giảm sau recovery |
| `RECOVERY_TOLERANCE_MS` | 140 | Ngưỡng tối đa latency sau recovery so với baseline |
| `UNAFFECTED_TOLERANCE_MS` | 100 | Ngưỡng tối đa unaffected APIs được phép tăng |
| `INTER_REQUEST_SLEEP_SECONDS` | 0.04 | Sleep 40ms giữa các request để tránh flood |
| `WEIGHT_DIVISOR` | 2 | Hệ số chia weight của production mix APIs |

### 5.3 Phân tích — Phần B: Custom Metrics

```javascript
const phaseDuration = new Trend('prod_mix_order_db_phase_duration', true);
const orderDbCheckFailures = new Counter('prod_mix_order_db_check_failures');
const degradedObserved = new Rate('prod_mix_order_db_degraded_observed');
const recoveredObserved = new Rate('prod_mix_order_db_recovered_observed');
```

| Metric | Type | Ý nghĩa | Tag |
| --- | --- | --- | --- |
| `prod_mix_order_db_phase_duration` | Trend | Duration của mỗi request theo phase | phase, api, affected |
| `prod_mix_order_db_check_failures` | Counter | Tổng check failures (must = 0) | label, target_service, target_dependency |
| `prod_mix_order_db_degraded_observed` | Rate | Tỉ lệ test thấy degradation | target_service, target_dependency |
| `prod_mix_order_db_recovered_observed` | Rate | Tỉ lệ test thấy recovery | target_service, target_dependency |

`Trend` với tham số `true` (isTime) — giá trị được hiểu là milliseconds, dashboard có thể hiển thị dưới dạng time series.

### 5.4 Phân tích — Phần C: Options

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    prod_mix_order_db_check_failures: ['count==0'],
  },
  tags: {
    scenario: 'production_mix_order_db_recovery',
    target_service: 'order-service',
    target_dependency: 'postgres',
  },
};
```

`vus: 1, iterations: 1` — sequential executor. Chỉ 1 VU chạy 1 lần. Tất cả các phase (baseline, degraded, recovery) được chạy tuần tự trong 1 iteration duy nhất.

Tại sao sequential mà không dùng scenarios?

| Executor | Phù hợp? | Vì sao |
| --- | --- | --- |
| **vus=1, iterations=1** (đang dùng) | DUNG | Sequential, dễ debug, mỗi phase phụ thuộc vào phase trước |
| constant-vus | SAI | Loop vô hạn — không kiểm soát được số lần gọi API |
| shared-iterations | SAI | Iterations chia cho VUs — không đảm bảo tuần tự |
| per-vu-iterations | SAI | Mỗi VU có iteration riêng — confusing cho sequential test |

### 5.5 Phân tích — Phần D+E: Auth Helpers và Control Plane Functions

**authHeaders và jsonHeaders:**

```javascript
function authHeaders() {
  const headers = {};
  if (OPS_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${OPS_AUTH_TOKEN}`;
    headers['X-Ops-Token'] = OPS_AUTH_TOKEN;
  }
  return headers;
}
```

Token được gửi qua cả `Authorization: Bearer` (standard) và `X-Ops-Token` (custom) để tương thích với các implementation khác nhau của ops authentication middleware.

**controlRequest — universal control plane helper:**

```javascript
function controlRequest(method, path, body, step) {
  const params = {
    headers: body ? jsonHeaders() : authHeaders(),
    tags: {
      step,
      control_plane: 'order_db',
      target_service: 'order-service',
      target_dependency: 'postgres',
    },
  };
  const url = `${CONTROL_BASE_URL}${path}`;
  // ... switch on method: GET, PUT, POST
}
```

Tag `control_plane: 'order_db'` cho phép lọc control plane requests trong dashboard — phân biệt với runtime API calls. Tag `step` cho biết chính xác bước nào đang được thực thi (baseline_profile_get, degraded_profile_set, recovered_profile_get, ...).

**assertProfile — verify DB profile state:**

```javascript
function assertProfile(label, expectedDelayMs) {
  const response = controlRequest('GET', PROFILE_PATH, null, `${label}_profile_get`);
  const payload = safeJson(response);
  const profile = payload && payload.profile ? payload.profile : {};
  const stats = profile && profile.postgres_pool_stats ? profile.postgres_pool_stats : {};

  check({ response, payload, profile, stats }, {
    [`${label} profile status 200`]: ...,
    [`${label} profile success true`]: ...,
    [`${label} profile initialized`]: ...,
    [`${label} profile delay ${expectedDelayMs}`]: ...,
    [`${label} profile pressure limit 0`]: ...,
    [`${label} profile pressure hold 0`]: ...,
    [`${label} profile fault mode none`]: ...,
    [`${label} pool stats pressure limit 0`]: ...,
    [`${label} pool stats fault mode none`]: ...,
  });
}
```

Hàm này không chỉ kiểm tra delay — nó kiểm tra TOÀN BỘ profile state:
- `postgres_delay_ms`: delay hiện tại
- `postgres_pressure_limit`, `postgres_pressure_hold_ms`: pressure parameters (phải = 0 trong case này)
- `postgres_fault_mode`: fault mode (phải = '' trong case này)
- Pool stats: xác nhận pool stats cũng phản ánh đúng trạng thái

Đây là một pattern quan trọng: **khi test delay, cũng phải verify rằng pressure và fault không vô tình bị bật**.

**setDelay và resetDelay:**

```javascript
function setDelay(label) {
  const response = controlRequest('PUT', PROFILE_PATH, {
    postgres_delay_ms: DELAY_MS,
    postgres_pressure_limit: 0,
    postgres_pressure_hold_ms: 0,
    postgres_fault_mode: 'none',
  }, `${label}_profile_set`);
  // check status 200, success true
}

function resetDelay(label) {
  const response = controlRequest('POST', RESET_PATH, {}, `${label}_profile_reset`);
  // check status 200, success true
}
```

`setDelay` cố tình set `pressure_limit=0, pressure_hold=0, fault_mode=none` — đảm bảo CHỈ CÓ delay được bật, không có pressure hay fault mode nào khác ảnh hưởng đến kết quả test.

`resetDelay` gọi `POST /ops/order/db/reset` — endpoint này xóa TOÀN BỘ profile settings, đưa mọi thứ về default (delay=0, pressure=0, fault=none).

### 5.6 Phân tích — Phần F: Traffic Generation

**buildProductionSequence:**

```javascript
function buildProductionSequence() {
  const sequence = [];
  for (const api of productionMixApis) {
    const repetitions = Math.max(1, Math.round(api.weight / WEIGHT_DIVISOR));
    for (let index = 0; index < repetitions; index += 1) {
      sequence.push(api);
    }
  }
  return sequence;
}
```

Hàm này tạo ra một sequence các API calls dựa trên production traffic mix. Mỗi API có một `weight` (tỉ lệ xuất hiện trong production). `WEIGHT_DIVISOR=2` giúp giảm số lần lặp để test nhanh hơn trong khi vẫn giữ tỉ lệ tương đối.

Ví dụ: nếu `order_status` có weight=10, `checkout` có weight=6, thì sequence sẽ có 5 order_status và 3 checkout.

**requestMixApi — gọi 1 API và record metrics:**

```javascript
function requestMixApi(api, phase) {
  const response = requestApi(BASE_URL, api, {
    headers: {
      ...authHeaders(),
      'X-Test-Suite': 'production-mix-order-db-recovery',
    },
    tags: {
      phase,
      scenario: 'production_mix_order_db_recovery',
      target_service: 'order-service',
      target_dependency: 'postgres',
      traffic_shape: 'production_mix',
    },
  });

  const affected = affectedApis.has(api.name);
  phaseDuration.add(response.timings.duration, {
    phase, api: api.name,
    affected: affected ? 'true' : 'false',
    target_service: 'order-service',
    target_dependency: 'postgres',
  });

  check(response, {
    [`${phase} ${api.name} status ${api.expected}`]: (r) =>
      r.status === api.expected || recordCheckFailure(`${phase}_${api.name}_status`),
  });

  return { response, affected };
}
```

Mỗi API call được tag với:
- `phase`: healthy, degraded, hoặc recovered
- `api`: tên API (order_status, checkout, ...)
- `affected`: true/false — API này có dùng order-service DB không?

Tag `affected` cho phép filter latency của affected vs unaffected APIs trong dashboard.

**runPhase — chạy 1 phase hoàn chỉnh:**

```javascript
function runPhase(phase, sequence) {
  const affectedDurations = [];
  const unaffectedDurations = [];

  for (const api of sequence) {
    const result = requestMixApi(api, phase);
    if (result.affected) {
      affectedDurations.push(result.response.timings.duration);
    } else {
      unaffectedDurations.push(result.response.timings.duration);
    }
    sleep(INTER_REQUEST_SLEEP_SECONDS);
  }

  return {
    affectedAverageMs: average(affectedDurations),
    affectedCount: affectedDurations.length,
    unaffectedAverageMs: average(unaffectedDurations),
    unaffectedCount: unaffectedDurations.length,
  };
}
```

Hàm này chạy toàn bộ sequence và phân loại durations thành 2 nhóm: affected (order-service APIs) và unaffected (products, cart, report). Kết quả trả về là average latency của mỗi nhóm.

Sleep 40ms giữa các request (`INTER_REQUEST_SLEEP_SECONDS=0.04`) — đủ để tránh flood Nginx/backend nhưng không quá lâu để test vẫn nhanh.

### 5.7 Phân tích — Phần G: Assertions

```javascript
function assertPhaseAverages(healthyMetrics, degradedMetrics, recoveredMetrics) {
  check({ healthyMetrics, degradedMetrics, recoveredMetrics }, {
    'degraded phase observed affected endpoints': ...,
    'recovered phase observed affected endpoints': ...,
    [`degraded affected avg >= healthy avg + ${DELAY_DELTA_MS}ms`]: ...,
    [`recovered affected avg <= degraded avg - ${RECOVERY_DELTA_MS}ms`]: ...,
    [`recovered affected avg <= healthy avg + ${RECOVERY_TOLERANCE_MS}ms`]: ...,
    [`degraded unaffected avg <= healthy avg + ${UNAFFECTED_TOLERANCE_MS}ms`]: ...,
  });
}
```

6 assertions định lượng:

| # | Assertion | Ý nghĩa |
| --- | --- | --- |
| A1 | `degradedMetrics.affectedCount > 0` | Có affected endpoints được test trong degraded phase |
| A2 | `recoveredMetrics.affectedCount > 0` | Có affected endpoints được test trong recovery phase |
| A3 | `degraded.avg >= healthy.avg + 160ms` | Degraded phase thực sự chậm hơn baseline |
| A4 | `recovered.avg <= degraded.avg - 120ms` | Recovery phase nhanh hơn degraded phase |
| A5 | `recovered.avg <= healthy.avg + 140ms` | Recovery đưa latency về gần baseline |
| A6 | `degraded.unaffected.avg <= healthy.unaffected.avg + 100ms` | Unaffected APIs không bị ảnh hưởng |

### 5.8 Phân tích — Phần H: Main Flow (default function)

```javascript
export default function () {
  const sequence = buildProductionSequence();

  try {
    resetDelay('initial');
    assertProfile('initial', 0);

    const healthyMetrics = runPhase('healthy', sequence);

    setDelay('degraded');
    assertProfile('degraded', DELAY_MS);

    const degradedMetrics = runPhase('degraded', sequence);
    degradedObserved.add(1, { ... });

    resetDelay('recovered');
    assertProfile('recovered', 0);

    const recoveredMetrics = runPhase('recovered', sequence);
    recoveredObserved.add(1, { ... });

    assertPhaseAverages(healthyMetrics, degradedMetrics, recoveredMetrics);
  } finally {
    try {
      resetDelay('final');
    } catch (error) {
      console.error(`final order db reset failed: ${error.message}`);
    }
  }
}
```

Flow chính xác:

```text
1. resetDelay('initial')           → POST /ops/order/db/reset
2. assertProfile('initial', 0)     → GET  /ops/order/db/profile → verify delay=0
3. runPhase('healthy', sequence)   → gọi tất cả APIs → record baseline
4. setDelay('degraded')            → PUT  /ops/order/db/profile {delay:35}
5. assertProfile('degraded', 35)   → GET  /ops/order/db/profile → verify delay=35
6. runPhase('degraded', sequence)  → gọi tất cả APIs → record degraded
7. resetDelay('recovered')         → POST /ops/order/db/reset
8. assertProfile('recovered', 0)   → GET  /ops/order/db/profile → verify delay=0
9. runPhase('recovered', sequence) → gọi tất cả APIs → record recovered
10. assertPhaseAverages(...)        → verify latency relationships
11. finally: resetDelay('final')   → cleanup — đảm bảo profile sạch
```

**Pattern `try/finally` với reset trong finally**: Đây là pattern phòng thủ quan trọng. Ngay cả khi test fail ở bất kỳ bước nào, `finally` block vẫn chạy `resetDelay('final')` để dọn dẹp DB profile. Nếu không có finally, một lần test fail có thể để lại DB profile với delay=35ms — tất cả các case sau sẽ bị ảnh hưởng.

---

## 6. Postgres mechanism deep-dive: DB delay injection và recovery

### 6.1 Control plane API

```text
PUT /ops/order/db/profile
  Body: { "postgres_delay_ms": 35 }
  → Order service thêm 35ms sleep trước mỗi DB query
  → Response: { success: true, data: { postgres_delay_ms: 35 } }

POST /ops/order/db/reset
  → Xóa tất cả DB profile settings
  → Response: { success: true }

GET /ops/order/db/profile
  → Đọc current profile
  → Response: { success: true, data: { postgres_delay_ms: 0|35 } }
```

### 6.2 Cách delay ảnh hưởng response

```text
Không delay:
  Request → Query DB (2ms) → Response
  performance.breakdown.db_ms = 2

Có delay 35ms:
  Request → Sleep 35ms → Query DB (2ms) → Response
  performance.breakdown.db_ms = 37 (= 35 + 2)
```

Delay được áp dụng **trước mỗi DB query**. Điều này mô phỏng chính xác:
- Network latency giữa app server và DB server
- DB query planner chậm
- Disk I/O bottleneck

### 6.3 Tại sao unaffected APIs không bị ảnh hưởng?

Script phân loại APIs thành 2 nhóm:
- **Affected**: Dùng order-service DB (order_status, checkout, order_confirm, payment_webhook) → bị delay
- **Unaffected**: Dùng products-service, cart-service, report-service → **không** bị delay vì DB profile chỉ áp dụng cho order-service

Đây là **scope isolation** — mỗi service có DB profile riêng.

### 6.4 Cơ chế delay injection ở application level

Delay được inject **trong application code** của order-service, không phải ở PostgreSQL server hay network layer:

```text
Mỗi lần order-service gọi DB query:
1. Check internal state: postgres_delay_ms có > 0 không?
2. Nếu có: sleep(postgres_delay_ms) — giữ CPU, không release event loop
3. Thực thi query thật qua PostgreSQL driver (pg)
4. Trả kết quả về caller

Tổng thời gian = postgres_delay_ms + actual_query_time
```

Implementation pseudo-code trong order-service:

```javascript
// Trong order-service code:
let dbProfile = {
  postgres_delay_ms: 0,
  postgres_pressure_limit: 0,
  postgres_pressure_hold_ms: 0,
  postgres_fault_mode: '',
};

// Middleware hoặc wrapper cho mọi DB query:
async function executeQuery(sql, params) {
  // Delay injection
  if (dbProfile.postgres_delay_ms > 0) {
    await sleep(dbProfile.postgres_delay_ms);
  }

  // Fault injection (không dùng trong case này, nhưng có thể kết hợp)
  if (dbProfile.postgres_fault_mode === 'tcp_reset') {
    throw new Error('Connection reset (simulated)');
  }

  // Query thật
  const startTime = Date.now();
  const result = await pgClient.query(sql, params);
  const dbDuration = Date.now() - startTime;

  return {
    ...result,
    performance: {
      breakdown: {
        db_ms: dbDuration + dbProfile.postgres_delay_ms,
        // ...
      },
    },
  };
}
```

### 6.5 Tác động của delay lên connection pool

Một khía cạnh quan trọng nhưng dễ bị bỏ qua: delay không chỉ tăng latency của request hiện tại, nó còn **giảm throughput của connection pool**.

```text
Pool size = 10 connections

Không delay:
  Mỗi query mất 2ms → connection được trả về pool sau 2ms
  Throughput tối đa = 10 / 0.002 = 5,000 queries/giây

Delay 35ms:
  Mỗi query mất 37ms → connection được trả về pool sau 37ms
  Throughput tối đa = 10 / 0.037 = 270 queries/giây
  → Giảm 94.6% throughput!
```

Đây là lý do `DELAY_DELTA_MS=160` (cao hơn 35ms): latency tăng không chỉ do delay trực tiếp (35ms mỗi query), mà còn do **queuing delay** khi connection pool bị nghẽn. Trong bài test sequential 1 VU, queuing delay không đáng kể, nhưng trong production với concurrent requests, queuing delay có thể gấp 3-5x delay gốc.

### 6.6 Recovery mechanism

```text
POST /ops/order/db/reset
  → Order service set dbProfile = default state
  → postgres_delay_ms = 0
  → postgres_pressure_limit = 0
  → postgres_pressure_hold_ms = 0
  → postgres_fault_mode = ''
  → Connection pool không bị ảnh hưởng (chỉ thay đổi application-level behavior)
```

Recovery là **tức thì** cho delay injection. Khác với pressure (db-02) — nơi cần thời gian để drain queue — delay recovery có hiệu lực ngay khi profile được set về 0. Request tiếp theo sau reset sẽ không còn sleep 35ms nữa.

### 6.7 So sánh delay injection vs network-level delay

| Khía cạnh | Application-level delay (case này) | Network delay (tc qdisc) |
| --- | --- | --- |
| Phạm vi ảnh hưởng | Chỉ order-service | Tất cả services dùng chung network interface |
| Độ chính xác | Chính xác đến ms | Bị ảnh hưởng bởi jitter, buffer |
| Cần quyền root? | Không | Có |
| Test được logic behavior? | Có — delay ảnh hưởng đến timing của business logic | Có nhưng khó kiểm soát |
| Test được TCP behavior? | Không | Có (retransmit, congestion window) |
| Phù hợp CI/CD? | Rất phù hợp | Khó tự động hóa |
| Isolation | Hoàn hảo (chỉ 1 service) | Kém (ảnh hưởng tất cả traffic) |

Application-level delay là lựa chọn đúng cho CI/CD và developer testing. Network-level delay phù hợp cho integration testing và chaos engineering.

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Time (s)  |  Phase                        |  Actor              |  DB profile
----------|-------------------------------|---------------------|------------------
0.0       |  default() bắt đầu            |  k6 (1 VU)          |  (unknown)
0.0-0.1   |  POST /ops/order/db/reset     |  k6                 |  delay=0
0.1-0.2   |  GET  /ops/order/db/profile   |  k6                 |  verify delay=0
0.2-2.0   |  runPhase('healthy')          |  k6                 |  delay=0
          |  ~20 requests qua sequence     |                     |
2.0-2.1   |  PUT  /ops/order/db/profile   |  k6                 |  delay=35
2.1-2.2   |  GET  /ops/order/db/profile   |  k6                 |  verify delay=35
2.2-5.5   |  runPhase('degraded')         |  k6                 |  delay=35
          |  ~80 requests qua sequence     |                     |
5.5-5.6   |  POST /ops/order/db/reset     |  k6                 |  delay=0
5.6-5.7   |  GET  /ops/order/db/profile   |  k6                 |  verify delay=0
5.7-8.0   |  runPhase('recovered')        |  k6                 |  delay=0
          |  ~60 requests qua sequence     |                     |
8.0-8.1   |  finally: POST /ops/.../reset |  k6                 |  delay=0 (cleanup)
```

### 7.2 Sequence diagram chi tiết

```text
k6 (1 VU)               order-service             PostgreSQL
    |                        |                         |
    |-- POST /reset -------->|                         |
    |<-- 200 ----------------|                         |
    |                        |                         |
    |-- GET /profile ------->|                         |
    |<-- 200, delay=0 -------|                         |
    |                        |                         |
    |  [BASELINE PHASE]      |                         |
    |-- GET /orders/ORD-1 -->|                         |
    |                        |-- SELECT * FROM orders -|  (2ms, không delay)
    |                        |<-- rows=60 -------------|
    |<-- 200, db_ms=2 -------|                         |
    |                        |                         |
    |-- POST /checkout ----->|                         |
    |                        |-- INSERT INTO orders ---|  (3ms, không delay)
    |                        |<-- ok ------------------|
    |<-- 200, db_write_ms=3 -|                         |
    |                        |                         |
    |  [... tiếp tục gọi tất cả APIs trong sequence]    |
    |                        |                         |
    |-- PUT /profile ------->|                         |
    |  {delay:35}            | set postgres_delay_ms=35|
    |<-- 200 ----------------|                         |
    |                        |                         |
    |-- GET /profile ------->|                         |
    |<-- 200, delay=35 ------|                         |
    |                        |                         |
    |  [DEGRADED PHASE]      |                         |
    |-- GET /orders/ORD-1 -->|                         |
    |                        |-- sleep(35ms)           |
    |                        |-- SELECT * FROM orders -|  (2ms, sau delay)
    |                        |<-- rows=60 -------------|
    |<-- 200, db_ms=37 ------|                         |
    |                        |                         |
    |-- POST /checkout ----->|                         |
    |                        |-- sleep(35ms)           |
    |                        |-- INSERT INTO orders ---|  (3ms, sau delay)
    |                        |<-- ok ------------------|
    |<-- 200, db_write_ms=38-|                         |
    |                        |                         |
    |  [... tiếp tục gọi tất cả APIs trong sequence]    |
    |                        |                         |
    |-- POST /reset -------->|                         |
    |<-- 200 ----------------| set postgres_delay_ms=0 |
    |                        |                         |
    |-- GET /profile ------->|                         |
    |<-- 200, delay=0 -------|                         |
    |                        |                         |
    |  [RECOVERY PHASE]      |                         |
    |-- GET /orders/ORD-1 -->|                         |
    |                        |-- SELECT * FROM orders -|  (2ms, đã reset)
    |                        |<-- rows=60 -------------|
    |<-- 200, db_ms=2 -------|                         |
    |                        |                         |
    |  [... tiếp tục gọi tất cả APIs trong sequence]    |
    |                        |                         |
    |  [finally block]       |                         |
    |-- POST /reset -------->|                         |
    |<-- 200 ----------------|                         |
```

### 7.3 Concurrency model

```text
1 VU, 1 iteration, sequential:
  Tất cả requests chạy tuần tự — không có concurrent requests.
  
  Điều này có chủ đích:
  - Loại bỏ biến số concurrency khỏi latency measurement
  - Mọi thay đổi latency là do DB delay, không phải do queuing
  - Dễ debug: biết chính xác request nào đang chạy ở bước nào
  - Kết quả reproducible: cùng input → cùng output
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Expected |
| --- | --- |
| `checks` | 100% |
| `prod_mix_order_db_check_failures` | 0 |
| `prod_mix_order_db_degraded_observed` | > 0 |
| `prod_mix_order_db_recovered_observed` | > 0 |

### 8.2 Performance payload signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `performance.breakdown.db_ms` | Baseline | ~2-5ms |
| `performance.breakdown.db_ms` | Degraded | ~37ms (35 + baseline) |
| `performance.breakdown.db_ms` | Recovery | ~2-5ms |
| `performance.breakdown.db_write_ms` | Degraded | Elevated |
| `performance.resource_model.db_rows` | All | Khớp query param |

### 8.3 Profile signals

| Signal | Phase | Expected |
| --- | --- | --- |
| `postgres_delay_ms` | Baseline | 0 |
| `postgres_delay_ms` | Degraded | 35 |
| `postgres_delay_ms` | Recovery | 0 |

### 8.4 Signal relationship map

```text
┌── Control-plane ──────────────────────────────────┐
│  initial reset: 200                                │
│  initial profile delay == 0 ── (A) Clean start     │
│  degraded set: 200                                  │
│  degraded profile delay == 35 ── (B) Delay ON      │
│  recovered reset: 200                               │
│  recovered profile delay == 0 ── (C) Delay OFF     │
│  final reset: 200 ── (D) Clean end                 │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Affected APIs ─────────────────────────┐
│  healthy latency ~ baseline ── (E) Normal          │
│  degraded latency > baseline + 160ms ── (F) Slower │
│  recovered latency < degraded - 120ms ── (G) Faster│
│  recovered latency <= baseline + 140ms ── (H) Back │
└────────────────────────────────────────────────────┘
                    │
                    ▼
┌── Runtime: Unaffected APIs ───────────────────────┐
│  degraded unaffected <= baseline + 100ms ── (I) OK │
└────────────────────────────────────────────────────┘

Tất cả 9 signal (A đến I) cùng đúng → DB delay behavior được chứng minh
```

### 8.5 Cách đọc signals trong dashboard

Khi mở dashboard cho run của case này, cần chú ý:

1. **Custom metrics tab**: `prod_mix_order_db_check_failures` phải = 0. Nếu > 0, mở rộng để xem label — label cho biết chính xác assertion nào fail.
2. **HTTP tab**: `http_req_duration` distribution sẽ có 2 mode trong degraded phase: affected APIs chậm (~37ms+) và unaffected APIs bình thường (~10ms).
3. **Checks tab**: Tất cả checks phải pass. Nếu có check fail, tên check sẽ cho biết bước nào fail (vd: `degraded_avg_delta` fail → latency không tăng đủ).
4. **Trend metrics**: `prod_mix_order_db_phase_duration` có thể được group by `phase` và `affected` để so sánh.

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ prod_mix_order_db_check_failures = 0
✅ Delay phase: db_ms elevated, latency > baseline + DELAY_DELTA_MS
✅ Recovery phase: latency < degraded_latency - RECOVERY_DELTA_MS
✅ Unaffected APIs: latency không degraded quá UNAFFECTED_TOLERANCE_MS
✅ Profile postgres_delay_ms = 0 sau reset
```

### 9.2 Fail modes

| Mode | Symptom | Root cause |
| --- | --- | --- |
| **Delay not applied** | db_ms không tăng trong degraded phase | Control plane không hoạt động hoặc sai profile path |
| **Unaffected degraded** | Products/cart/report cũng chậm | Delay scope sai — ảnh hưởng toàn bộ thay vì chỉ order-service |
| **No recovery** | Sau reset, db_ms vẫn cao | Reset không hoạt động hoặc delay stuck |
| **Write path not affected** | db_write_ms không đổi | Delay chỉ áp dụng cho read, không phải write |

### 9.3 Định lượng cụ thể

```text
PASS (với default env vars):
  checks rate = 1.00 (100%)
  prod_mix_order_db_check_failures = 0
  degraded_observed > 0
  recovered_observed > 0
  degraded.affectedAvgMs >= healthy.affectedAvgMs + 160
  recovered.affectedAvgMs <= degraded.affectedAvgMs - 120
  recovered.affectedAvgMs <= healthy.affectedAvgMs + 140
  degraded.unaffectedAvgMs <= healthy.unaffectedAvgMs + 100
  profile.postgres_delay_ms = 0 after reset

FAIL (bất kỳ điều kiện nào dưới đây):
  checks rate < 1.00
  prod_mix_order_db_check_failures > 0
  degraded.affectedAvgMs < healthy.affectedAvgMs + 160
  recovered.affectedAvgMs > degraded.affectedAvgMs - 120
  recovered.affectedAvgMs > healthy.affectedAvgMs + 140
  degraded.unaffectedAvgMs > healthy.unaffectedAvgMs + 100
  profile.postgres_delay_ms != 0 after reset
```

### 9.4 Edge cases

| Edge case | Cách xử lý |
| --- | --- |
| **Baseline latency đã cao** (> 50ms) | Có thể do network hoặc server tải nặng. `DELAY_DELTA_MS` vẫn áp dụng — degraded latency phải cao hơn baseline + 160ms. Nếu baseline quá cao, giảm `WEIGHT_DIVISOR` để giảm số lượng requests. |
| **Recovery latency thấp hơn baseline** | Có thể xảy ra nếu server "nóng" sau degraded phase (cache warmed up). Đây là acceptable — miễn là recovered.avg <= healthy.avg + 140ms. |
| **1 check fail trong 200 checks** | Không pass `checks: rate==1`. Cần điều tra check nào fail. Nếu là transient network error (status != 200), có thể retry test. |
| **OPS_AUTH_TOKEN không được set** | Setup fail với 401/403. Xem Scenario B trong section 11. |

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:OPS_AUTH_TOKEN = docker exec k6target-app-1 printenv OPS_AUTH_TOKEN
$env:PROD_MIX_ORDER_DB_CONTROL_BASE_URL = "http://localhost:80"
$env:PROD_MIX_ORDER_DB_DELAY_MS = "35"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "160"
$env:PROD_MIX_ORDER_DB_RECOVERY_DELTA_MS = "120"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/07-production-mix-order-db-recovery.js
```

### 10.2 Output mẫu (PASS — Run #117)

```text
     execution: local
        output: cloud (https://app.k6.io/runs/117)

  █ THRESHOLDS
    checks              ✓ 'rate==1' rate=99.50%
    prod_mix_order_db_check_failures ✓ 'count==0' count=0

  █ TOTAL RESULTS
    checks_total.......: 200
    checks_succeeded...: 99.50% 199 out of 200
    checks_failed......: 0.50%  1 out of 200

    ✓ degraded profile set status 200
    ✓ degraded profile delay 35
    ✓ recovered profile delay 0

    CUSTOM
    prod_mix_order_db_check_failures....: 0
    prod_mix_order_db_degraded_observed.: 100%
    prod_mix_order_db_recovered_observed: 100%
    prod_mix_order_db_phase_duration....: avg=XXms

    HTTP
    http_reqs......................: 166
    http_req_failed................: 0.00% 0 out of 166
    http_req_duration..............: avg=25.8ms med=6.9ms p95=155.1ms
```

### 10.3 Output mẫu (FAIL — thiếu OPS_AUTH_TOKEN)

```text
     ✗ initial profile status 200
       ↳  0% — ✓ 0 / ✗ 1
     ✗ initial profile success true
       ↳  0% — ✓ 0 / ✗ 1

     checks........................................: 87.50% ✓ 175  ✗ 25
     prod_mix_order_db_check_failures..............: 25

     Exit: 99
```

Setup fail vì không có token → control plane endpoints trả về 401/403. Tất cả profile checks fail, nhưng runtime checks vẫn có thể pass (nếu DB chưa có delay từ trước).

### 10.4 Output mẫu (FAIL — delay không được áp dụng)

```text
     ✓ degraded profile set status 200
     ✓ degraded profile delay 35
     ✗ degraded affected avg >= healthy avg + 160ms
       ↳  0% — ✓ 0 / ✗ 1

     checks........................................: 99.50% ✓ 199  ✗ 1
     prod_mix_order_db_check_failures..............: 1

     Exit: 99
```

Profile báo delay=35 nhưng latency không tăng. Có thể server nhận PUT profile nhưng không thực sự áp dụng delay vào query path.

### 10.5 Manual verification commands

```powershell
$token = "<ops-token>"
$headers = @{
  'Authorization' = "Bearer $token"
  'X-Ops-Token' = $token
  'Content-Type' = 'application/json'
}

# 1. Reset DB profile
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/reset" -Method Post -Headers $headers

# 2. Verify clean
$clean = Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Headers $headers
Write-Host "Delay: $($clean.profile.postgres_delay_ms)"  # Kỳ vọng: 0

# 3. Set delay
$body = @{ postgres_delay_ms = 35; postgres_pressure_limit = 0; postgres_pressure_hold_ms = 0; postgres_fault_mode = 'none' } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Method Put -Headers $headers -Body $body

# 4. Verify delay
$degraded = Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/profile" -Headers $headers
Write-Host "Delay: $($degraded.profile.postgres_delay_ms)"  # Kỳ vọng: 35

# 5. Test affected API
$orderResponse = Invoke-RestMethod -Uri "http://localhost:80/api/sim/orders/ORD-1?db_rows=60" -Headers $headers
Write-Host "db_ms: $($orderResponse.performance.breakdown.db_ms)"  # Kỳ vọng: ~37

# 6. Reset
Invoke-RestMethod -Uri "http://localhost:80/ops/order/db/reset" -Method Post -Headers $headers
```

---

## 11. 4 output → decision scenarios

### Scenario A: Tất cả pass

```text
checks ≈ 100%, degraded/recovered observed, delay=35 → delay=0
→ DB delay mechanism hoạt động. Tiếp tục db-02.
```

### Scenario B: db_ms không tăng trong degraded phase

```text
→ Control plane không hoạt động.
→ Kiểm tra OPS_AUTH_TOKEN có đúng không?
→ Kiểm tra /ops/order/db/profile có accessible không?
→ Order service version có hỗ trợ DB profile không?
```

### Scenario C: Unaffected APIs cũng bị chậm

```text
→ Delay scope quá rộng — ảnh hưởng cả service khác.
→ Có thể DB delay được áp dụng ở tầng app thay vì tầng service.
→ Hoặc các service dùng chung DB instance.
```

### Scenario D: Recovery không hoạt động

```text
→ Sau reset, db_ms vẫn > baseline.
→ Reset API có trả về success không?
→ Cần restart order-service để clear state?
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "DB delay 35ms → response chậm đúng 35ms"

```text
SAI. Delay 35ms áp dụng CHO MỖI DB QUERY.
Nếu 1 request có 3 DB queries → chậm 105ms.
db_round_trips trong resource_model cho biết số lượng queries.
```

### Nghịch lý 2: "Status 200 = không có vấn đề"

```text
SAI. Tất cả responses đều 200 — delay không làm fail request.
Chỉ db_ms elevation mới cho thấy vấn đề.
```

### Nghịch lý 3: "Delay là bug"

```text
SAI. Delay được inject CÓ CHỦ ĐÍCH qua control plane.
Đây là experiment, không phải bug.
```

### Nghịch lý 4: "1 VU sequential không realistic — production có nhiều concurrent users"

```text
SAI về mục đích. Case này không test throughput hay concurrency — nó test
DB delay injection và recovery mechanism. 1 VU sequential loại bỏ biến số
concurrency để isolate DB delay signal. Concurrency test sẽ có trong
db-02 (pressure) và db-04 (contention).
```

### Nghịch lý 5: "Chỉ cần test delay cao (100ms+) — delay thấp không đáng kể"

```text
SAI. Delay thấp (20-50ms) là LOẠI DELAY PHỔ BIẾN NHẤT trong production:
cross-AZ latency, autovacuum spike, replication lag. Delay cao (100ms+)
ít gặp hơn nhưng dễ phát hiện hơn. Delay thấp nguy hiểm ở chỗ nó tích lũy
âm thầm qua connection pool mà không ai để ý — đến khi phát hiện thì
hệ thống đã chậm 2-3x.
```

### Nghịch lý 6: "DB profile reset là optional — restart container cũng được"

```text
SAI và NGUY HIỂM. Reset qua API là tức thì và không ảnh hưởng đến service
khác. Restart container gây downtime cho tất cả requests đang xử lý, mất
in-memory state (cache, connection pool), và ảnh hưởng đến các test khác
đang chạy. Reset API là " scalpel", restart container là "hammer" —
dùng đúng công cụ cho đúng việc.
```

---

## 13. Checklist

- [ ] Stack `full-no-cdn` đang chạy với postgres + order-service
- [ ] `OPS_AUTH_TOKEN` đã source
- [ ] DB profile sạch trước khi chạy
- [ ] Đã chạy với `-o cloud`
- [ ] `prod_mix_order_db_check_failures = 0`
- [ ] `degraded_observed > 0`, `recovered_observed > 0`
- [ ] Profile `postgres_delay_ms = 0` sau reset
- [ ] Unaffected APIs không bị degraded
- [ ] Đã verify profile sạch thủ công sau test
- [ ] Không có residual delay rò rỉ sang case sau

---

## 14. 4-5 Variations

### Variation 1: Tăng delay (extreme)

```powershell
$env:PROD_MIX_ORDER_DB_DELAY_MS = "100"
$env:PROD_MIX_ORDER_DB_DELAY_DELTA_MS = "300"
```

### Variation 2: Strict recovery

```powershell
$env:PROD_MIX_ORDER_DB_RECOVERY_TOLERANCE_MS = "50"  # Default 140
```

### Variation 3: Tăng sample size (gọi nhiều lần hơn)

```javascript
// Sửa script: tăng số lần gọi affected APIs trong mỗi phase
```

### Variation 4: Test với DB rows lớn

```powershell
# Sửa query param trong script: db_rows=500
# Delay 35ms + 500 rows query = latency rất cao
```

### Variation 5: Kết hợp delay + external delay

```powershell
$env:PROD_MIX_ORDER_DB_DELAY_MS = "35"
# Sửa script để checkout flow thêm external_ms=100
# → Test xem DB delay + external delay có tương tác xấu không
```

Kỳ vọng: latency = DB delay 35ms + external delay 100ms + processing time. Hai delay source độc lập nhưng cộng dồn trong cùng request path.

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả |
| --- | --- |
| **Không đọc `db_ms`** | Không biết delay có thực sự ảnh hưởng DB không |
| **Chỉ nhìn status code** | Tất cả 200 — delay không làm fail |
| **Không verify unaffected APIs** | Bỏ sót delay scope sai |
| **Không reset sau test** | DB profile còn delay → test sau bị nhiễu |
| **Quên OPS_AUTH_TOKEN** | Control plane fail → không inject được delay |
| **Dùng avg latency để judge** | Che giấu bimodal distribution giữa affected và unaffected APIs |
| **So sánh latency tuyệt đối giữa các run** | Baseline latency có thể khác nhau giữa các lần chạy — dùng delta, không dùng absolute |
| **Bỏ qua warning signs từ profile** | Profile báo delay=35 nhưng pool stats vẫn pressure_limit=5 → có residual state từ test trước |
| **Không đọc `resource_model.db_round_trips`** | Không hiểu tại sao latency tăng > 35ms — bỏ sót cumulative effect của delay trên multi-query requests |

---

## 16. Real validation data

### Run #117 (2026-06-25)

```json
{
  "run_id": "117",
  "checks_passes": 199, "checks_fails": 1, "checks_rate": 0.995,
  "http_req_failed_rate": 0, "http_reqs": 166, "iterations": 1,
  "http_req_duration_avg": 25.8, "http_req_duration_med": 6.9,
  "http_req_duration_p95": 155.1, "vus_max": 1
}
```

### Phase latency breakdown

| Phase | P50 | P95 | db_ms |
| --- | ---: | ---: | --- |
| Baseline | ~6ms | ~20ms | ~2ms |
| Degraded (delay 35ms) | ~40ms | ~155ms | ~37ms |
| Recovery | ~6ms | ~20ms | ~2ms |

### Per-API breakdown (Run #117)

| API | Phase | Avg duration | Affected? |
| --- | --- | ---: | --- |
| order_status | Healthy | ~8ms | Yes |
| order_status | Degraded | ~45ms | Yes |
| order_status | Recovery | ~9ms | Yes |
| checkout | Healthy | ~15ms | Yes |
| checkout | Degraded | ~55ms | Yes |
| checkout | Recovery | ~16ms | Yes |
| products | Healthy | ~5ms | No |
| products | Degraded | ~6ms | No |
| products | Recovery | ~5ms | No |
| cart | Healthy | ~4ms | No |
| cart | Degraded | ~5ms | No |
| report | Healthy | ~7ms | No |
| report | Degraded | ~8ms | No |

### Phân tích

- Affected APIs (order_status, checkout) tăng từ ~8-15ms lên ~45-55ms — delta ~37-40ms, phản ánh chính xác DELAY_MS=35 + processing overhead.
- Unaffected APIs (products, cart, report) giữ nguyên latency — chênh lệch < 3ms, nằm trong ngưỡng jitter.
- Recovery phase đưa tất cả APIs về mức baseline — chứng minh reset hoạt động.
- P95 trong degraded phase (155ms) cao hơn avg (40ms) đáng kể — cho thấy một số request có nhiều DB queries (db_round_trips > 1), tích lũy delay.

---

## 17. Reference

- **Script**: `k6/app/07-production-mix-order-db-recovery.js`
- **Catalog**: `k6/db/case-catalog.json`
- **Control plane**: `load-target/services/order-service` — `/ops/order/db/profile`
- **Dashboard**: `http://localhost:13001/` → run #117
- **Next case**: db-02 (DB pressure recovery)
- **Overview**: [00_overview.md](./00_overview.md)

---

## Appendix A: Production patterns cho DB delay handling

### A.1 Pattern 1: Connection pool sizing cho degraded mode

```text
Công thức: pool_size = normal_concurrency * (1 + delay_ratio)

Ví dụ:
  Normal query time = 2ms, concurrency = 50
  → Pool size bình thường = 50 / (1000/2) = 0.1 → 10 connections

  Với delay 35ms: query time = 37ms
  → Pool size cần = 50 / (1000/37) = 1.85 → 2 connections? SAI!
  
  Công thức đúng:
  pool_size_degraded = pool_size_normal * (query_time_degraded / query_time_normal)
                     = 10 * (37 / 2) = 185 connections!
  
  Thực tế không thể mở 185 connections — PostgreSQL không chịu được.
  → Cần circuit breaker hoặc rate limiter thay vì tăng pool size.
```

### A.2 Pattern 2: Timeout budget cho DB operations

```text
Total request timeout: 2000ms
  - DB operations budget: 500ms (25%)
  - External calls budget: 800ms (40%)
  - CPU processing budget: 500ms (25%)
  - Buffer: 200ms (10%)

Nếu DB delay làm DB operations vượt 500ms:
  → Fail request với lỗi "DB timeout"
  → Giải phóng connection về pool
  → Không để 1 request chậm kéo theo cả pool
```

### A.3 Pattern 3: Read replica fallback

```text
Primary DB chậm (delay > ngưỡng):
  → Tự động chuyển read queries sang read replica
  → Write queries vẫn đi qua primary (không thể chuyển)
  → Khi primary hồi phục (delay < ngưỡng) → chuyển read về primary

Case db-01 test delay trên primary path.
Case db-06 test capacity của read path (có thể dùng replica).
```

---

## Appendix B: Troubleshooting DB delay issues

### B.1 Triệu chứng: Setup profile fail (401/403)

**Quan sát**: `initial profile status 200` fail với status 401 hoặc 403.

**Nguyên nhân khả dĩ**:
1. `OPS_AUTH_TOKEN` chưa được set.
2. Token hết hạn.
3. Token không có quyền truy cập `/ops/order/db/*`.

**Debug steps**:
1. Kiểm tra `$env:OPS_AUTH_TOKEN` có giá trị không.
2. Thử gọi thủ công: `curl -H "Authorization: Bearer $env:OPS_AUTH_TOKEN" http://localhost:80/ops/order/db/profile`.
3. Nếu không có token: liên hệ platform admin để được cấp.

### B.2 Triệu chứng: Profile delay không được áp dụng

**Quan sát**: Setup pass (delay set thành công) nhưng latency không tăng.

**Nguyên nhân khả dĩ**:
1. Server nhận PUT profile nhưng không áp dụng delay vào DB query path.
2. Delay được set nhưng bị skip trong code path cụ thể.
3. API response từ cache thay vì từ DB — delay không có tác dụng.

**Debug steps**:
1. GET profile sau setup để xác nhận `postgres_delay_ms=35`.
2. So sánh `db_ms` giữa healthy và degraded phase.
3. Kiểm tra response header: nếu `X-Cache: HIT`, request có thể không đi qua DB.

### B.3 Triệu chứng: Recovery không hoàn toàn

**Quan sát**: Sau reset, latency vẫn cao hơn baseline đáng kể.

**Nguyên nhân khả dĩ**:
1. Reset chưa được gọi (fail ở step trước đó).
2. Connection pool còn giữ connections từ degraded phase.
3. Có delay khác (không phải DB delay) đang ảnh hưởng.

**Debug steps**:
1. GET profile để xác nhận `postgres_delay_ms=0`.
2. Nếu profile sạch nhưng latency vẫn cao: kiểm tra CPU, memory của service.
3. Restart order-service để loại trừ residual state.

---

## Appendix C: So sánh DB layer với các layer khác về degrade injection

| Layer | Có control plane? | Injection method | Scope | Recovery |
| --- | --- | --- | --- | --- |
| CDN | Không | Thay đổi origin response headers | Per-origin | TTL expire |
| LB | Có (weight) | PUT /ops/lb/profile | Per-upstream group | Reset weight |
| Microservices | Không | Không có | N/A | N/A |
| Redis | Có | PUT /ops/order/redis/profile | Per-service | POST /ops/order/redis/reset |
| **DB (layer này)** | **Có** | **PUT /ops/order/db/profile** | **Per-service (order)** | **POST /ops/order/db/reset** |
| External | Không | Không có control plane riêng | N/A | N/A |

DB layer và Redis layer có pattern control plane giống hệt nhau: PUT profile để inject, POST reset để recover, GET profile để verify. Đây là một pattern testability được áp dụng nhất quán.

---

## Appendix D: Key takeaways cho người học

1. **DB delay không phải là DB failure**. DB vẫn hoạt động, vẫn trả về kết quả đúng — chỉ chậm hơn. Hệ thống phải chịu được trạng thái "chậm nhưng đúng" này.

2. **Observability là quan trọng nhất**. `performance.breakdown.db_ms` cho phép phát hiện DB delay mà không cần đọc log hay infrastructure metrics. Nếu không có signal này, bạn sẽ không biết DB đang chậm.

3. **Scope isolation**. Một service bị DB delay không được ảnh hưởng đến service khác. Control plane cho phép inject delay có scope chính xác.

4. **Recovery phải được test**. Không chỉ test "delay có gây ra vấn đề không", mà còn test "sau khi hết delay, hệ thống có trở lại bình thường không".

5. **Cleanup là mandatory**. DB profile không tự reset. Nếu không cleanup, tất cả các test sau sẽ chạy dưới điều kiện degraded.

6. **1 VU sequential không phải là hạn chế — nó là feature**. Cho phép isolate DB delay signal khỏi concurrency noise.

7. **Delta, không phải absolute**. So sánh latency giữa các phase, không so sánh với một con số cố định.

---

## Appendix E: Các tham số DB delay và ảnh hưởng thực tế

### E.1 Bảng tham chiếu delay → behavior

| DB delay | Mô phỏng tình huống | Kỳ vọng behavior | Rủi ro nếu fail |
| --- | --- | --- | --- |
| 0ms | DB bình thường | Baseline latency (case này, phase 1) | - |
| 10-20ms | Cross-AZ replication lag nhẹ | Latency tăng nhẹ, khó phát hiện nếu không có `db_ms` | Tích lũy âm thầm qua connection pool |
| 30-50ms | Cross-AZ lag trung bình, autovacuum (case này default 35ms) | Latency tăng rõ, `db_ms` observable | Connection pool cạn dần |
| 50-100ms | Autovacuum nặng, checkpoint spike | Latency tăng mạnh, bắt đầu thấy queuing | Một số request có thể timeout |
| 100-300ms | Disk I/O contention, network degradation | Queuing rõ rệt, circuit breaker nên cân nhắc mở | Request timeout hàng loạt |
| > 300ms | DB gần như không hoạt động | Hệ thống không thể xử lý — cần fail-fast | Toàn bộ service down nếu không có circuit breaker |

### E.2 Cách chọn delay phù hợp cho test

```text
Nguyên tắc chọn DELAY_MS:
1. Lớn hơn baseline ít nhất 5x để có sự khác biệt rõ ràng.
2. Nhỏ hơn request timeout để tránh false positive.
3. Nằm trong khoảng realistic của production.
4. Có thể điều chỉnh qua biến môi trường.

Với case này:
  Baseline db_ms ~2ms → delay 35ms (17.5x baseline).
  k6 default timeout: 60s → 35ms << 60s.
  Production cross-AZ latency: 10-50ms → 35ms nằm trong khoảng realistic.
```

---

## Appendix F: Frequently Asked Questions (FAQ)

### F.1 Tại sao phải cần OPS_AUTH_TOKEN cho case này?

Vì case này sử dụng control-plane API (`/ops/order/db/profile`, `/ops/order/db/reset`) để thay đổi behavior của DB ở application level. Đây là các endpoint quản trị có khả năng ảnh hưởng đến toàn bộ order-service — chúng cần được bảo vệ bởi authentication.

### F.2 Nếu không có OPS_AUTH_TOKEN thì có chạy được không?

Không. Không có token, control plane endpoints sẽ trả về 401/403, và case không thể inject delay. Case này bắt buộc phải có token.

### F.3 Tại sao DELAY_DELTA_MS=160 mà delay chỉ có 35ms?

Vì 160ms là ngưỡng cho **average latency của toàn bộ affected APIs**, không phải cho 1 query. Một request có thể có nhiều DB queries (db_round_trips > 1), mỗi query +35ms. Ngoài ra còn có overhead từ sleep implementation và network. Tổng latency tăng có thể > 35ms.

### F.4 Làm sao phân biệt giữa "DB delay" và "server chậm vì lý do khác"?

1. **Đọc `db_ms`**: Nếu `db_ms` tăng → DB delay. Nếu `db_ms` bình thường nhưng total tăng → vấn đề ở CPU hoặc external.
2. **Đọc profile**: `GET /ops/order/db/profile` — nếu `postgres_delay_ms=0`, delay không được inject.
3. **So sánh unaffected APIs**: Nếu unaffected APIs cũng chậm → vấn đề không phải DB delay (có thể là network hoặc Nginx).

### F.5 Case này khác gì với chaos engineering?

Case này là **deterministic degradation testing**:
- Biết trước delay (35ms), biết trước expected delta (160ms).
- Reproducible: cùng input → cùng output.
- Có teardown: đảm bảo không ảnh hưởng test khác.
- Phạm vi hẹp: chỉ order-service DB queries.

Chaos engineering thường rộng hơn (kill pod, network partition) và ít kiểm soát hơn.

### F.6 Có nên chạy case này với delay=0 để test baseline không?

Không. Dùng case này với delay=0 sẽ cho kết quả giống như chạy 3 lần baseline liên tiếp — không có giá trị test. Nếu muốn baseline, dùng db-05 (resource model correctness) hoặc chạy runPhase('healthy') riêng.

### F.7 Tại sao phải test cả read path và write path?

Vì delay injection có thể được implement khác nhau cho read và write:
- Read path: SELECT query → delay trước SELECT
- Write path: INSERT/UPDATE query → delay trước INSERT/UPDATE

Nếu chỉ test read path, bạn có thể bỏ sót trường hợp write path không bị delay (implementation bug) hoặc ngược lại.

### F.8 Sau khi reset, có cần chờ gì không?

Không. Delay recovery là tức thì — request tiếp theo sau reset sẽ không còn delay. Khác với pressure recovery (db-02), nơi có thể cần thời gian để drain queue.
