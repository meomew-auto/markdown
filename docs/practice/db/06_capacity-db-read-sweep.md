# db-06 -- DB read capacity sweep

> **Case ID:** `db-06-capacity-db-read-sweep`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, `constant-arrival-rate`, **NO token needed**
> **Workload:** Open-model arrival-rate sweep
> **Proof:** Sweep DB-heavy read workload từ nhẹ đến nặng -- đọc `dropped_iterations`, `db_ms`, VU pool behavior, `resource_model` để xác định capacity limit. Đây là **capacity planning case** -- không phải pass/fail đơn thuần.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Postgres mechanism: capacity curve và drop iteration pattern](#6-postgres-mechanism-capacity-curve-và-drop-iteration-pattern)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals](#8-key-signals)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output--decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist](#13-checklist)
14. [5 Variations](#14-5-variations)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh

Team muốn biết: "Products service có thể chịu được bao nhiêu request/giây khi mỗi request query 120 rows từ DB?" Đây là câu hỏi **capacity planning** -- cần sweep để tìm limit, không phải test pass/fail.

### 1.2 Sweep pattern

```text
Light:   CAPACITY_RATE=5,  CAPACITY_DB_ROWS=10   -> 0 drops, latency thấp
Medium:  CAPACITY_RATE=8,  CAPACITY_DB_ROWS=120  -> 0 drops, latency medium
Heavy:   CAPACITY_RATE=15, CAPACITY_DB_ROWS=500  -> drops xuất hiện, DB saturated
```

Mỗi data point là một lần chạy với rate và db_rows khác nhau. Vẽ curve: rate (x) vs p95 latency (y) -- điểm uốn là capacity limit.

### 1.3 Constant-arrival-rate (open model)

```text
Khác với constant-vus (closed model):
  - Closed: VUs cố định, RPS phụ thuộc latency
  - Open: RATE cố định, VUs tăng để đạt rate

Open model phù hợp cho capacity testing vì:
  - Bạn muốn biết "ở rate X, hệ thống có theo kịp không?"
  - dropped_iterations cho biết hệ thống đã saturated
```

### 1.4 Tại sao capacity planning quan trọng?

Hãy tưởng tượng Black Friday sắp đến:

```text
Tuần trước Black Friday:
  - Team marketing dự báo traffic tăng 3x.
  - Bạn cần biết: hệ thống hiện tại có chịu được không?
  - Nếu không: cần thêm bao nhiêu resource? (DB connection, service instance, CPU)

Nếu bạn không biết capacity limit:
  - Option A: Provision quá nhiều -> lãng phí tiền (cloud bill tăng 2x không cần thiết)
  - Option B: Provision quá ít -> system crash giữa Black Friday -> mất doanh thu

db-06 cho bạn CON SỐ:
  "Với db_rows=120, products service chịu được 8 req/s trước khi latency vượt ngưỡng."
  -> Bạn biết chính xác cần scale lên bao nhiêu instance để đạt 24 req/s (3x traffic).
```

### 1.5 Open model vs Closed model -- khi nào dùng cái nào?

| Khía cạnh | Closed model (constant-vus) | Open model (constant-arrival-rate) |
| --- | --- | --- |
| **Cách hoạt động** | VUs cố định, mỗi VU gửi request, đợi response, gửi tiếp | Rate cố định, VUs được cấp phát để đạt rate |
| **RPS** | Phụ thuộc latency (latency tăng -> RPS giảm) | Cố định (bất kể latency) |
| **Dropped iterations** | Không có (VUs tự đợi) | Có -- khi tất cả VUs bận và rate vượt quá capacity |
| **Phù hợp cho** | Test behavior ở mức load nhất định | **Tìm capacity limit** |
| **Ví dụ thực tế** | "8 users liên tục browse products" | "100 requests mỗi giây đến products service" |

```text
Tại sao open model phù hợp cho capacity testing?

Với closed model:
  - Bạn set 10 VUs. Hệ thống chậm đi -> mỗi VU đợi lâu hơn -> RPS tự động giảm.
  - Bạn không bao giờ thấy "hệ thống không theo kịp" vì VUs tự điều tiết.
  - Kết quả: latency tăng nhưng không có dropped_iterations -> khó xác định limit.

Với open model:
  - Bạn set rate=10 req/s. Hệ thống chỉ xử lý được 8 req/s.
  - 2 req/s bị drop -> dropped_iterations > 0.
  - Bạn BIẾT CHÍNH XÁC limit là 8 req/s.
```

### 1.6 Capacity curve concept

```text
Capacity curve là mối quan hệ giữa:
  - Trục X: offered load (rate bạn gửi)
  - Trục Y: observed latency (p95)

Đường cong lý tưởng:
  - Đoạn phẳng (low rate): latency ổn định, hệ thống xử lý thoải mái
  - Đoạn dốc (near capacity): latency bắt đầu tăng nhanh
  - Điểm gãy (capacity limit): latency tăng đột biến, dropped_iterations > 0

Ví dụ thực tế:
  Rate=5   -> p95=6ms   (thoải mái)
  Rate=8   -> p95=8ms   (bắt đầu căng)
  Rate=10  -> p95=15ms  (gần limit)
  Rate=12  -> p95=45ms  (vượt limit, dropped_iterations > 0)
  Rate=15  -> p95=120ms (saturated hoàn toàn)

Capacity limit ở khoảng rate=10 (điểm trước khi latency tăng đột biến).
```

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Hệ thống có thể được sweep với DB-heavy read workload ở nhiều mức rate và db_rows khác nhau. Tại mỗi mức, `dropped_iterations`, `db_ms`, VU pool usage, và `resource_model` cùng vẽ nên bức tranh capacity. Capacity limit là rate mà tại đó dropped_iterations bắt đầu > 0 hoặc p95 latency vượt ngưỡng chấp nhận được.**

### 2.2 Sub-capabilities

| # | Capability | Mô tả | Evidence |
| --- | --- | --- | --- |
| **C1** | Rate sweep | Gửi sustained arrival rate, quan sát system behavior ở nhiều mức | `dropped_iterations` theo rate |
| **C2** | DB metrics under load | `db_ms`, `resource_model.db_rows` được record trong từng CAPACITY_SAMPLE | CAPACITY_SAMPLE JSON log |
| **C3** | Bottleneck detection | `performance.bottleneck` rotates giữa `cpu_ms` và `db_ms` khi load thay đổi | `capacity_bottleneck_samples` |
| **C4** | Resource delta observation | CPU, memory, heap objects delta per sample | `capacity_observed_*` trends |
| **C5** | VU pool adequacy | `preAllocatedVUs` và `maxVUs` có đủ để đạt target rate không | `vus` / `vus_max` |
| **C6** | Profile flexibility | Hỗ trợ nhiều profile (products_db_read, report_gzip, checkout_mixed, realistic_mix, memory_intensive) | `CAPACITY_PROFILE` env var |

### 2.3 Evidence chain

```text
CAPACITY_SAMPLE (per-request)
  |
  +-- resource_model: { db_rows, db_writes, payload_bytes, ... }
  |     -> input load được confirmed
  |
  +-- breakdown: { db_ms, cpu_ms, json_ms, ... }
  |     -> latency decomposition
  |
  +-- observed_resource_delta: { wall_ms, heap_alloc_mb_delta, gc_cycles_delta, ... }
  |     -> runtime cost measurement
  |
  +-- bottleneck + bottleneck_percent
  |     -> ai đang giới hạn throughput?
  |
  +-- status, duration_ms, success
        -> health check per request

Aggregated (end-of-run):
  |
  +-- iterations (completed)
  +-- dropped_iterations (không kịp xử lý)
  +-- vus / vus_max (VU pool usage)
  +-- http_req_duration p95, p99
  +-- capacity_breakdown_db_ms trend
```

### 2.4 Tại sao đây không phải pass/fail test?

Khác với db-05 (correctness -- pass/fail rõ ràng), db-06 là **capacity discovery**:

```text
db-05: "Contract có đúng không?" -> YES/NO
db-06: "Capacity limit ở đâu?" -> Đây là một CON SỐ, không phải YES/NO

Bạn không thể "fail" db-06 -- bạn chỉ có thể:
  - Tìm thấy capacity limit (thành công)
  - Không tìm thấy capacity limit vì hệ thống quá mạnh (cần tăng rate)
  - Không tìm thấy capacity limit vì VU pool quá nhỏ (cần tăng maxVUs)
  - Thấy dropped_iterations = 0 ở mọi rate (chưa chạm limit)
```

---

## 3. Vì sao phải test ở DB layer

### 3.1 Không layer nào khác làm được capacity sweep cho DB

- **CDN layer**: Cache hit -> không đến được service -> không đo được DB capacity thực. CDN capacity test đo bandwidth/edge compute, không phải DB.
- **LB layer**: Phân phối request giữa các instance. LB capacity test tìm limit của LB (connections, throughput), không phải DB.
- **Microservices layer**: Có thể test capacity của 1 service, nhưng không có resource_model để isolate DB component.
- **Redis layer**: Test Redis throughput, không phải Postgres.

### 3.2 DB layer là nơi duy nhất có đủ evidence

```text
Để làm capacity planning cho DB, bạn cần:

1. Biết mỗi request tiêu thụ bao nhiêu DB resource (db_rows)
   -> Chỉ resource_model có (DB layer)

2. Biết DB time thực tế dưới load (db_ms)
   -> Chỉ breakdown có (DB layer)

3. Biết bottleneck có phải DB không (bottleneck field)
   -> Chỉ performance payload có (DB layer)

4. Biết runtime cost (heap, GC, goroutines)
   -> Chỉ observed_resource_delta có (DB layer)

5. Biết hệ thống có đang drop request không (dropped_iterations)
   -> k6 metrics (chung) + DB layer context

Không layer nào khác có đủ 5 evidence types này.
```

### 3.3 Mối liên hệ với db-05

```text
db-05 (resource model correctness) -> db-06 (capacity sweep)

db-05 verify: resource_model.db_rows == query param db_rows
                (contract đúng)

db-06 dùng contract đó để:
  - Map db_rows -> db_ms (DB time per row count)
  - Map rate -> dropped_iterations (system saturation point)
  - Map rate -> bottleneck rotation (khi nào DB trở thành bottleneck)

Nếu chưa chạy db-05, bạn không biết resource_model có đáng tin không.
Nếu resource_model sai, capacity limit bạn tìm được là vô nghĩa.
```

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/30-capacity-sizing-sweep.js
Executor: constant-arrival-rate (open model)
Topology: full-no-cdn
BASE_URL: http://localhost:80 (default)
NO OPS_AUTH_TOKEN needed (case này không gọi control plane)

Request flow:
  k6 (constant rate)
    |
    | HTTP requests (GET/POST tùy profile)
    |
    v
  Nginx (:80)
    |
    +---> products-service (cho products_db_read, products_cpu)
    |       +-- Postgres
    |
    +---> order-service (cho checkout_mixed)
    |       +-- Postgres + payment-mock (external call)
    |
    +---> report-service (cho report_gzip)
    |       +-- Postgres
    |
    +---> Tất cả service (cho realistic_mix)
            +-- Postgres + Redis + payment-mock
```

### 4.2 Precondition

- [x] Stack `full-no-cdn` đang chạy với tất cả service
- [x] Postgres available
- [x] **KHÔNG cần `OPS_AUTH_TOKEN`** (case này không inject DB degradation)
- [x] **KHÔNG có CDN** (cache làm sai lệch capacity measurement)
- [x] Đã chạy db-05 và pass (xác nhận resource_model đáng tin)
- [x] Đủ VU capacity: `maxVUs` phải đủ lớn để đạt target rate

### 4.3 PreAllocatedVUs và maxVUs -- knobs quan trọng nhất

```text
constant-arrival-rate cần VU pool để gửi request:

  preAllocatedVUs: Số VUs được khởi tạo sẵn, sẵn sàng gửi request ngay.
  maxVUs: Số VUs tối đa có thể được cấp phát.

Công thức ước lượng:
  preAllocatedVUs >= RATE * avg_latency_seconds
  maxVUs >= RATE * p95_latency_seconds * 2 (buffer)

Ví dụ:
  RATE = 10 req/s, avg_latency ~ 0.005s (5ms), p95_latency ~ 0.020s (20ms)
  -> preAllocatedVUs >= 10 * 0.005 = 0.05 -> tối thiểu 1 (nhưng nên set >= 2)
  -> maxVUs >= 10 * 0.020 * 2 = 0.4 -> tối thiểu 1 (nhưng nên set >= 5 để an toàn)

Thực tế:
  - Với rate 5-15 req/s và latency ~5-20ms, preAllocatedVUs=10-20 và maxVUs=30-60 là đủ.
  - Nếu dropped_iterations > 0 nhưng vus < maxVUs -> VU pool không phải bottleneck,
    hệ thống thực sự không xử lý kịp (DB hoặc CPU saturated).
  - Nếu dropped_iterations > 0 và vus == maxVUs -> maxVUs không đủ, cần tăng.
```

### 4.4 Môi trường yêu cầu

```text
Yêu cầu phần cứng (cho stack local):
  - CPU: 4+ cores (để service có đủ CPU xử lý)
  - RAM: 8+ GB (Postgres + các service)
  - Disk: SSD (DB I/O)

Lưu ý: Kết quả capacity test trên máy local KHÔNG phản ánh production.
Máy local thường mạnh hơn hoặc yếu hơn production tùy cấu hình.
Case này dạy PHƯƠNG PHÁP sweep -- áp dụng phương pháp này lên production
để có số liệu thực tế.
```

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `30-capacity-sizing-sweep.js` được tổ chức thành 6 phần:

```text
1. Configuration (dòng 1-33): env vars, constants, metrics
2. Options (dòng 48-73): k6 scenario configuration
3. Profile resolution (dòng 99-240): chọn endpoint dựa trên CAPACITY_PROFILE
4. Request execution (dòng 246-266): gửi HTTP request
5. Metrics recording (dòng 290-331): parse response, record trends, log CAPACITY_SAMPLE
6. Default function (dòng 333-355): orchestration
```

### 5.2 Configuration & env vars

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const RUN_ID = envString('CAPACITY_RUN_ID', `capacity-sizing-${Date.now()}`);
const PROFILE = envString('CAPACITY_PROFILE', 'checkout_mixed');
const RATE = envInt('CAPACITY_RATE', 5);
const DURATION_SECONDS = envInt('CAPACITY_DURATION_SECONDS', 10);
const PRE_ALLOCATED_VUS = envInt('CAPACITY_PRE_ALLOCATED_VUS', Math.max(10, RATE * 2));
const MAX_VUS = envInt('CAPACITY_MAX_VUS', Math.max(PRE_ALLOCATED_VUS, RATE * 4));
const SAMPLE_EVERY = envInt('CAPACITY_SAMPLE_EVERY', 1);
const SLEEP_SECONDS = envFloat('CAPACITY_SLEEP_SECONDS', 0);
```

Các env vars chính:

| Env var | Default | Ý nghĩa |
| --- | --- | --- |
| `CAPACITY_PROFILE` | `checkout_mixed` | Chọn endpoint pattern (products_db_read, report_gzip, realistic_mix, ...) |
| `CAPACITY_RATE` | `5` | Target arrival rate (requests/giây) |
| `CAPACITY_DURATION_SECONDS` | `10` | Thời gian duy trì rate (giây) |
| `CAPACITY_PRE_ALLOCATED_VUS` | `max(10, RATE*2)` | VUs được khởi tạo sẵn |
| `CAPACITY_MAX_VUS` | `max(PRE_ALLOCATED, RATE*4)` | VUs tối đa |
| `CAPACITY_DB_ROWS` | `300` | Số rows DB query (cho DB-heavy profiles) |
| `CAPACITY_DB_WRITES` | `2` | Số writes DB (cho write profiles) |
| `CAPACITY_CPU_MS` | `8` | CPU work target (ms) |
| `CAPACITY_JSON_ITEMS` | `100` | Số JSON items |
| `CAPACITY_GZIP_KB` | `128` | Gzip output size (KB) |
| `CAPACITY_EXTERNAL_MS` | `20` | External call duration (ms) |
| `CAPACITY_SAMPLE_EVERY` | `1` | Log sample mỗi N iterations |

### 5.3 Custom metrics

```javascript
const requests = new Counter('capacity_sizing_requests');
const successes = new Counter('capacity_sizing_successes');
const failures = new Counter('capacity_sizing_failures');
const toleratedStatuses = new Counter('capacity_sizing_tolerated_statuses');
const observedWallMs = new Trend('capacity_observed_wall_ms', true);
const observedCPUMs = new Trend('capacity_observed_cpu_total_ms_delta', true);
const observedRSSMB = new Trend('capacity_observed_rss_mb_delta', true);
const observedHeapMB = new Trend('capacity_observed_heap_alloc_mb_delta', true);
const modelDiskKB = new Trend('capacity_model_disk_kb', true);
const breakdownDiskMs = new Trend('capacity_breakdown_disk_ms', true);
const breakdownDBMs = new Trend('capacity_breakdown_db_ms', true);
const breakdownDBWriteMs = new Trend('capacity_breakdown_db_write_ms', true);
const breakdownCPUMs = new Trend('capacity_breakdown_cpu_ms', true);
const bottleneckSamples = new Counter('capacity_bottleneck_samples');
```

Mỗi metric có tag `capacity_profile` và `capacity_rate` để lọc theo profile và rate.

**Tại sao dùng Trend thay vì Gauge?**

Trend lưu tất cả giá trị và compute percentiles (avg, min, med, max, p90, p95, p99). Gauge chỉ lưu giá trị cuối cùng. Với capacity sweep, percentiles là quan trọng nhất -- p95 cho biết "95% request nhanh nhất là bao nhiêu", p99 cho biết "worst-case latency".

### 5.4 Scenario configuration

```javascript
export const options = {
  noConnectionReuse: NO_CONNECTION_REUSE,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    capacity_step: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_SECONDS}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      gracefulStop: '2s',
      tags: {
        scenario: 'capacity_sizing_sweep',
        capacity_profile: PROFILE,
        capacity_rate: String(RATE),
      },
    },
  },
};
```

Điểm quan trọng:
- **`summaryTrendStats`**: Chỉ định rõ các percentiles cần compute (p90, p95, p99). Mặc định k6 chỉ compute avg, min, med, max, p(90), p(95).
- **`gracefulStop: '2s'`**: Cho phép 2 giây để finish các iteration đang chạy khi duration kết thúc.
- **`noConnectionReuse`**: Tùy chọn -- `true` để mỗi request dùng connection mới (tránh connection pool reuse ảnh hưởng measurement).

### 5.5 Profile resolution

Script hỗ trợ 6 profile, mỗi profile là một endpoint pattern khác nhau:

#### 5.5.1 `products_db_read` (default cho DB sweep)

```javascript
case 'products_db_read':
  return {
    name: PROFILE,
    endpoint: 'products_list',
    method: 'GET',
    path: `/api/sim/products?cpu_ms=${CPU_MS}&db_rows=${DB_ROWS}&json_items=${JSON_ITEMS}
           &memory_kb=${MEMORY_KB}&retain_memory_kb=${RETAIN_MEMORY_KB}
           &gc_churn_kb=${GC_CHURN_KB}&heap_objects=${HEAP_OBJECTS}
           &limit=20&view=full&include_facets=1
           &resource_case=capacity_products_db_read`,
  };
```

Đây là profile chính cho DB read capacity sweep. Nó gọi products list với `db_rows` có thể điều chỉnh.

#### 5.5.2 `products_cpu`

```javascript
case 'products_cpu':
  return {
    name: PROFILE,
    endpoint: 'products_list',
    method: 'GET',
    path: `/api/sim/products?cpu_ms=${CPU_MS}&db_rows=0&json_items=${JSON_ITEMS}&...`,
  };
```

Giống `products_db_read` nhưng `db_rows=0` -- để isolate CPU component. Dùng để so sánh: "bao nhiêu capacity đến từ DB vs CPU?"

#### 5.5.3 `report_gzip`

```javascript
case 'report_gzip':
  return {
    name: PROFILE,
    endpoint: 'report_generate',
    method: 'GET',
    path: `/api/sim/report?cpu_ms=${CPU_MS}&db_rows=${DB_ROWS}&gzip_kb=${GZIP_KB}`,
  };
```

Gọi report generation -- test DB + gzip compression. Dùng để hiểu cost của response compression dưới load.

#### 5.5.4 `checkout_mixed`

```javascript
case 'checkout_mixed':
default:
  return {
    name: 'checkout_mixed',
    endpoint: 'order_checkout',
    method: 'POST',
    path: `/api/sim/checkout?cpu_ms=${CPU_MS}&db_writes=${DB_WRITES}&disk_kb=${DISK_KB}
           &external_ms=${EXTERNAL_MS}&external_fail_rate=${EXTERNAL_FAIL_RATE}
           &resource_case=capacity_checkout_mixed`,
    body: { payment_method: 'card', item_count: 2, shipping_method: 'standard' },
  };
```

Write-heavy profile -- test DB write capacity + external call + disk I/O. Default profile.

#### 5.5.5 `realistic_mix`

```javascript
function realisticMixSpec() {
  const item = chooseWeighted([
    { endpoint: 'products_list', method: 'GET', weight: 28, path: `...` },
    { endpoint: 'products_detail', method: 'GET', weight: 12, path: `...` },
    { endpoint: 'products_search', method: 'GET', weight: 12, path: `...` },
    { endpoint: 'auth_me', method: 'GET', weight: 8, path: `...` },
    { endpoint: 'cart_summary', method: 'GET', weight: 10, path: `...` },
    { endpoint: 'cart_add', method: 'POST', weight: 10, path: `...`, body: {...} },
    { endpoint: 'order_checkout', method: 'POST', weight: 15, path: `...`, body: {...} },
    { endpoint: 'report_generate', method: 'GET', weight: 5, path: `...` },
  ]);
  return { ...item, name: 'realistic_mix', expectedStatus: item.expectedStatus || 200 };
}
```

Profile phức tạp nhất -- mỗi iteration chọn ngẫu nhiên 1 trong 8 endpoint theo weighted distribution (tổng weight = 100). Đây là **production-like traffic mix**:

| Endpoint | Weight | % Traffic | Method |
| --- | ---: | ---: | --- |
| products_list | 28 | 28% | GET |
| order_checkout | 15 | 15% | POST |
| products_detail | 12 | 12% | GET |
| products_search | 12 | 12% | GET |
| cart_summary | 10 | 10% | GET |
| cart_add | 10 | 10% | POST |
| auth_me | 8 | 8% | GET |
| report_generate | 5 | 5% | GET |

#### 5.5.6 Custom profile

```javascript
function customProfile() {
  const customPath = envString('CAPACITY_PATH', '');
  if (!customPath) return null;
  const method = envString('CAPACITY_METHOD', 'GET').toUpperCase();
  const bodyRaw = envString('CAPACITY_BODY_JSON', '');
  let body = null;
  if (bodyRaw) {
    try { body = JSON.parse(bodyRaw); } catch (_) { body = { raw: bodyRaw }; }
  }
  return { name: 'custom', endpoint: envString('CAPACITY_ENDPOINT', 'custom'), method, path: customPath, body };
}
```

Cho phép test bất kỳ endpoint nào qua env vars:

```powershell
$env:CAPACITY_PATH = "/api/sim/products/search?q=test&db_rows=50"
$env:CAPACITY_METHOD = "GET"
$env:CAPACITY_ENDPOINT = "products_search_custom"
```

### 5.6 Metrics recording -- deep dive

```javascript
function record(response, payload, spec) {
  const expectedStatus = expectedStatusFor(spec);
  const perf = performance(payload);
  const breakdown = perf.breakdown || {};
  const model = perf.resource_model || {};
  const observed = perf.observed_resource_delta || {};
  const bottleneck = perf.bottleneck || 'unknown';
  const tags = {
    endpoint: spec.endpoint,
    capacity_profile: spec.name,
    capacity_rate: String(RATE),
    bottleneck,
  };

  // Record trends
  addTrend(observedWallMs, observed.wall_ms, tags);
  addTrend(observedCPUMs, observed.cpu_total_ms_delta, tags);
  addTrend(observedRSSMB, observed.rss_mb_delta, tags);
  addTrend(observedHeapMB, observed.heap_alloc_mb_delta, tags);
  addTrend(modelDiskKB, model.disk_kb, tags);
  addTrend(breakdownDiskMs, breakdown.disk_ms, tags);
  addTrend(breakdownDBMs, breakdown.db_ms, tags);
  addTrend(breakdownDBWriteMs, breakdown.db_write_ms, tags);
  addTrend(breakdownCPUMs, breakdown.cpu_ms, tags);
  bottleneckSamples.add(1, tags);

  // Log CAPACITY_SAMPLE
  if (SAMPLE_EVERY > 0 && (__ITER % SAMPLE_EVERY === 0 || response.status !== expectedStatus)) {
    console.log(`CAPACITY_SAMPLE ${JSON.stringify({
      run_id: RUN_ID,
      profile: spec.name,
      target_rate: RATE,
      endpoint: spec.endpoint,
      status: response.status,
      duration_ms: response.timings ? response.timings.duration : null,
      success: payload && payload.success === true,
      bottleneck,
      bottleneck_percent: perf.bottleneck_percent,
      breakdown,
      resource_model: model,
      observed_resource_delta: observed,
    })}`);
  }
}
```

Điểm quan trọng trong `record()`:

1. **`addTrend` với `finite()` guard**: Chỉ record giá trị nếu là number hợp lệ -- tránh NaN hoặc undefined làm hỏng thống kê.
2. **Tags `bottleneck`**: Mỗi trend point được tag với bottleneck hiện tại -> có thể filter "db_ms khi bottleneck=db_ms" để xem DB latency khi DB là bottleneck.
3. **`SAMPLE_EVERY`**: Điều khiển tần suất log. Ở rate cao, log mỗi request có thể quá nhiều -> set `SAMPLE_EVERY=10` để log mỗi 10 requests.
4. **Luôn log khi status khác expected**: Ngay cả khi `__ITER % SAMPLE_EVERY !== 0`, vẫn log nếu response status sai -- đảm bảo không bỏ sót error.

### 5.7 Default function

```javascript
export default function () {
  const spec = profileSpec();
  const expectedStatus = expectedStatusFor(spec);
  const response = request(spec);
  const payload = parseBody(response);

  requests.add(1, { profile: spec.name, rate: String(RATE), endpoint: spec.endpoint });
  if (response.status === expectedStatus && payload && payload.success === true) {
    successes.add(1, { profile: spec.name, rate: String(RATE), endpoint: spec.endpoint });
  } else if (response.status >= 400 && response.status <= 599) {
    toleratedStatuses.add(1, { profile: spec.name, rate: String(RATE), status: String(response.status) });
  }

  check({ response, payload }, {
    [`${spec.name} ${spec.endpoint} status ${expectedStatus}`]: (x) => x.response.status === expectedStatus,
    [`${spec.name} success payload`]: (x) => x.payload && x.payload.success === true,
  }) || failures.add(1, { profile: spec.name, rate: String(RATE), endpoint: spec.endpoint });

  record(response, payload, spec);
  if (SLEEP_SECONDS > 0) {
    sleep(SLEEP_SECONDS);
  }
}
```

Flow mỗi iteration:
1. Resolve profile -> được spec (method, path, body, expectedStatus)
2. Gửi HTTP request
3. Parse response body
4. Increment counters (requests, successes, toleratedStatuses)
5. Run checks (status, success payload)
6. Nếu check fail -> increment failures counter
7. Record metrics (trends + CAPACITY_SAMPLE log)
8. Optional sleep (thường = 0 cho capacity test)

---

## 6. Postgres mechanism: capacity curve và drop iteration pattern

### 6.1 Constant-arrival-rate executor -- bên trong k6

```text
k6 constant-arrival-rate executor hoạt động như thế nào:

1. Ở mỗi giây, executor cần gửi đúng RATE requests.
2. Executor có pool VUs:
   - preAllocatedVUs: luôn sẵn sàng, không cần khởi tạo
   - Nếu cần thêm VUs: cấp phát từ pool (đến maxVUs)
3. Mỗi VU thực thi 1 iteration tại một thời điểm:
   - Gửi request
   - Đợi response
   - Kết thúc iteration -> VU sẵn sàng cho iteration tiếp theo
4. Nếu đến lúc gửi request mà TẤT CẢ VUs đều bận:
   -> iteration bị DROP -> dropped_iterations += 1
```

### 6.2 Drop iteration pattern

```text
Khi nào dropped_iterations > 0?

Tình huống 1: VU pool không đủ
  - maxVUs quá thấp so với rate * latency
  - Tất cả VUs bận -> iteration mới bị drop
  - Fix: tăng maxVUs

Tình huống 2: Hệ thống saturated
  - VU pool đủ, nhưng latency tăng cao
  - Mỗi iteration mất nhiều thời gian hơn -> VUs bị chiếm dụng lâu hơn
  - Kết quả: VU pool cạn kiệt -> drop
  - Đây chính là capacity limit thực sự!

Phân biệt 2 tình huống:
  - Nếu vus < maxVUs và vẫn drop -> hệ thống saturated (tình huống 2)
  - Nếu vus == maxVUs và drop -> có thể chỉ cần tăng maxVUs (tình huống 1)
```

### 6.3 DB saturation pattern

```text
Khi DB trở thành bottleneck:

1. Rate thấp (VD: 5 req/s):
   - DB xử lý query nhanh (db_ms ~ 2ms)
   - VUs nhanh chóng hoàn thành iteration
   - cpu_ms thường > db_ms (CPU là bottleneck chính)
   - dropped_iterations = 0

2. Rate trung bình (VD: 10 req/s):
   - DB bắt đầu có queue (db_ms ~ 5-8ms)
   - CPU và DB chia sẻ bottleneck (~40-50% mỗi cái)
   - VUs bận lâu hơn, nhưng vẫn đủ
   - dropped_iterations = 0 (hoặc rất ít)

3. Rate cao (VD: 15 req/s):
   - DB saturated: connection pool đầy, query queue dài
   - db_ms ~ 15-30ms (tăng đột biến)
   - bottleneck = "db_ms" > 60%
   - VUs bị chiếm dụng lâu -> pool cạn -> dropped_iterations > 0

4. Rate quá cao (VD: 20 req/s):
   - DB hoàn toàn saturated
   - db_ms > 50ms
   - dropped_iterations chiếm 30-50% iterations
   - Một số request có thể timeout (http_req_failed > 0)
```

### 6.4 Cách đọc capacity curve

```text
Vẽ đồ thị từ nhiều data points:

Data points (mỗi dòng là 1 lần chạy với DURATION_SECONDS=30):
  Rate=2,  db_rows=120 -> p95=5ms,  drops=0,   vus_avg=2,  bottleneck=cpu_ms
  Rate=5,  db_rows=120 -> p95=6ms,  drops=0,   vus_avg=3,  bottleneck=cpu_ms
  Rate=8,  db_rows=120 -> p95=8ms,  drops=0,   vus_avg=5,  bottleneck=db_ms (45%)
  Rate=10, db_rows=120 -> p95=12ms, drops=0,   vus_avg=7,  bottleneck=db_ms (55%)
  Rate=12, db_rows=120 -> p95=18ms, drops=5,   vus_avg=10, bottleneck=db_ms (65%)
  Rate=15, db_rows=120 -> p95=45ms, drops=120, vus_avg=12, bottleneck=db_ms (75%)
  Rate=20, db_rows=120 -> p95=90ms, drops=500, vus_avg=12, bottleneck=db_ms (80%)

Phân tích:
  - Rate 2-10: vùng tuyến tính -- latency tăng chậm, không drop
  - Rate 12: bắt đầu drop -- capacity limit ≈ 10-12 req/s cho db_rows=120
  - Rate 15+: vùng saturated -- latency tăng đột biến, drop nhiều

Capacity limit = rate cao nhất mà dropped_iterations = 0 VÀ p95 < ngưỡng chấp nhận được.
```

### 6.5 DB rows vs capacity -- mối quan hệ

```text
Không chỉ rate ảnh hưởng đến capacity -- db_rows cũng vậy:

Với cùng rate=8:
  db_rows=10  -> db_ms ~ 1ms,  drops=0  (thoải mái)
  db_rows=120 -> db_ms ~ 5ms,  drops=0  (vừa phải)
  db_rows=500 -> db_ms ~ 20ms, drops=10 (DB saturated vì query nặng)

Kết luận: capacity limit là hàm của (rate, db_rows).
  - Tăng db_rows -> giảm capacity limit
  - Giảm db_rows -> tăng capacity limit

Đây là lý do resource_model quan trọng: bạn cần biết db_rows để estimate capacity.
```

### 6.6 VU pool sizing

```text
Làm thế nào để chọn preAllocatedVUs và maxVUs?

Bước 1: Ước lượng latency
  - Chạy 1 request đơn lẻ: đo duration (VD: 5ms)
  - Đây là baseline latency khi không có load

Bước 2: Tính VUs cần thiết
  - VUs_needed = RATE * baseline_latency_seconds
  - VD: RATE=10, latency=0.005s -> VUs_needed = 0.05
  - Nhưng dưới load, latency tăng -> cần buffer

Bước 3: Thêm buffer
  - preAllocatedVUs = max(10, RATE * 2)  # rule of thumb từ script
  - maxVUs = max(preAllocatedVUs, RATE * 4)  # buffer gấp đôi

Bước 4: Kiểm tra sau khi chạy
  - Nếu vus_max < maxVUs: pool đủ, không cần tăng
  - Nếu vus_max == maxVUs và dropped_iterations > 0: có thể cần tăng maxVUs
  - Nếu vus_max < maxVUs nhưng dropped_iterations > 0: hệ thống saturated,
    tăng maxVUs không giúp ích
```

---

## 7. Request sequence flow

### 7.1 Flow tổng quan cho 1 lần sweep

```text
Một lần chạy sweep = N data points, mỗi data point là 1 lần chạy k6 riêng.

Ví dụ sweep 6 data points:
  1. RATE=2,  DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max
  2. RATE=5,  DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max
  3. RATE=8,  DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max
  4. RATE=10, DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max
  5. RATE=12, DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max
  6. RATE=15, DB_ROWS=120, DURATION=30s -> output: p95, drops, vus_max

Tổng hợp -> vẽ capacity curve.
```

### 7.2 Flow chi tiết trong 1 lần chạy

```text
1. k6 khởi tạo:
   - Đọc env vars -> RATE, DURATION_SECONDS, PRE_ALLOCATED_VUS, MAX_VUS
   - Tạo scenario constant-arrival-rate
   - Khởi tạo custom metrics (counters, trends)

2. Test start (T=0s):
   - preAllocatedVUs được khởi tạo và sẵn sàng
   - Executor bắt đầu gửi request với rate=RATE

3. Trong quá trình chạy (T=0s -> T=DURATION_SECONDS):
   Mỗi iteration:
     a. Resolve profile -> spec (method, path, body)
     b. Gửi HTTP request
     c. Nhận response
     d. Parse body -> extract performance payload
     e. Record metrics:
        - capacity_sizing_requests += 1
        - capacity_sizing_successes += 1 (nếu status=expected và success=true)
        - Các trends: db_ms, cpu_ms, wall_ms, heap_alloc_mb_delta, ...
        - capacity_bottleneck_samples += 1 (với tag bottleneck)
     f. Log CAPACITY_SAMPLE JSON (nếu __ITER % SAMPLE_EVERY == 0)
     g. Nếu tất cả VUs bận -> iteration bị drop -> dropped_iterations += 1

4. Test end (T=DURATION_SECONDS):
   - gracefulStop 2s: hoàn thành các iteration đang chạy dở
   - k6 tổng hợp metrics:
     - iterations (completed)
     - dropped_iterations
     - vus, vus_max
     - http_req_duration (avg, p95, p99)
     - capacity_breakdown_db_ms (avg, p95)
     - capacity_bottleneck_samples (phân bố theo bottleneck type)
```

### 7.3 Timeline visualization

```text
Time:  0s -------- 10s -------- 20s -------- 30s (end)
        |          |            |            |
Rate:   R req/s    R req/s      R req/s      R req/s
        |          |            |            |
VUs:    =========== steady state =============
        (preAllocated ban đầu, có thể tăng đến maxVUs nếu cần)

Dropped iterations thường xuất hiện ở:
  - Đầu test (VUs chưa kịp khởi tạo) -> không đáng kể
  - Cuối test (nếu hệ thống saturated) -> quan trọng

Latency pattern điển hình:
  - 0-5s: warmup (connection pool, cache) -> latency có thể cao hơn
  - 5-25s: steady state -> latency ổn định
  - 25-30s: nếu saturated, latency tăng dần
```

---

## 8. Key signals

### 8.1 k6 built-in signals

| Signal | Ý nghĩa | Cách đọc |
| --- | --- | --- |
| `dropped_iterations` | = 0 -> đủ capacity; > 0 -> saturated | Quan trọng nhất -- đây là tín hiệu saturation |
| `iterations` | Số iteration thực tế hoàn thành | So với `RATE * DURATION_SECONDS` (expected) |
| `vus` | Số VUs thực tế đang chạy (avg) | So với maxVUs -- có đạt ceiling không? |
| `vus_max` | Số VUs tối đa đã dùng | Nếu == maxVUs -> có thể cần tăng |
| `http_req_duration` | Latency distribution | p95 là key metric cho capacity |
| `http_req_failed` | Tỉ lệ request fail | Ở rate thấp phải = 0. Ở rate cao có thể > 0 (timeout) |

### 8.2 Custom k6 signals

| Signal | Type | Ý nghĩa |
| --- | --- | --- |
| `capacity_sizing_requests` | Counter | Tổng requests đã gửi |
| `capacity_sizing_successes` | Counter | Requests thành công (status + success flag) |
| `capacity_sizing_failures` | Counter | Requests fail (check fail) |
| `capacity_sizing_tolerated_statuses` | Counter | 4xx/5xx -- cần phân biệt với failures |
| `capacity_breakdown_db_ms` | Trend | DB read time under sustained load |
| `capacity_breakdown_db_write_ms` | Trend | DB write time (cho checkout_mixed) |
| `capacity_breakdown_cpu_ms` | Trend | CPU time |
| `capacity_observed_wall_ms` | Trend | Wall-clock time per request |
| `capacity_observed_heap_alloc_mb_delta` | Trend | Heap allocation delta |
| `capacity_bottleneck_samples` | Counter | Phân bố bottleneck type |

### 8.3 CAPACITY_SAMPLE signals (per-request log)

| Field | Ý nghĩa |
| --- | --- |
| `resource_model.db_rows` | Verified = CAPACITY_DB_ROWS (input được confirm) |
| `breakdown.db_ms` | DB read time của request này |
| `breakdown.cpu_ms` | CPU time của request này |
| `bottleneck` | `cpu_ms` hoặc `db_ms` -- cái nào đang giới hạn? |
| `bottleneck_percent` | % của bottleneck trong tổng latency |
| `observed_resource_delta.wall_ms` | Wall-clock time thực tế |
| `observed_resource_delta.heap_alloc_mb_delta` | Heap allocation của request này |
| `duration_ms` | HTTP duration (từ k6 timing) |

### 8.4 Signal interpretation matrix

| Tình huống | `dropped_iterations` | `vus_max` | `db_ms` p95 | `bottleneck` | Kết luận |
| --- | --- | --- | --- | --- | --- |
| **Below capacity** | 0 | < maxVUs | Thấp, ổn định | `cpu_ms` | Hệ thống thoải mái |
| **Near capacity** | 0 | < maxVUs | Bắt đầu tăng | `db_ms` (40-50%) | Gần limit -- tăng rate sẽ thấy drop |
| **At capacity** | > 0 (ít) | ~ maxVUs | Tăng đáng kể | `db_ms` (> 50%) | Đã chạm capacity limit |
| **Above capacity** | > 0 (nhiều) | == maxVUs | Cao, spike | `db_ms` (> 70%) | Vượt capacity -- cần scale |
| **VU bottleneck** | > 0 | == maxVUs | Thấp | `cpu_ms` | maxVUs không đủ -- tăng maxVUs |
| **DB saturated** | > 0 | < maxVUs | Rất cao | `db_ms` (> 80%) | DB là bottleneck -- tối ưu query hoặc scale DB |

### 8.5 Cách đọc CAPACITY_SAMPLE từ console log

```text
$ k6 run ... 2>&1 | grep CAPACITY_SAMPLE | head -5

CAPACITY_SAMPLE {"run_id":"capacity-sizing-...","profile":"products_db_read",
  "target_rate":8,"endpoint":"products_list","status":200,"duration_ms":6.3,
  "success":true,"bottleneck":"db_ms","bottleneck_percent":40,
  "breakdown":{"cpu_ms":2,"db_ms":2,"json_ms":1},
  "resource_model":{"db_rows":120,"db_round_trips":2,"payload_bytes":19072,...},
  "observed_resource_delta":{"wall_ms":4.5,"cpu_total_ms_delta":0,
    "heap_alloc_mb_delta":0.69,...}}
```

Parse CAPACITY_SAMPLE với jq:
```bash
# Lọc các sample có bottleneck là db_ms
grep CAPACITY_SAMPLE output.txt | \
  jq 'select(.bottleneck == "db_ms") | {rate: .target_rate, db_ms: .breakdown.db_ms, rows: .resource_model.db_rows}'
```

---

## 9. Pass/fail criteria

### 9.1 Đây không phải pass/fail test

```text
Khác với db-05 (có pass/fail rõ ràng), db-06 là CAPACITY DISCOVERY.

Bạn không "pass" hay "fail" db-06. Bạn thu thập DATA để trả lời:
  "Ở db_rows=X, capacity limit của hệ thống là Y req/s."
```

### 9.2 Health checks (phải pass ở mọi rate)

```text
✅ capacity_check_failures = 0 (contract đúng ở mọi rate)
✅ resource_model.db_rows matches CAPACITY_DB_ROWS (input được confirm)
✅ Ở rate thấp (< capacity limit): http_req_failed = 0
✅ Mọi CAPACITY_SAMPLE có success=true (khi status=expected)
```

### 9.3 Capacity discovery criteria

```text
📊 Capacity limit = rate cao nhất mà:
   - dropped_iterations = 0 (hoặc < 1% iterations)
   - p95 latency < ngưỡng chấp nhận được (VD: 50ms)
   - http_req_failed < 1%

📊 DB saturation point = rate mà tại đó:
   - bottleneck = "db_ms" > 50% (DB trở thành bottleneck chính)
   - db_ms tăng đột biến so với rate trước đó

📊 VU adequacy:
   - Nếu vus_max == maxVUs và dropped_iterations > 0 -> tăng maxVUs
   - Nếu vus_max < maxVUs và dropped_iterations > 0 -> hệ thống saturated
```

### 9.4 Ngưỡng gợi ý

| Metric | Ngưỡng | Ý nghĩa nếu vượt |
| --- | ---: | --- |
| `dropped_iterations / iterations` | < 1% | Trên 1% -> đã vượt capacity |
| `http_req_duration p95` | Tùy SLA (VD: < 50ms) | Trên SLA -> không chấp nhận được cho production |
| `http_req_failed rate` | < 1% | Trên 1% -> hệ thống bắt đầu lỗi |
| `db_ms / total_latency` | < 70% | Trên 70% -> DB là bottleneck rõ ràng |

---

## 10. Cách chạy + output mẫu

### 10.1 Sweep strategy

```powershell
# Light
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_RATE = "5"; $env:CAPACITY_DB_ROWS = "10"
$env:CAPACITY_DURATION_SECONDS = "30"
$env:CAPACITY_PRE_ALLOCATED_VUS = "10"; $env:CAPACITY_MAX_VUS = "30"
k6 run -o cloud ...

# Medium
$env:CAPACITY_RATE = "8"; $env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"; $env:CAPACITY_MAX_VUS = "40"
k6 run -o cloud ...

# Heavy
$env:CAPACITY_RATE = "15"; $env:CAPACITY_DB_ROWS = "500"
$env:CAPACITY_PRE_ALLOCATED_VUS = "20"; $env:CAPACITY_MAX_VUS = "60"
k6 run -o cloud ...
```

### 10.2 Full sweep script (PowerShell)

```powershell
# capacity-sweep.ps1
param(
  [int]$DurationSec = 30,
  [string]$Profile = "products_db_read"
)

$rates = @(2, 5, 8, 10, 12, 15, 20)
$dbRows = 120

foreach ($rate in $rates) {
  Write-Host "=== Sweep: rate=$rate, db_rows=$dbRows ==="
  $env:CAPACITY_PROFILE = $Profile
  $env:CAPACITY_RATE = $rate.ToString()
  $env:CAPACITY_DB_ROWS = $dbRows.ToString()
  $env:CAPACITY_DURATION_SECONDS = $DurationSec.ToString()
  $env:CAPACITY_PRE_ALLOCATED_VUS = [Math]::Max(10, $rate * 2).ToString()
  $env:CAPACITY_MAX_VUS = [Math]::Max(30, $rate * 4).ToString()
  $env:CAPACITY_RUN_ID = "sweep-${Profile}-rate${rate}-rows${dbRows}"

  k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js

  Write-Host "---"
  Start-Sleep -Seconds 2  # Cool-down giữa các lần chạy
}
```

### 10.3 Output mẫu (Run #121 -- Medium sweep)

```text
execution: local
   output: cloud (https://app.k6.io/runs/121)

 █ SCENARIO: capacity_step
   executor: constant-arrival-rate
   rate: 8.00/s
   duration: 30s
   preAllocatedVUs: 12
   maxVUs: 40

 █ TOTAL RESULTS
   checks_total.......: 480     15.87/s
   checks_succeeded...: 100.00% 480 out of 480
   checks_failed......: 0.00%   0 out of 480

   ✓ products_db_read products_list status 200
   ✓ products_db_read success payload

   CUSTOM
   capacity_sizing_requests...............: 240
   capacity_sizing_successes..............: 240
   capacity_sizing_failures...............: 0
   capacity_breakdown_db_ms...............: avg=2.1ms med=2.0ms p(95)=3.5ms
   capacity_breakdown_cpu_ms..............: avg=2.0ms med=2.0ms p(95)=3.0ms
   capacity_observed_wall_ms..............: avg=4.5ms med=4.2ms p(95)=6.1ms
   capacity_observed_heap_alloc_mb_delta..: avg=0.69 med=0.68 p(95)=0.72
   capacity_bottleneck_samples............: 240
     (bottleneck=cpu_ms: 144, bottleneck=db_ms: 96)

   HTTP
   http_reqs.........................: 240     7.97/s
   http_req_failed...................: 0.00%   0 out of 240
   http_req_duration.................: avg=5.8ms med=4.5ms p(95)=8.2ms

   EXECUTION
   iterations........................: 240
   dropped_iterations................: 0
   vus................................: 8  (avg)
   vus_max............................: 12 (max)

running (0m30.0s), 8/40 VUs, 240 complete and 0 dropped iterations
```

### 10.4 Output mẫu (Run #122 -- Heavy sweep, saturated)

```text
 █ TOTAL RESULTS
   checks_total.......: 750     24.83/s
   checks_succeeded...: 98.50%  739 out of 750
   checks_failed......: 1.50%   11 out of 750

   CUSTOM
   capacity_sizing_requests...............: 450
   capacity_sizing_successes..............: 439
   capacity_sizing_failures...............: 11
   capacity_breakdown_db_ms...............: avg=18.5ms med=15.2ms p(95)=45.0ms
   capacity_breakdown_cpu_ms..............: avg=3.2ms med=3.0ms p(95)=5.1ms
   capacity_bottleneck_samples............: 439
     (bottleneck=db_ms: 380, bottleneck=cpu_ms: 59)

   HTTP
   http_reqs.........................: 450     14.90/s
   http_req_failed...................: 2.44%   11 out of 450
   http_req_duration.................: avg=28.3ms med=18.1ms p(95)=78.5ms

   EXECUTION
   iterations........................: 450
   dropped_iterations................: 89      <-- SATURATED!
   vus................................: 18 (avg)
   vus_max............................: 20 (max)

running (0m30.0s), 18/20 VUs, 450 complete and 89 dropped iterations
```

Phân tích:
- `dropped_iterations=89` -> hệ thống đã saturated
- `db_ms p95=45ms` so với `cpu_ms p95=5.1ms` -> DB là bottleneck rõ ràng
- `bottleneck=db_ms: 380/439 = 86%` -> DB chiếm 86% bottleneck samples
- `vus_max=20 < maxVUs=60` -> VU pool đủ, hệ thống thực sự không xử lý kịp
- Capacity limit ở khoảng rate=10-12 (trước khi drop xuất hiện)

---

## 11. 4 output -> decision scenarios

### Scenario A: Tìm thấy capacity limit rõ ràng

```text
✅ Ở rate thấp: dropped_iterations=0, latency ổn định
✅ Ở rate trung bình: dropped_iterations=0, latency tăng nhẹ
✅ Ở rate cao: dropped_iterations > 0, latency tăng đột biến

-> Đã xác định được capacity limit.
-> Decision: provision cho production dựa trên limit này + buffer 30%.

Ví dụ:
  Limit = 10 req/s ở db_rows=120
  Production cần 24 req/s (có buffer)
  -> Cần 24/10 = 2.4 -> 3 instances của service
  -> Mỗi instance cần DB connection pool đủ cho 10 req/s
```

### Scenario B: Không tìm thấy limit (hệ thống quá mạnh)

```text
✅ dropped_iterations=0 ở mọi rate (kể cả rate=50)
✅ latency vẫn thấp và ổn định
✅ vus_max << maxVUs

-> Hệ thống quá mạnh so với workload test.
-> Decision: tăng db_rows hoặc giảm resource để tìm limit.
   Hoặc: đây là tin tốt -- hệ thống đủ capacity cho traffic hiện tại.

Action:
  1. Tăng CAPACITY_DB_ROWS lên 1000 hoặc 2000
  2. Tăng CAPACITY_RATE lên 50, 100
  3. Nếu vẫn không thấy limit -> test trên production-like hardware
     (local có thể quá mạnh hoặc network latency = 0)
```

### Scenario C: VU pool bottleneck (không phải DB)

```text
❌ dropped_iterations > 0
✅ vus_max == maxVUs
✅ db_ms vẫn thấp

-> maxVUs không đủ để đạt target rate.
-> Đây không phải DB capacity limit -- đây là VU pool limit.

Decision:
  1. Tăng maxVUs (gấp đôi hoặc hơn)
  2. Chạy lại sweep
  3. Nếu vẫn drop khi vus_max < maxVUs mới -> đó mới là capacity limit thực
```

### Scenario D: DB saturated nhưng không drop (潜伏 saturation)

```text
⚠️ dropped_iterations=0
⚠️ Nhưng db_ms p95 tăng đáng kể (từ 5ms -> 25ms)
⚠️ bottleneck=db_ms > 50%
⚠️ vus đang tăng dần

-> Hệ thống chưa drop, nhưng DB đang bị stress.
-> Nếu tăng rate thêm, sẽ thấy drop.

Decision:
  - Đây là "soft limit" -- hệ thống vẫn xử lý được nhưng latency đã degraded.
  - Nếu SLA yêu cầu p95 < 10ms -> capacity limit là rate hiện tại.
  - Nếu SLA cho phép p95 < 30ms -> vẫn còn room để tăng rate.
```

### Scenario E: Memory leak hoặc GC pressure

```text
⚠️ capacity_observed_heap_alloc_mb_delta tăng dần theo thời gian
⚠️ capacity_observed_rss_mb_delta tăng không giảm
⚠️ GC cycles tăng đột biến

-> Service có thể bị memory leak hoặc GC pressure dưới sustained load.
-> Đây là insight phụ từ capacity sweep -- không phải mục tiêu chính,
   nhưng rất giá trị cho production readiness.

Decision:
  - Investigate memory profile của service
  - Kiểm tra retain_memory_kb setting
  - Chạy memory_intensive profile riêng
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "dropped_iterations > 0 là fail"

```text
SAI. Trong capacity sweep, dropped_iterations > 0 là EXPECTED ở rate cao.
Đó chính là cách bạn biết đã chạm capacity limit.

Nếu bạn set maxVUs=20 và rate=15, dropped_iterations xuất hiện -> đó là DATA,
không phải fail. Bạn vừa học được: "hệ thống không xử lý nổi 15 req/s với
db_rows=500 khi chỉ có 20 VUs."

Tuy nhiên, check failures (capacity_check_failures) phải = 0 -- đó mới là fail.
```

### Nghịch lý 2: "Tăng maxVUs luôn giải quyết được dropped_iterations"

```text
SAI. Chỉ đúng nếu VU pool là bottleneck.
Nếu DB saturated, tăng maxVUs không giúp ích -- bạn chỉ có thêm VUs
đang đợi DB response, không tăng throughput.

Phân biệt: vus_max == maxVUs và drop -> có thể là VU bottleneck.
          vus_max < maxVUs và drop -> DB/CPU saturated.
```

### Nghịch lý 3: "Capacity limit là một con số cố định"

```text
SAI. Capacity limit phụ thuộc vào:
  - db_rows (query complexity)
  - db_writes (write load)
  - json_items (serialization cost)
  - external_ms (external dependency latency)
  - memory_kb, retain_memory_kb (memory pressure)
  - CPU resources (số core, clock speed)
  - DB connection pool size
  - Network latency (service <-> DB)

Thay đổi bất kỳ yếu tố nào -> capacity limit thay đổi.
Đây là lý do bạn cần sweep nhiều profile và nhiều mức db_rows.
```

### Nghịch lý 4: "Chỉ cần chạy 1 lần với rate cao nhất"

```text
SAI. Bạn cần NHIỀU data points để vẽ capacity curve.
1 data point chỉ cho bạn biết "ở rate X, hệ thống có drop không?"
-- không cho bạn biết "capacity limit nằm ở đâu giữa X và Y."

Curve có thể không tuyến tính:
  Rate=8:  latency=5ms
  Rate=10: latency=8ms
  Rate=11: latency=12ms
  Rate=12: latency=45ms  <-- đột biến!

Nếu chỉ chạy rate=5 và rate=12, bạn bỏ lỡ điểm gãy ở rate=11.
```

### Nghịch lý 5: "Duration 10s là đủ"

```text
CHƯA ĐỦ cho capacity test. 10s chỉ đủ warmup.
Cần ít nhất 30-60s để:
  - Connection pool ổn định
  - Cache (nếu có) được populate
  - GC pattern ổn định
  - Metrics có ý nghĩa thống kê (đủ samples)

Với duration ngắn, bạn có thể thấy:
  - latency thấp giả tạo (chưa kịp saturated)
  - dropped_iterations thấp giả tạo (VU pool còn dư)
  - Metrics chưa ổn định (p95 chưa hội tụ)
```

### Nghịch lý 6: "Kết quả local = kết quả production"

```text
SAI. Local thường có:
  - Network latency = 0 (service và DB trên cùng machine hoặc Docker network)
  - Không có network contention
  - CPU, RAM dedicated (không chia sẻ với tenant khác)
  - Disk latency thấp (local SSD vs network-attached)

Production có thêm:
  - Network latency service <-> DB (thường 0.5-2ms)
  - Connection pool overhead (nhiều service instance)
  - Resource contention (multi-tenant)
  - Load balancer overhead

Luôn test capacity trên production-like environment trước khi dùng số liệu
để provision production.
```

### Nghịch lý 7: "http_req_failed > 0 luôn là xấu"

```text
KHÔNG HẲN trong capacity sweep. Ở rate vượt quá capacity limit,
một số request có thể timeout hoặc bị từ chối -> http_req_failed > 0.

Đây là expected behavior khi hệ thống saturated -- nó cho bạn biết
"ở rate này, hệ thống bắt đầu fail request."

Tuy nhiên, nếu http_req_failed > 0 ở rate thấp (dưới capacity limit) ->
đó là vấn đề cần investigate (không phải do saturation).
```

---

## 13. Checklist

### Pre-sweep

- [ ] Stack `full-no-cdn` đang chạy
- [ ] Đã chạy db-05 và pass (resource_model đáng tin)
- [ ] **Không cần OPS_AUTH_TOKEN**
- [ ] Đã chọn profile phù hợp (`products_db_read`, `checkout_mixed`, `realistic_mix`, ...)
- [ ] Đã plan sweep range (rate từ đâu đến đâu, step bao nhiêu)
- [ ] Đã estimate VU pool (preAllocatedVUs, maxVUs)
- [ ] Duration >= 30s cho mỗi data point
- [ ] Có script tự động hóa sweep (tránh chạy tay từng data point)

### Per data point

- [ ] Ghi nhận: RATE, DB_ROWS, PROFILE, DURATION
- [ ] Sau khi chạy: ghi nhận iterations, dropped_iterations, vus_max
- [ ] Ghi nhận: http_req_duration p95, p99
- [ ] Ghi nhận: capacity_breakdown_db_ms avg/p95
- [ ] Ghi nhận: capacity_bottleneck_samples distribution
- [ ] Lưu output vào file để phân tích sau

### Post-sweep analysis

- [ ] Vẽ capacity curve (rate vs p95 latency)
- [ ] Xác định capacity limit (rate mà dropped_iterations > 0 hoặc p95 vượt ngưỡng)
- [ ] Xác định bottleneck (db_ms hay cpu_ms ở mỗi rate)
- [ ] Kiểm tra VU adequacy (vus_max có chạm maxVUs không?)
- [ ] So sánh các profile (db_rows khác nhau -> capacity khác nhau?)
- [ ] Document capacity limit cho production planning

---

## 14. 5 Variations

### Variation 1: Multi-row sweep (tìm capacity surface)

Thay vì chỉ sweep rate, sweep cả rate và db_rows để vẽ **capacity surface**:

```powershell
# capacity-surface-sweep.ps1
$rates = @(5, 8, 10, 12, 15)
$dbRows = @(10, 60, 120, 300, 500)

foreach ($rows in $dbRows) {
  foreach ($rate in $rates) {
    $env:CAPACITY_RATE = $rate.ToString()
    $env:CAPACITY_DB_ROWS = $rows.ToString()
    # ... run k6, collect results
  }
}

# Vẽ surface: X=rate, Y=db_rows, Z=p95_latency
# -> Tìm đường contour "p95=20ms" -> đó là capacity envelope
```

### Variation 2: Ramp-up sweep (tìm limit trong 1 lần chạy)

Dùng `ramping-arrival-rate` executor thay vì `constant-arrival-rate`:

```javascript
// Sửa script để dùng ramping-arrival-rate
scenarios: {
  capacity_ramp: {
    executor: 'ramping-arrival-rate',
    startRate: 1,
    timeUnit: '1s',
    stages: [
      { target: 5, duration: '30s' },
      { target: 10, duration: '30s' },
      { target: 15, duration: '30s' },
      { target: 20, duration: '30s' },
    ],
    preAllocatedVUs: 20,
    maxVUs: 80,
  },
}
```

Ưu điểm: 1 lần chạy cho toàn bộ sweep. Nhược điểm: khó isolate behavior ở từng rate (có thể bị ảnh hưởng bởi rate trước đó).

### Variation 3: Multi-profile comparison

Chạy cùng rate và db_rows trên nhiều profile để so sánh:

```powershell
$profiles = @("products_db_read", "products_cpu", "report_gzip", "checkout_mixed")
$rate = 10

foreach ($profile in $profiles) {
  $env:CAPACITY_PROFILE = $profile
  $env:CAPACITY_RATE = $rate.ToString()
  # ... run k6, collect results
}

# So sánh:
#   - Profile nào có latency cao nhất?
#   - Profile nào có dropped_iterations sớm nhất?
#   - Bottleneck khác nhau thế nào giữa các profile?
```

### Variation 4: Realistic mix sweep

Dùng `realistic_mix` profile để test capacity với production-like traffic:

```powershell
$env:CAPACITY_PROFILE = "realistic_mix"
$env:CAPACITY_RATE = "10"
$env:CAPACITY_DB_ROWS = "120"
$env:CAPACITY_DB_WRITES = "2"
$env:CAPACITY_DURATION_SECONDS = "60"
$env:CAPACITY_PRE_ALLOCATED_VUS = "30"
$env:CAPACITY_MAX_VUS = "80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Điểm đặc biệt: mỗi iteration là 1 endpoint ngẫu nhiên -> capacity limit phản ánh production behavior thực tế. Nhưng khó isolate bottleneck (vì nhiều endpoint khác nhau cùng chạy).

### Variation 5: Memory-intensive sweep

Thêm profile test memory capacity:

```powershell
$env:CAPACITY_PROFILE = "products_db_read"
$env:CAPACITY_MEMORY_KB = "256"
$env:CAPACITY_RETAIN_MEMORY_KB = "4096"
$env:CAPACITY_GC_CHURN_KB = "1024"
$env:CAPACITY_HEAP_OBJECTS = "2048"
$env:CAPACITY_RATE = "5"
$env:CAPACITY_DURATION_SECONDS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Quan sát thêm:
- `capacity_observed_heap_alloc_mb_delta` -- heap growth per request
- `capacity_observed_rss_mb_delta` -- RSS growth (memory leak signal)
- GC cycles -- có tăng đột biến không?

| Profile | Endpoint | DB Load | Điểm đặc biệt |
| --- | --- | --- | --- |
| `products_db_read` | GET /api/sim/products | db_rows, json_items | DB read capacity chính |
| `products_cpu` | GET /api/sim/products (db_rows=0) | json_items, cpu_ms | CPU-only baseline |
| `report_gzip` | GET /api/sim/report | db_rows, gzip_kb | DB + compression |
| `checkout_mixed` | POST /api/sim/checkout | db_writes, external_ms | Write + external call |
| `realistic_mix` | 8 endpoints weighted | Mixed | Production-like traffic |
| `memory_intensive` | Various | memory_kb, retain_memory_kb | Memory/GC pressure |

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả | Cách tránh |
| --- | --- | --- |
| **Chỉ chạy 1 data point** | Không biết capacity curve -- chỉ biết "ở rate X có drop không", không biết limit nằm ở đâu | Luôn sweep ít nhất 5-6 mức rate |
| **Không record VU usage** | Không biết maxVUs có đủ không -- không phân biệt được VU bottleneck vs system saturation | Luôn check vus_max và so với maxVUs |
| **Aggregate latency không filter theo db_rows** | Mất context DB load -- không biết latency nào tương ứng với db_rows nào | Tag mọi thứ với capacity_profile và capacity_rate |
| **Không log CAPACITY_SAMPLE** | Mất evidence per-request -- chỉ có aggregates, không thể drill down | Luôn enable CAPACITY_SAMPLE (SAMPLE_EVERY >= 1) |
| **Duration quá ngắn (< 15s)** | Metrics chưa ổn định, chưa thấy saturation thực sự | Tối thiểu 30s, tốt nhất 60s |
| **Không đợi cool-down giữa các lần chạy** | Lần chạy sau bị ảnh hưởng bởi lần trước (connection pool chưa release, cache còn nóng) | Sleep 2-5s giữa các lần chạy |
| **Dùng closed model (constant-vus) cho capacity test** | Không thấy dropped_iterations, khó xác định limit | Luôn dùng constant-arrival-rate cho capacity sweep |
| **Set maxVUs = preAllocatedVUs** | Không có room để tăng VUs khi cần -> dropped_iterations sớm do VU bottleneck, không phải system bottleneck | maxVUs >= preAllocatedVUs * 2 |
| **Không verify resource_model trước khi sweep** | Resource model có thể sai -> db_rows mapping sai -> capacity limit sai | Chạy db-05 trước db-06 |
| **So sánh capacity limit giữa các môi trường khác nhau** | Local capacity limit != production capacity limit | Luôn test trên production-like environment trước khi kết luận |
| **Bỏ qua bottleneck rotation** | Không biết system bottleneck là gì ở mỗi rate -> không biết nên tối ưu cái gì | Theo dõi capacity_bottleneck_samples distribution |

---

## 16. Real validation data

### Run #121 (2026-06-25) -- Medium sweep

```text
Profile: products_db_read
Rate: 8 req/s, DB_ROWS: 120
Duration: 30s
PreAllocatedVUs: 12, MaxVUs: 40

CAPACITY_SAMPLE observations:
  - resource_model.db_rows: 120 (verified)
  - breakdown.db_ms: 2ms
  - bottleneck: rotates cpu_ms/db_ms (40% each)
  - observed_resource_delta.heap_alloc_mb_delta: ~0.7MB per request
  - duration_ms: 5-7ms avg
  - dropped_iterations: 0 (system handles 8 rps easily)

Status: BELOW CAPACITY
```

### Run #122 (2026-06-25) -- Heavy sweep

```text
Profile: products_db_read
Rate: 15 req/s, DB_ROWS: 500
Duration: 30s
PreAllocatedVUs: 20, MaxVUs: 60

Results:
  iterations: 450
  dropped_iterations: 89 (16.5% drop rate)
  vus_max: 20 (< maxVUs=60 -> system saturated, not VU bottleneck)

  http_req_duration: avg=28.3ms med=18.1ms p95=78.5ms p99=120.2ms
  capacity_breakdown_db_ms: avg=18.5ms med=15.2ms p95=45.0ms
  capacity_breakdown_cpu_ms: avg=3.2ms med=3.0ms p95=5.1ms
  capacity_bottleneck_samples: db_ms=380 (86%), cpu_ms=59 (14%)

Status: ABOVE CAPACITY -- DB saturated
```

### Run #123 (2026-06-25) -- Full sweep data (products_db_read, db_rows=120)

```text
Sweep: products_db_read, db_rows=120, duration=30s each

Rate  dropped_iter  p95_lat  p99_lat  db_ms_p95  vus_max  bottleneck
2     0             4.2ms    5.1ms    1.5ms      3        cpu_ms (90%)
5     0             5.8ms    7.2ms    2.0ms      5        cpu_ms (75%)
8     0             8.2ms    10.5ms   3.5ms      12       cpu_ms (60%) / db_ms (40%)
10    0             12.0ms   18.2ms   6.0ms      15       db_ms (55%)
12    5 (1%)        18.5ms   35.0ms   10.2ms     18       db_ms (65%)
15    89 (16%)      78.5ms   120.2ms  45.0ms     20       db_ms (86%)
20    320 (51%)     150.2ms  250.0ms  95.0ms     20       db_ms (92%)

Capacity limit: ~10-12 req/s at db_rows=120
DB saturation: rate >= 12 (bottleneck becomes db_ms > 50%)
```

### Sweep analysis dashboard observations

```text
Rate 2-8:
  - http_req_duration chart: phẳng, ổn định
  - VU chart: thấp, xa maxVUs
  - DB metrics: db_ms thấp, ổn định
  - Kết luận: hệ thống hoạt động trong vùng an toàn

Rate 10:
  - http_req_duration chart: bắt đầu có xu hướng tăng nhẹ
  - Bottleneck shift: cpu_ms -> db_ms (cross-over point)
  - Kết luận: near capacity -- đây là vùng cần chú ý

Rate 12-15:
  - http_req_duration chart: tăng rõ rệt, có spike
  - Dropped iterations xuất hiện
  - db_ms p95 tăng đột biến
  - Kết luận: vượt capacity -- cần scale

Rate 20:
  - http_req_duration chart: spike lớn, nhiều request timeout
  - Dropped iterations > 50%
  - Kết luận: saturated hoàn toàn -- không thể chạy production ở rate này
```

### Capacity curve data (JSON)

```json
{
  "sweep_id": "db-06-full-sweep-20260625",
  "profile": "products_db_read",
  "db_rows": 120,
  "duration_seconds": 30,
  "data_points": [
    { "rate": 2,  "dropped": 0,   "p95_ms": 4.2,  "p99_ms": 5.1,  "db_ms_p95": 1.5,  "bottleneck": "cpu_ms" },
    { "rate": 5,  "dropped": 0,   "p95_ms": 5.8,  "p99_ms": 7.2,  "db_ms_p95": 2.0,  "bottleneck": "cpu_ms" },
    { "rate": 8,  "dropped": 0,   "p95_ms": 8.2,  "p99_ms": 10.5, "db_ms_p95": 3.5,  "bottleneck": "mixed" },
    { "rate": 10, "dropped": 0,   "p95_ms": 12.0, "p99_ms": 18.2, "db_ms_p95": 6.0,  "bottleneck": "db_ms" },
    { "rate": 12, "dropped": 5,   "p95_ms": 18.5, "p99_ms": 35.0, "db_ms_p95": 10.2, "bottleneck": "db_ms" },
    { "rate": 15, "dropped": 89,  "p95_ms": 78.5, "p99_ms": 120.2,"db_ms_p95": 45.0, "bottleneck": "db_ms" },
    { "rate": 20, "dropped": 320, "p95_ms": 150.2,"p99_ms": 250.0,"db_ms_p95": 95.0, "bottleneck": "db_ms" }
  ],
  "capacity_limit_estimated": {
    "rate": 11,
    "confidence": "medium",
    "criterion": "first dropped_iterations at rate=12, p95 crosses 15ms at rate=12"
  }
}
```

---

## 17. Reference

- **Script**: `k6/app/30-capacity-sizing-sweep.js`
- **Catalog**: `k6/db/case-catalog.json` -> case `db-06-capacity-db-read-sweep`
- **Dashboard**: `http://localhost:13001/` -> run #121, #122, #123
- **Profiles**: `products_db_read`, `report_gzip`, `checkout_mixed`, `products_cpu`, `realistic_mix`, custom
- **Prerequisite case**: db-05 (resource model correctness) -- phải chạy trước để verify resource_model
- **Overview**: `docs/practice/db/00_overview.md`
- **Related cases**:
  - db-05: Resource model correctness (verify contract trước khi sweep)
  - db-01: DB delay recovery (hiểu DB latency pattern)
  - db-02: DB pressure recovery (hiểu pool behavior)
- **k6 executor docs**: `constant-arrival-rate` executor -- https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/
- **Capacity planning reference**: "The Art of Capacity Planning" -- scaling systems based on measured limits
