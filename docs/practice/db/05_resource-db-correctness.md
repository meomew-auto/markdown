# db-05 -- DB resource model correctness

> **Case ID:** `db-05-resource-db-correctness`
> **Script:** `../app/26-resource-correctness-benchmark.js`
> **Profile:** `full-no-cdn`, **NO `OPS_AUTH_TOKEN` needed**
> **Workload:** 1 VU, 1 iteration (sequential)
> **Proof:** `db_rows`/`db_writes` input qua query params khớp với `performance.resource_model` và `performance.breakdown` trong response body. Đây là **sanity check cho toàn bộ DB metrics pipeline** -- phải làm đầu tiên trước mọi DB case khác.

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [DB capability được chứng minh](#2-db-capability-được-chứng-minh)
3. [Vì sao phải test ở DB layer](#3-vì-sao-phải-test-ở-db-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Postgres mechanism: resource_model contract](#6-postgres-mechanism-resource_model-contract)
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

Trước khi dùng DB metrics cho capacity planning, cần xác nhận một điều cơ bản: **khi API được gọi với `?db_rows=60`, response có thực sự report `resource_model.db_rows=60` không?**

Nếu contract này sai:
- Mọi phân tích capacity sau đó đều dựa trên dữ liệu không đáng tin
- Bạn có thể nghĩ DB đang query 60 rows nhưng thực ra là 6
- `db_ms` có thể bị sai lệch
- Bottleneck detection (`bottleneck: "db_ms"`) có thể sai

### 1.2 Đây là prerequisite

```text
db-05 (case này) -> db-01 -> db-02 -> db-03 -> db-04 -> db-06
```

Nếu `db_ms` không xuất hiện trong response, tất cả case khác không thể verify được DB behavior.

### 1.3 Performance payload contract

Mỗi API response trong hệ thống này có `performance` object:

```json
{
  "success": true,
  "data": { ... },
  "performance": {
    "breakdown": {
      "cpu_ms": 2,
      "db_ms": 5,
      "db_write_ms": 12,
      "json_ms": 1
    },
    "resource_model": {
      "db_rows": 60,
      "db_writes": 6,
      "db_round_trips": 2
    },
    "bottleneck": "db_ms",
    "bottleneck_percent": 55
  }
}
```

### 1.4 Hệ quả thực tế khi contract bị vi phạm

Hãy tưởng tượng một tình huống production:

```text
Ngày 15/06, team platform deploy version mới của products-service.
Thay đổi: refactor query builder, merge 2 query thành 1 (giảm db_round_trips từ 2 xuống 1).

Sau deploy:
  - P95 latency products-list giảm từ 12ms xuống 7ms -- nhìn có vẻ tốt.
  - Nhưng resource_model.db_rows bắt đầu report sai: query param db_rows=60
    nhưng resource_model.db_rows=145 (nó đang report tổng rows của cả 2 query cũ + mới).
  - Team capacity planning dùng resource_model.db_rows để forecast DB load.
    Họ thấy "145 rows/request" và tính toán sai capacity limit.
  - Kết quả: họ provision thiếu DB connection pool 40% cho Black Friday.
```

**Case này ngăn chặn chính xác kịch bản trên.** Nó verify rằng contract giữa input (query param) và output (resource_model) là chính xác -- trước khi bất kỳ ai dùng những con số đó để ra quyết định.

### 1.5 Tại sao gọi là "resource model"?

Tên `resource_model` xuất phát từ ý tưởng: mỗi API request tiêu thụ một lượng tài nguyên nhất định (CPU, DB rows, memory, disk I/O, network bandwidth). Resource model là **bản kê khai** lượng tài nguyên mà request này yêu cầu -- giống như hóa đơn tài nguyên cho từng request.

```text
Request: GET /api/sim/products?db_rows=120&cpu_ms=8&json_items=100
Resource model: { db_rows: 120, cpu_target_ms: 8, json_target_items: 100, ... }
```

Điều này cho phép:
- **Capacity planning**: "Ở 100 RPS với db_rows=120, DB cần xử lý 12,000 rows/s"
- **Cost attribution**: "Endpoint products-list tiêu thụ 60% DB time của toàn hệ thống"
- **Bottleneck detection**: "Ở rate hiện tại, db_ms chiếm 55% latency -> DB là bottleneck"

### 1.6 Phạm vi contract

Contract này bao phủ **mọi endpoint trong hệ thống** -- không chỉ products service. Mỗi endpoint có thể có các trường resource khác nhau:

| Nhóm endpoint | Resource fields điển hình |
| --- | --- |
| **Products read** | `db_rows`, `cpu_ms`, `json_items`, `gzip_kb` |
| **Auth** | `db_rows`, `cpu_ms`, `memory_kb`, `external_ms` |
| **Cart** | `db_rows`, `db_writes`, `cpu_ms`, `memory_kb` |
| **Order** | `db_writes`, `cpu_ms`, `disk_kb`, `external_ms` |
| **Report** | `db_rows`, `cpu_ms`, `gzip_kb`, `db_writes` |
| **Memory-intensive** | `memory_kb`, `retain_memory_kb`, `gc_churn_kb`, `heap_objects` |

Mỗi nhóm có contract riêng, và case này verify tất cả.

---

## 2. DB capability được chứng minh

### 2.1 Phát biểu capability

> **Mọi API response đều chứa `performance.resource_model` và `performance.breakdown`. `resource_model.db_rows` khớp chính xác với query param `?db_rows=N`. `resource_model.db_writes` khớp với `?db_writes=N`. `breakdown.db_ms` và `breakdown.db_write_ms` present trên các endpoint tương ứng.**

### 2.2 Sub-capabilities

Case này chứng minh 5 sub-capabilities độc lập:

| # | Sub-capability | Mô tả | Tại sao quan trọng |
| --- | --- | --- | --- |
| **C1** | `db_rows` contract | `resource_model.db_rows === query_param.db_rows` | Foundation cho capacity planning -- nếu sai, mọi dự báo DB load đều sai |
| **C2** | `db_writes` contract | `resource_model.db_writes === query_param.db_writes` | Foundation cho write capacity -- nếu sai, không biết checkout tiêu thụ bao nhiêu DB write |
| **C3** | `db_ms` presence | Khi `db_rows > 0`, `breakdown.db_ms` phải là number | Không có `db_ms` -> không thể đo DB read time -> db-01, db-02, db-06 vô nghĩa |
| **C4** | `db_write_ms` presence | Khi `db_writes > 0`, `breakdown.db_write_ms` phải là number | Không có `db_write_ms` -> không thể đo DB write time -> không verify được write path |
| **C5** | Cross-endpoint consistency | Contract giống nhau trên mọi endpoint (products, auth, cart, order, report) | Đảm bảo không có endpoint nào "quên" expose resource_model |

### 2.3 Verified endpoints

| Endpoint | Method | Type | Expected in response |
| --- | --- | --- | --- |
| `GET /api/sim/products?db_rows=60` | GET | Read | `resource_model.db_rows=60`, `breakdown.db_ms` |
| `GET /api/sim/products/:id?db_rows=30` | GET | Read | `resource_model.db_rows=30`, `breakdown.db_ms` |
| `GET /api/sim/products/search?db_rows=40` | GET | Read | `resource_model.db_rows=40`, `breakdown.db_ms` |
| `GET /api/sim/products/:id/recommendations?db_rows=20` | GET | Read | `resource_model.db_rows=20`, `breakdown.db_ms` |
| `GET /api/sim/products/categories?db_rows=10` | GET | Read | `resource_model.db_rows=10`, `breakdown.db_ms` |
| `GET /api/sim/products/homefeed?db_rows=15` | GET | Read | `resource_model.db_rows=15`, `breakdown.db_ms`, `gzip_kb` |
| `POST /api/sim/checkout?db_writes=6` | POST | Write | `resource_model.db_writes=6`, `breakdown.db_write_ms` |
| `POST /api/sim/orders/:id/confirm?db_writes=3` | POST | Write | `resource_model.db_writes=3`, `breakdown.db_write_ms` |
| `POST /api/sim/orders/webhooks/payment?db_writes=4` | POST | Write | `resource_model.db_writes=4`, `breakdown.db_write_ms` |
| `GET /api/sim/report?db_rows=20` | GET | Read | `resource_model.db_rows=20`, `breakdown.db_ms` |
| `POST /api/sim/report/jobs?db_rows=15` | POST | Write | `resource_model.db_rows=15`, `breakdown.db_ms` |
| `GET /api/sim/auth/me?db_rows=5` | GET | Read | `resource_model.db_rows=5`, `breakdown.db_ms` |
| `POST /api/sim/auth/login?db_rows=1` | POST | Read | `resource_model.db_rows=1`, `breakdown.db_ms` |
| `POST /api/sim/auth/refresh?db_rows=1` | POST | Read | `resource_model.db_rows=1`, `breakdown.db_ms`, `external_ms` |
| `POST /api/sim/cart/add?db_writes=1` | POST | Write | `resource_model.db_writes=1`, `breakdown.db_write_ms` |
| `GET /api/sim/cart?db_rows=5` | GET | Read | `resource_model.db_rows=5`, `breakdown.db_ms` |
| `GET /api/sim/cart/summary?db_rows=5` | GET | Read | `resource_model.db_rows=5`, `breakdown.db_ms`, `json_items` |
| `PATCH /api/sim/cart/items/:sku?db_writes=1` | PATCH | Write | `resource_model.db_writes=1`, `breakdown.db_write_ms` |
| `DELETE /api/sim/cart/items/:sku?db_writes=1` | DELETE | Write | `resource_model.db_writes=1`, `breakdown.db_write_ms` |
| ... (tổng ~28 endpoints) | | | |

### 2.4 Resource model field reference đầy đủ

Mỗi `resource_model` object có thể chứa các trường sau (tùy endpoint):

| Field | Type | Ý nghĩa | Nguồn (query param) |
| --- | --- | --- | --- |
| `db_rows` | number | Số DB rows được yêu cầu đọc | `?db_rows=N` |
| `db_writes` | number | Số DB writes được yêu cầu | `?db_writes=N` |
| `db_round_trips` | number | Số round-trip DB thực tế | Tính từ query structure |
| `cpu_target_ms` | number | CPU work được yêu cầu (ms) | `?cpu_ms=N` |
| `json_target_items` | number | Số JSON items cần serialize | `?json_items=N` |
| `memory_kb` | number | Memory cấp phát (KB) | `?memory_kb=N` |
| `retain_memory_kb` | number | Memory giữ lại sau request (KB) | `?retain_memory_kb=N` |
| `gc_churn_kb` | number | Memory GC churn (KB) | `?gc_churn_kb=N` |
| `heap_objects` | number | Số heap objects | `?heap_objects=N` |
| `gzip_kb` | number | Gzip output size (KB) | `?gzip_kb=N` |
| `disk_kb` | number | Disk I/O (KB) | `?disk_kb=N` |
| `external_target_ms` | number | External call duration (ms) | `?external_ms=N` |
| `payload_bytes` | number | Tổng payload bytes thực tế | Tính từ response body |
| `synthetic_work_bytes` | number | Bytes sinh ra từ synthetic work | > 0 khi có json_items/memory/gzip |
| `endpoint` | string | Tên endpoint | Routing context |

### 2.5 Breakdown field reference

| Field | Type | Ý nghĩa | Khi nào present |
| --- | --- | --- | --- |
| `cpu_ms` | number | CPU processing time thực tế (ms) | Khi `cpu_ms > 0` |
| `db_ms` | number | DB read time thực tế (ms) | Khi `db_rows > 0` |
| `db_write_ms` | number | DB write time thực tế (ms) | Khi `db_writes > 0` |
| `json_ms` | number | JSON serialization time (ms) | Khi `json_items > 0` |
| `memory_ms` | number | Memory allocation time (ms) | Khi `memory_kb > 0` |
| `retain_memory_ms` | number | Memory retain overhead (ms) | Khi `retain_memory_kb > 0` |
| `gc_churn_ms` | number | GC churn overhead (ms) | Khi `gc_churn_kb > 0` hoặc `heap_objects > 0` |
| `gzip_ms` | number | Gzip compression time (ms) | Khi `gzip_kb > 0` |
| `disk_ms` | number | Disk I/O time (ms) | Khi `disk_kb > 0` |
| `external_ms` | number | External call time (ms) | Khi `external_ms > 0` |

---

## 3. Vì sao phải test ở DB layer

### 3.1 Không layer nào khác verify được resource_model

- **CDN**: Cache response -- có thể cache response cũ với `resource_model` sai
- **LB**: Không parse response body
- **Microservices**: Verify API contract (`success`, `data`) nhưng không verify `performance` payload
- **Redis**: Không liên quan đến DB metrics

### 3.2 Đây là trust foundation

Nếu `resource_model` sai, mọi DB test case sau đó (db-01 -> db-06) đều đọc sai metrics. Case này establish **trust** vào DB metrics pipeline.

### 3.3 So sánh chi tiết với từng layer

| Khía cạnh | CDN | LB | Microservices | Redis | **DB (case này)** |
| --- | --- | --- | --- | --- | --- |
| **Evidence location** | Response header (`X-Cache`) | Upstream selection log | Response header (`X-Upstream-Service`) | Custom counters (fresh/reuse) | **Response body (`performance`)** |
| **Verify được resource_model?** | Không -- cache có thể stale | Không -- không parse body | Không -- không check `performance` field | Không -- không liên quan DB | **Có -- đây là layer duy nhất** |
| **Verify được breakdown?** | Không | Không | Không | Không | **Có** |
| **Verify được contract input=output?** | Không | Không | Không | Không | **Có** |
| **Bị ảnh hưởng bởi cache?** | Có -- cache hit trả về response cũ | Không | Không | Không | **Phải chạy không CDN** |

### 3.4 Trust chain

```text
                    db-05 (case này)
                         |
                         v
              Xác nhận resource_model đúng
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
       db-01          db-02          db-03
    (delay test)   (pressure)     (fault test)
          |              |              |
          +--------------+--------------+
                         |
                         v
                      db-04
                   (contention)
                         |
                         v
                      db-06
                  (capacity sweep)
```

Mọi case từ db-01 đến db-06 đều đọc `db_ms`, `db_write_ms`, và `resource_model` từ response. Nếu db-05 fail, **toàn bộ chain collapse**.

### 3.5 Tại sao không test ở integration test thông thường?

Integration test thông thường (Go test, pytest) có thể verify API contract. Nhưng:

1. **Không verify được runtime behavior**: Integration test chạy 1 request, không thấy được consistency qua nhiều endpoint.
2. **Không verify được `observed_resource_delta`**: Đây là runtime metric từ Go runtime (`wall_ms`, `heap_alloc_mb_delta`, `gc_cycles_delta`) -- chỉ có được khi service đang chạy thật.
3. **Không verify được `go_sample_available`**: Flag này cho biết Go runtime sampler đã thu thập được sample -- chỉ có ở runtime thật.
4. **Không dùng chung toolchain với các case khác**: db-01 đến db-06 đều dùng k6 -- nếu db-05 pass bằng k6, bạn biết pipeline hoạt động từ đầu đến cuối.

---

## 4. Topology và precondition

### 4.1 Topology

```text
Script: ../app/26-resource-correctness-benchmark.js
Executor: 1 VU, 1 iteration (sequential)
Topology: full-no-cdn
BASE_URL: http://localhost:80 (default)
NO OPS_AUTH_TOKEN needed
```

### 4.2 Stack components tham gia

```text
k6 client (1 VU)
  |
  | HTTP requests (sequential, ~28-35 requests trong 1 iteration)
  |
  v
Nginx (:80)
  |
  +---> products-service (port khác nhau tùy deployment)
  |       |-- GET /api/sim/products*
  |       |-- GET /api/sim/products/:id*
  |       +-- Postgres (đọc products, categories, recommendations)
  |
  +---> order-service
  |       |-- POST /api/sim/checkout
  |       |-- POST /api/sim/orders/:id/confirm
  |       |-- POST /api/sim/orders/webhooks/payment
  |       +-- Postgres (write orders) + payment-mock (external call)
  |
  +---> report-service
  |       |-- GET /api/sim/report
  |       |-- POST /api/sim/report/jobs
  |       +-- Postgres (đọc report data)
  |
  +---> auth-service
  |       |-- POST /api/sim/auth/login
  |       |-- GET /api/sim/auth/me
  |       |-- POST /api/sim/auth/refresh
  |       +-- Postgres (đọc user data) + external auth provider (mock)
  |
  +---> cart-service
          |-- POST /api/sim/cart/add
          |-- GET /api/sim/cart
          |-- GET /api/sim/cart/summary
          |-- PATCH /api/sim/cart/items/:sku
          |-- DELETE /api/sim/cart/items/:sku
          +-- Postgres (đọc/ghi cart data)
```

### 4.3 Precondition

- [x] Stack `full-no-cdn` đang chạy với tất cả service
- [x] Postgres available và có data
- [x] Tất cả service health check pass
- [x] `BASE_URL=http://localhost:80`
- [x] **KHÔNG cần `OPS_AUTH_TOKEN`** (case này chỉ đọc API response, không gọi control plane)
- [x] **KHÔNG có CDN** (CDN cache có thể trả về response với `db_ms` sai)

### 4.4 Tại sao 1 VU, 1 iteration?

```text
Đây là correctness test, không phải load test.

1 VU: đảm bảo request tuần tự, không có race condition.
1 iteration: mỗi endpoint được gọi đúng 1 lần, dễ verify từng response.

Nếu dùng nhiều VU:
  - Không biết response nào tương ứng với request nào (log xen kẽ)
  - Resource model có thể bị ảnh hưởng bởi concurrent requests (connection pool, cache)
  - Khó isolate lỗi của từng endpoint

1 VU + 1 iteration = deterministic test.
```

---

## 5. Script deep-dive

### 5.1 Cấu trúc tổng quan

Script `26-resource-correctness-benchmark.js` được tổ chức thành 5 phần chính:

```text
1. Configuration & metrics (dòng 1-26)
2. Helper functions (dòng 28-206)
3. Compare products (dòng 208-230)
4. Coverage functions (dòng 232-347)
5. Default function (dòng 349-355)
```

### 5.2 Configuration & metrics

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

import { envString } from '../shared/common.js';

const BASE_URL = envString('BASE_URL', 'http://localhost:8088').replace(/\/$/, '');
const RUN_ID = envString('RESOURCE_CORRECTNESS_RUN_ID', `resource-correctness-${Date.now()}`);
const SCENARIO = envString('RESOURCE_CORRECTNESS_SCENARIO', 'resource_correctness');

const failures = new Counter('resource_correctness_failures');
```

Điểm quan trọng:
- **`failures` counter**: Counter duy nhất cho toàn bộ case. Mọi check fail đều increment counter này. Threshold `count==0` đảm bảo không có bất kỳ failure nào.
- **`BASE_URL` default**: `http://localhost:8088` (development) -- được override qua env var khi chạy thật.
- **`RUN_ID`**: Unique per run, dùng làm Authorization header và tag.

```javascript
export const options = {
  vus: 1,
  iterations: 1,
  noConnectionReuse: true,
  thresholds: {
    checks: ['rate==1'],
    resource_correctness_failures: ['count==0'],
    http_req_failed: ['rate==0'],
  },
  tags: {
    scenario: SCENARIO,
    suite: 'resource_correctness',
  },
};
```

Ba threshold bắt buộc:
1. **`checks rate==1`**: Mọi check phải pass -- không có ngoại lệ.
2. **`resource_correctness_failures count==0`**: Counter failure = 0.
3. **`http_req_failed rate==0`**: Không có HTTP error (khác với db-03 nơi 5xx được expected).

`noConnectionReuse: true` đảm bảo mỗi request dùng connection mới -- tránh connection pooling ảnh hưởng đến measurement.

### 5.3 Helper functions -- deep dive

#### 5.3.1 `headers(extra)`

```javascript
function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${RUN_ID}`,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'X-Test-Run-ID': RUN_ID,
    'X-Test-Scenario': SCENARIO,
    ...extra,
  };
}
```

**Tại sao cần `Cache-Control: no-cache` và `Pragma: no-cache`?**
Ngay cả khi không có CDN, browser và proxy cache vẫn có thể cache response. Headers này đảm bảo mỗi request đều đến service thật.

**Tại sao `X-Test-Run-ID` và `X-Test-Scenario`?**
Đây là custom headers để trace request trong log của từng service. Nếu có lỗi, bạn có thể grep log với RUN_ID để tìm chính xác request nào gây lỗi.

#### 5.3.2 `fail(label)`

```javascript
function fail(label) {
  failures.add(1, { label });
  return false;
}
```

Pattern quan trọng: mỗi lần fail, counter được increment với label -- cho phép phân loại failure theo nguyên nhân. Ví dụ: `fail('db_rows')` -> counter tag `label=db_rows`.

#### 5.3.3 `body(response)`, `model(payload)`, `breakdown(payload)`, `observed(payload)`

```javascript
function body(response) {
  try { return response.json(); } catch (_) { return null; }
}

function model(payload) {
  return payload && payload.performance && payload.performance.resource_model
    ? payload.performance.resource_model : {};
}

function breakdown(payload) {
  return payload && payload.performance && payload.performance.breakdown
    ? payload.performance.breakdown : {};
}

function observed(payload) {
  return payload && payload.performance && payload.performance.observed_resource_delta
    ? payload.performance.observed_resource_delta : {};
}
```

Đây là pattern "safe navigation" -- tránh null reference khi response không có `performance` field (ví dụ: 5xx error response). Mỗi hàm trả về empty object `{}` thay vì `null` để code gọi không bị crash.

#### 5.3.4 `expectModel(label, response, expectedStatus, expectedEndpoint, expected)`

Đây là hàm core -- verify contract cho mỗi request. Hàm này thực hiện 3 loại check:

**Common checks (mọi request):**

```javascript
check({ response, payload, m, b, o }, {
  [`${label} status ${expectedStatus}`]: (x) => x.response.status === expectedStatus,
  [`${label} success true`]: (x) => x.payload && x.payload.success === true,
  [`${label} model endpoint ${expectedEndpoint}`]: (x) => x.m.endpoint === expectedEndpoint,
  [`${label} payload bytes present`]: (x) => hasNumber(x.m.payload_bytes) && x.m.payload_bytes > 0,
  [`${label} observed Go sample`]: (x) => x.o.go_sample_available === true,
  [`${label} observed wall ms present`]: (x) => hasNumber(x.o.wall_ms) && x.o.wall_ms >= 0,
});
```

5 checks bắt buộc cho mọi endpoint:
1. **Status code khớp**: `response.status === expectedStatus`
2. **Success flag**: `payload.success === true`
3. **Endpoint name đúng**: `resource_model.endpoint` khớp expected
4. **Payload bytes > 0**: Response không rỗng
5. **Go runtime sample available**: `go_sample_available === true` -- chứng minh service đang collect runtime metrics

**Resource-specific checks (tùy expected resource):**

Với mỗi resource type (`cpu`, `dbRows`, `dbWrites`, `jsonItems`, `memoryKB`, `retainMemoryKB`, `gcChurnKB`, `heapObjects`, `gzipKB`, `diskKB`, `externalMs`), script kiểm tra:

```javascript
// Pattern cho dbRows:
if ('dbRows' in expected) {
  check({ m, b }, {
    [`${label} db rows ${expected.dbRows}`]: (x) => x.m.db_rows === expected.dbRows,
    [`${label} db breakdown matches target presence`]: (x) =>
      expected.dbRows > 0 ? hasNumber(x.b.db_ms) : x.b.db_ms === undefined,
  });
}
```

Hai check cho mỗi resource:
1. **Model value khớp**: `resource_model.db_rows === expected value`
2. **Breakdown presence khớp**: Nếu resource > 0 -> breakdown field phải là number. Nếu resource = 0 -> breakdown field phải absent.

### 5.4 HTTP method wrappers

```javascript
function get(path, label, expectedStatus, expectedEndpoint, expected = {}, extraHeaders = {}) {
  const response = http.get(`${BASE_URL}${path}`, {
    headers: headers(extraHeaders),
    tags: { case: label, endpoint: expectedEndpoint },
  });
  return expectModel(label, response, expectedStatus, expectedEndpoint, expected);
}

function post(path, bodyValue, label, expectedStatus, expectedEndpoint, expected = {}, extraHeaders = {}) {
  const response = http.post(`${BASE_URL}${path}`, JSON.stringify(bodyValue || {}), {
    headers: headers(extraHeaders),
    tags: { case: label, endpoint: expectedEndpoint },
  });
  return expectModel(label, response, expectedStatus, expectedEndpoint, expected);
}
```

Wrapper pattern: mỗi HTTP method có wrapper riêng, tự động:
1. Build full URL từ `BASE_URL` + path
2. Thêm headers chuẩn
3. Set k6 tags (`case`, `endpoint`) để lọc trên dashboard
4. Gọi `expectModel` để verify contract

### 5.5 Compare products -- differential testing

```javascript
function compareProducts() {
  const zero = get('/api/sim/products?...&cpu_ms=0&db_rows=0&json_items=0&...', 'products_zero', ...);
  const light = get('/api/sim/products?...&cpu_ms=1&db_rows=1&json_items=10&...', 'products_light', ...);
  const heavy = get('/api/sim/products?...&cpu_ms=8&db_rows=40&json_items=1000&...', 'products_heavy', ...);

  check({ zero, light, heavy }, {
    'products heavy payload > light payload': (x) =>
      x.heavy.model.payload_bytes > x.light.model.payload_bytes,
    'products heavy synthetic > light synthetic': (x) =>
      x.heavy.model.synthetic_work_bytes > x.light.model.synthetic_work_bytes,
    'products zero has actual payload but no synthetic work': (x) =>
      x.zero.model.payload_bytes > 0 && !x.zero.model.synthetic_work_bytes,
  });
}
```

Đây là **differential testing**: thay vì chỉ verify từng response riêng lẻ, script so sánh 3 mức độ load (zero, light, heavy) để đảm bảo:

1. **Payload tỉ lệ thuận với input**: `heavy.payload_bytes > light.payload_bytes` -- response to hơn khi input lớn hơn.
2. **Synthetic work tỉ lệ thuận**: `synthetic_work_bytes` tăng khi `json_items` tăng.
3. **Zero thực sự là zero**: Khi tất cả input = 0, `synthetic_work_bytes` phải falsy (0 hoặc undefined).

Nếu `heavy.payload_bytes <= light.payload_bytes`, có thể service đang bỏ qua `json_items` param hoặc response bị truncate.

### 5.6 Coverage functions

Script chia endpoints thành 5 nhóm coverage:

| Function | Nhóm | Số endpoints | HTTP methods |
| --- | --- | --- | --- |
| `compareProducts()` | Products (so sánh) | 3 | GET |
| `productsReadCoverage()` | Products (read) | 5 | GET |
| `authCartCoverage()` | Auth + Cart | 9 | GET, POST, PATCH, DELETE |
| `memoryCoverage()` | Memory profile | 3 | GET, POST |
| `orderReportCoverage()` | Order + Report | 8 | GET, POST |

Tổng cộng: khoảng 28 endpoints được test trong 1 iteration.

### 5.7 Default function -- execution flow

```javascript
export default function () {
  compareProducts();        // 3 requests (zero, light, heavy comparison)
  productsReadCoverage();   // 5 requests (detail, categories, search, recommendations, homefeed)
  authCartCoverage();       // 9 requests (login, me, refresh, cart CRUD)
  memoryCoverage();         // 3 requests (memory profile trên products, auth, cart)
  orderReportCoverage();    // ~8 requests (checkout, confirm, webhook, report CRUD)
}
```

Thứ tự gọi có chủ đích:
1. **Compare trước**: Xác nhận differential behavior trước khi test từng endpoint.
2. **Products read**: Endpoint phổ biến nhất, verify db_rows contract.
3. **Auth + Cart**: Read/write mix, verify db_writes + memory_kb contract.
4. **Memory**: Verify memory-specific fields (`retain_memory_kb`, `gc_churn_kb`, `heap_objects`).
5. **Order + Report**: Phức tạp nhất (external call, disk I/O, async job) -- test cuối cùng.

---

## 6. Postgres mechanism: resource_model contract

### 6.1 Query param -> resource_model mapping

```text
Client request:
  GET /api/sim/products?db_rows=120&cpu_ms=8&json_items=100

Server xử lý:
  1. Parse query params: db_rows=120, cpu_ms=8, json_items=100
  2. Thực thi DB query với 120 rows
  3. Build response:
     - data.products (120 items)
     - performance.resource_model.db_rows = 120
     - performance.resource_model.cpu_target_ms = 8
     - performance.resource_model.json_target_items = 100
     - performance.breakdown.db_ms = <actual DB time>
     - performance.breakdown.cpu_ms = <actual CPU time>

Contract:
  resource_model.db_rows PHẢI = query param db_rows
  (không phải số rows thực tế trả về -- mà là số rows được yêu cầu)
```

### 6.2 Tại sao resource_model quan trọng cho capacity planning?

```text
Khi sweep capacity (db-06):
  - db_rows=10  -> db_ms ~2ms  -> RPS cao
  - db_rows=120 -> db_ms ~5ms  -> RPS trung bình
  - db_rows=500 -> db_ms ~20ms -> RPS thấp, có thể drop iteration

Nếu resource_model sai, bạn không thể map db_rows -> db_ms -> capacity limit.
```

### 6.3 Mechanism: làm thế nào service tính `db_ms`?

```text
1. Trước khi query DB:
   - Lấy timestamp T1 (high-resolution monotonic clock)

2. Thực thi DB query:
   - SELECT ... LIMIT {db_rows} (hoặc equivalent tùy endpoint)
   - Postgres driver thực thi và trả về rows

3. Sau khi query:
   - Lấy timestamp T2
   - db_ms = T2 - T1 (đã convert sang milliseconds)

4. Gán vào response:
   - performance.breakdown.db_ms = db_ms
   - performance.resource_model.db_rows = db_rows (từ query param)
```

Service không đo "Postgres server time" -- nó đo **client-side elapsed time** bao gồm:
- Network round-trip (service -> Postgres -> service)
- Postgres query execution
- Result set transfer
- Driver deserialization

Điều này có nghĩa `db_ms` phản ánh **end-to-end DB latency từ góc nhìn của service**, không phải chỉ riêng query execution time trên Postgres server.

### 6.4 `db_round_trips` -- chỉ số ẩn quan trọng

```text
Một request có thể cần nhiều DB query:
  GET /api/sim/products/1?view=full&include_reviews=1

Có thể được implement thành:
  SELECT * FROM products WHERE id = 1;           -- round trip 1
  SELECT * FROM reviews WHERE product_id = 1;    -- round trip 2

resource_model.db_round_trips = 2
```

`db_round_trips` cho biết service đã tối ưu query chưa:
- `db_round_trips=1`: Tốt -- 1 query lấy đủ data (dùng JOIN hoặc subquery)
- `db_round_trips=3+`: Có thể là N+1 query problem -- mỗi row cần 1 query phụ

### 6.5 `observed_resource_delta` -- runtime metrics từ Go

Ngoài `resource_model` và `breakdown`, response còn có `observed_resource_delta`:

```json
{
  "observed_resource_delta": {
    "go_sample_available": true,
    "wall_ms": 4.5,
    "cpu_total_ms_delta": 0.8,
    "rss_mb_delta": 0.12,
    "heap_alloc_mb_delta": 0.69,
    "gc_cycles_delta": 0,
    "goroutines_delta": 2
  }
}
```

Đây là metrics từ Go runtime (sampler), cho biết **thực tế** request này tiêu thụ bao nhiêu tài nguyên hệ thống:

| Field | Ý nghĩa | Dùng cho |
| --- | --- | --- |
| `wall_ms` | Wall-clock time của request này | So sánh với tổng latency |
| `cpu_total_ms_delta` | CPU time tiêu thụ (ms) | Capacity planning CPU |
| `rss_mb_delta` | Resident Set Size change (MB) | Memory leak detection |
| `heap_alloc_mb_delta` | Heap allocation (MB) | GC pressure analysis |
| `gc_cycles_delta` | Số GC cycles | GC tuning |
| `goroutines_delta` | Goroutine count change | Concurrency analysis |

**Tại sao cần cả `resource_model` và `observed_resource_delta`?**

```text
resource_model: "Tôi YÊU CẦU 120 db_rows" (declared)
observed_resource_delta: "Thực tế tiêu thụ 0.69MB heap" (measured)

Nếu resource_model nói db_rows=120 nhưng observed_resource_delta.heap_alloc_mb_delta=0.01,
có thể service đang cache kết quả hoặc không thực sự query 120 rows.
```

Đây là cross-validation: declared vs measured -- nếu chênh lệch lớn, có gì đó sai.

### 6.6 Bottleneck detection mechanism

```text
performance.bottleneck: tên của breakdown field có giá trị lớn nhất

Ví dụ:
  breakdown: { cpu_ms: 2, db_ms: 8, json_ms: 1 }
  -> bottleneck = "db_ms" (vì 8 > 2 và 8 > 1)

  performance.bottleneck_percent = 8 / (2 + 8 + 1) * 100 = 72%
```

Bottleneck rotation là dấu hiệu quan trọng khi sweep capacity (db-06):
- Ở rate thấp: `bottleneck = "cpu_ms"` (CPU là bottleneck chính)
- Ở rate cao: `bottleneck = "db_ms"` (DB trở thành bottleneck khi saturation tăng)

Nếu `bottleneck` không thay đổi dù tăng rate, có thể service chưa bị saturation.

### 6.7 Zero-value semantics

```text
Khi db_rows=0:
  - resource_model.db_rows = 0 (vẫn present, giá trị 0)
  - breakdown.db_ms = undefined (absent -- không có DB query nào được thực thi)

Khi db_writes=0:
  - resource_model.db_writes = 0
  - breakdown.db_write_ms = undefined
```

Đây là điểm tinh tế: `resource_model` field luôn present (dù giá trị = 0), nhưng `breakdown` field chỉ present khi thực sự có work. Script verify chính xác behavior này:

```javascript
// dbRows == 0 -> db_ms phải absent
expected.dbRows > 0 ? hasNumber(x.b.db_ms) : x.b.db_ms === undefined
```

---

## 7. Request sequence flow

### 7.1 Full sequence (28+ requests)

```text
=== PHASE 1: COMPARE PRODUCTS (3 requests) ===

1.  GET /api/sim/products?cpu_ms=0&db_rows=0&json_items=0&limit=5&resource_case=zero
    -> verify resource_model: cpu=0, dbRows=0, jsonItems=0
    -> verify: zero request có payload_bytes > 0 nhưng synthetic_work_bytes falsy

2.  GET /api/sim/products?cpu_ms=1&db_rows=1&json_items=10&limit=5&view=compact&resource_case=light
    -> verify resource_model: cpu=1, dbRows=1, jsonItems=10

3.  GET /api/sim/products?cpu_ms=8&db_rows=40&json_items=1000&limit=20&view=full&include_facets=1&resource_case=heavy
    -> verify resource_model: cpu=8, dbRows=40, jsonItems=1000
    -> verify: heavy.payload_bytes > light.payload_bytes
    -> verify: heavy.synthetic_work_bytes > light.synthetic_work_bytes

=== PHASE 2: PRODUCTS READ COVERAGE (5 requests) ===

4.  GET /api/sim/products/1?cpu_ms=1&db_rows=1&json_items=8&view=full&include_reviews=1
    -> verify resource_model: endpoint=products_detail

5.  GET /api/sim/products/categories?cpu_ms=1&db_rows=1&json_items=8
    -> verify resource_model: endpoint=products_categories

6.  GET /api/sim/products/search?q=running+shoe&cpu_ms=1&db_rows=1&json_items=8&limit=4&include_facets=1
    -> verify resource_model: endpoint=products_search

7.  GET /api/sim/products/1/recommendations?cpu_ms=1&db_rows=1&json_items=8&limit=4&context_depth=8&algorithm=personalized
    -> verify resource_model: endpoint=products_recommendations

8.  GET /api/sim/products/homefeed?cpu_ms=1&db_rows=1&json_items=8&gzip_kb=1&blocks=3&personalized=1
    -> Header: X-User-Segment: returning
    -> verify resource_model: gzip_kb=1

=== PHASE 3: AUTH + CART COVERAGE (9 requests) ===

9.  POST /api/sim/auth/login?cpu_ms=1&db_rows=1
    Body: {}
    -> verify resource_model: cpu=1, dbRows=1

10. GET /api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4
    -> verify resource_model: memoryKB=4

11. POST /api/sim/auth/refresh?cpu_ms=1&db_rows=1&external_ms=1
    Body: {}
    -> verify resource_model: externalMs=1

12. POST /api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4
    Body: { product_id: 1, quantity: 1 }
    -> verify resource_model: dbWrites=1, memoryKB=4

13. GET /api/sim/cart?cpu_ms=1&db_rows=1
    -> verify resource_model: dbRows=1

14. GET /api/sim/cart/summary?cpu_ms=1&db_rows=1&json_items=8
    -> verify resource_model: jsonItems=8

15. PATCH /api/sim/cart/items/sku-1?cpu_ms=1&db_writes=1
    Body: { quantity: 2 }
    -> verify resource_model: dbWrites=1

16. DELETE /api/sim/cart/items/sku-1?cpu_ms=1&db_writes=1
    -> verify resource_model: dbWrites=1

17. (sau delete, cart items đã được dọn)

=== PHASE 4: MEMORY COVERAGE (3 requests) ===

18. GET /api/sim/products?cpu_ms=0&db_rows=0&json_items=0&memory_kb=4&retain_memory_kb=256
    &gc_churn_kb=128&heap_objects=256&limit=5&resource_case=memory
    -> verify resource_model: memoryKB=4, retainMemoryKB=256, gcChurnKB=128, heapObjects=256
    -> verify: breakdown.memory_ms, breakdown.retain_memory_ms, breakdown.gc_churn_ms
    -> verify: observed_resource_delta.heap_alloc_mb_delta (retain memory check)

19. GET /api/sim/auth/me?cpu_ms=0&db_rows=0&memory_kb=4&retain_memory_kb=512
    &gc_churn_kb=256&heap_objects=512
    -> verify resource_model: memoryKB=4, retainMemoryKB=512, gcChurnKB=256, heapObjects=512

20. POST /api/sim/cart/add?cpu_ms=0&db_writes=0&memory_kb=4&retain_memory_kb=256
    &gc_churn_kb=128&heap_objects=256
    Body: { product_id: 1, quantity: 1 }
    -> verify resource_model: memoryKB=4, retainMemoryKB=256

=== PHASE 5: ORDER + REPORT COVERAGE (~8 requests) ===

21. POST /api/sim/checkout?cpu_ms=1&db_writes=1&disk_kb=1&external_ms=1&external_fail_rate=0
    Body: { payment_method: 'card', item_count: 2, shipping_method: 'express' }
    -> verify resource_model: dbWrites=1, diskKB=1, externalMs=1

22. GET /api/sim/orders/{orderId}?cpu_ms=1&db_rows=1&view=full&include_history=1
    -> verify resource_model: dbRows=1
    -> verify: orderId từ bước 21 khớp

23. POST /api/sim/orders/{orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=1&external_fail_rate=0
    Header: Idempotency-Key: idem-{orderId}
    Body: {}
    -> verify resource_model: dbWrites=1, externalMs=1

24. POST /api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=1
    Body: { event_type: 'payment.captured', event_id: 'evt-{orderId}', order_id: orderId }
    -> verify resource_model: dbWrites=1

25. GET /api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1
    -> verify resource_model: gzipKB=1

26. POST /api/sim/report/jobs?cpu_ms=1&db_rows=1&gzip_kb=1&ready_after_ms=1
    Body: { report_type: 'sales' }
    -> Expect: 202 (async job accepted)
    -> verify resource_model: gzipKB=1

27. GET /api/sim/report/jobs?limit=5&cpu_ms=1&db_rows=1
    -> verify resource_model: dbRows=1

28. GET /api/sim/report/jobs/{jobId}?cpu_ms=1&db_rows=1 (nếu jobId tồn tại)
    -> verify resource_model: dbRows=1

29. GET /api/sim/report/jobs/{jobId}/download?cpu_ms=1 (nếu jobId tồn tại)
    -> Expect: 200 hoặc 202 (tùy job đã ready chưa)
    -> verify resource_model: cpu=1
```

### 7.2 Sequence properties

```text
Tổng requests: ~28-35 (tùy report job availability)
Tổng checks per run: ~150-355 (mỗi request có 5 common checks + N resource checks)
Thời gian chạy: ~2-5 giây (sequential, no sleep giữa các request ngoại trừ report job)
Success rate yêu cầu: 100% (checks rate=1, http_req_failed rate=0)
```

---

## 8. Key signals

### 8.1 Primary signals (k6 built-in)

| Signal | Expected | Nếu sai |
| --- | --- | --- |
| `checks` | 100% (rate=1) | Có ít nhất 1 check fail -> xem `resource_correctness_failures` label |
| `http_req_failed` | 0% (rate=0) | Có request bị HTTP error -> kiểm tra service health |
| `http_req_duration` | avg ~5-6ms, p95 ~20ms | Bất thường nếu p95 > 100ms (có thể DB chậm) |
| `iterations` | 1 | Nếu > 1, script bị chạy nhiều lần |

### 8.2 Custom signals

| Signal | Type | Expected | Ý nghĩa |
| --- | --- | --- | --- |
| `resource_correctness_failures` | Counter | 0 | Tổng số contract violations |
| `resource_correctness_failures{label="db_rows"}` | Counter tag | 0 | `db_rows` mismatch |
| `resource_correctness_failures{label="db_writes"}` | Counter tag | 0 | `db_writes` mismatch |
| `resource_correctness_failures{label="db_breakdown"}` | Counter tag | 0 | `db_ms` missing khi db_rows > 0 |
| `resource_correctness_failures{label="db_write_breakdown"}` | Counter tag | 0 | `db_write_ms` missing khi db_writes > 0 |

### 8.3 Response body signals

| Signal | Source | Expected |
| --- | --- | --- |
| `resource_model.db_rows` | Response body | Khớp query param `?db_rows=N` |
| `resource_model.db_writes` | Response body | Khớp query param `?db_writes=N` |
| `breakdown.db_ms` | Response body | Present (number) khi `db_rows > 0` |
| `breakdown.db_write_ms` | Response body | Present (number) khi `db_writes > 0` |
| `performance.bottleneck` | Response body | Present (string) |
| `observed_resource_delta.go_sample_available` | Response body | `true` |
| `observed_resource_delta.wall_ms` | Response body | >= 0 (number) |

### 8.4 Differential signals (compareProducts)

| Signal | Expected |
| --- | --- |
| `heavy.payload_bytes > light.payload_bytes` | True -- response to hơn khi input lớn hơn |
| `heavy.synthetic_work_bytes > light.synthetic_work_bytes` | True -- synthetic work tỉ lệ thuận với json_items |
| `zero.synthetic_work_bytes` | Falsy (0 hoặc undefined) -- không có synthetic work khi input = 0 |

### 8.5 Cách đọc signals trên dashboard

```text
Dashboard (http://localhost:13001/):
  1. Chọn run # (VD: #116)
  2. Tab "Checks" -> checks rate phải = 100%
  3. Tab "HTTP" -> http_req_failed = 0%
  4. Custom metrics -> resource_correctness_failures = 0
  5. Nếu có failure, xem tag "label" để biết nguyên nhân
```

---

## 9. Pass/fail criteria

### 9.1 Pass

```text
✅ resource_correctness_failures = 0
✅ checks rate = 100%
✅ http_req_failed = 0%
✅ Mọi response có db_rows -> breakdown.db_ms present
✅ Mọi response có db_writes -> breakdown.db_write_ms present
✅ resource_model khớp query params trên mọi endpoint
✅ go_sample_available = true trên mọi response
✅ heavy.payload_bytes > light.payload_bytes (differential)
✅ heavy.synthetic_work_bytes > light.synthetic_work_bytes (differential)
```

### 9.2 Fail modes chi tiết

| Mode | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| **db_rows mismatch** | `resource_model.db_rows=145` nhưng query param `db_rows=60` | Service merge query hoặc caching logic sai | Kiểm tra query builder, đảm bảo `resource_model.db_rows` lấy từ query param, không phải từ actual row count |
| **db_ms missing** | `typeof breakdown.db_ms !== 'number'` khi `db_rows > 0` | Service không measure DB time hoặc field name sai | Thêm DB time measurement, kiểm tra performance middleware |
| **db_write_ms missing** | `typeof breakdown.db_write_ms !== 'number'` khi `db_writes > 0` | Write path không có timing | Thêm write time measurement |
| **go_sample_available = false** | `observed_resource_delta.go_sample_available !== true` | Go runtime sampler không hoạt động | Kiểm tra sampler initialization |
| **bottleneck missing** | `!performance.bottleneck` | Performance middleware không tính bottleneck | Kiểm tra bottleneck calculation logic |
| **Zero response có synthetic_work_bytes** | `synthetic_work_bytes > 0` khi tất cả input = 0 | Service luôn sinh synthetic work dù input = 0 | Kiểm tra điều kiện synthetic work generation |
| **Heavy payload <= light payload** | Response size không tăng khi input tăng | Service giới hạn response size hoặc query param bị bỏ qua | Kiểm tra response builder, verify query param được parse đúng |

### 9.3 Severity classification

```text
CRITICAL (chặn mọi case khác):
  - db_ms missing trên read endpoints
  - db_write_ms missing trên write endpoints
  - resource_model.db_rows sai

HIGH (ảnh hưởng capacity planning):
  - db_rows mismatch
  - db_writes mismatch
  - bottleneck missing

MEDIUM (ảnh hưởng differential analysis):
  - Heavy payload <= light payload
  - go_sample_available = false

LOW (cosmetic):
  - endpoint name sai (không ảnh hưởng measurement)
```

---

## 10. Cách chạy + output mẫu

### 10.1 Local run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RESOURCE_CORRECTNESS_RUN_ID = "db-05-test"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

### 10.2 Development run (không cần stack đầy đủ)

```powershell
# Dùng default BASE_URL (http://localhost:8088)
$env:RESOURCE_CORRECTNESS_RUN_ID = "db-05-dev"

k6 run E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

### 10.3 Run với custom scenario tag

```powershell
$env:RESOURCE_CORRECTNESS_SCENARIO = "pre_deploy_smoke"
$env:BASE_URL = "http://localhost:80"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

### 10.4 Output mẫu (Run #116)

```text
execution: local
   output: cloud (https://app.k6.io/runs/116)

 █ THRESHOLDS
   checks                         ✓ 'rate==1' rate=100.00%
   resource_correctness_failures  ✓ 'count==0' count=0
   http_req_failed                ✓ 'rate==0' rate=0.00%

 █ TOTAL RESULTS
   checks_total.......: 355
   checks_succeeded...: 100% 355 out of 355
   checks_failed......: 0.00% 0 out of 355

   ✓ products_zero status 200
   ✓ products_zero success true
   ✓ products_zero model endpoint products_list
   ✓ products_zero payload bytes present
   ✓ products_zero observed Go sample
   ✓ products_zero observed wall ms present
   ... (~350 more checks, all passed)

   CUSTOM
   resource_correctness_failures.....: 0

   HTTP
   http_reqs.........................: 28
   http_req_failed...................: 0.00% 0 out of 28
   http_req_duration.................: avg=5.6ms med=2.7ms p(95)=20.5ms

running (00m02.8s), 1/1 VUs, 1 complete and 0 interrupted iterations
```

### 10.5 Output khi có failure (minh họa)

```text
 ✗ products_heavy db rows 40
   ↳  98% — expected 40, got 145
 ✗ products_heavy db breakdown matches target presence
   ↳  98% — expected db_ms to be present

 █ THRESHOLDS
   checks                         ✗ 'rate==1' rate=98.50%
   resource_correctness_failures  ✗ 'count==0' count=2
   http_req_failed                ✓ 'rate==0' rate=0.00%

   CUSTOM
   resource_correctness_failures.....: 2
     (label=db_rows: 1, label=db_breakdown: 1)
```

---

## 11. 4 output -> decision scenarios

### Scenario A: Tất cả pass

```text
✅ checks=100%, http_fail=0%, failures=0
✅ resource_model khớp query params trên mọi endpoint
✅ breakdown fields present trên mọi endpoint
✅ differential checks pass

-> DB metrics pipeline đáng tin.
-> Tiếp tục db-01 (DB delay recovery).
```

### Scenario B: `resource_model.db_rows` sai

```text
❌ resource_correctness_failures > 0, label=db_rows
❌ Một hoặc nhiều endpoint report db_rows khác với query param

-> CONTRACT VIOLATION -- service không report đúng input.
-> Không thể tin tưởng DB metrics cho capacity planning.
-> Cần fix BE trước khi tiếp tục.

Điều tra:
  1. Kiểm tra endpoint nào bị sai (xem label tag của failures)
  2. Inspect response body của endpoint đó:
     curl "http://localhost:80/api/sim/products?db_rows=60" | jq '.performance.resource_model'
  3. So sánh resource_model.db_rows với query param db_rows
  4. Kiểm tra code: resource_model.db_rows được set từ query param hay từ len(rows)?
  5. Nếu sai tất cả endpoint -> vấn đề ở performance middleware chung
  6. Nếu chỉ sai 1 endpoint -> vấn đề ở handler của endpoint đó
```

### Scenario C: `breakdown.db_ms` missing

```text
❌ resource_correctness_failures > 0, label=db_breakdown
❌ db_rows > 0 nhưng breakdown.db_ms không phải number

-> Read path không expose DB time.
-> db-01, db-02, db-06 không thể verify được.

Điều tra:
  1. Kiểm tra endpoint nào thiếu db_ms
  2. Xác nhận query param có db_rows > 0
  3. Kiểm tra performance middleware: có measure DB query time không?
  4. Kiểm tra field name: có phải "db_ms" không (không phải "dbMs" hay "db_time_ms")?
  5. Nếu tất cả endpoint thiếu -> DB time measurement chưa được implement
  6. Nếu chỉ read endpoint thiếu -> DB read path không có timing wrapper
```

### Scenario D: `breakdown.db_write_ms` missing

```text
❌ resource_correctness_failures > 0, label=db_write_breakdown
❌ db_writes > 0 nhưng breakdown.db_write_ms không phải number

-> Write path không expose DB write time.
-> db-01 (checkout trong delay phase) không verify được write impact.

Điều tra:
  1. Kiểm tra endpoint nào thiếu db_write_ms
  2. Write endpoints: checkout, confirm, cart add/update/delete, payment webhook
  3. Kiểm tra DB write path: có measure thời gian INSERT/UPDATE/DELETE không?
  4. Phân biệt db_ms (read) và db_write_ms (write) -- đây là 2 field khác nhau
```

### Scenario E: `go_sample_available = false`

```text
❌ resource_correctness_failures > 0, label=go_sample
❌ observed_resource_delta.go_sample_available !== true

-> Go runtime sampler không thu thập được sample.
-> observed_resource_delta metrics (wall_ms, heap_alloc_mb_delta, ...) không đáng tin.

Điều tra:
  1. Kiểm tra service được build với Go version nào (sampler cần Go 1.19+)
  2. Kiểm tra sampler initialization trong service code
  3. Có thể sampler bị disable qua config
  4. Nếu service chạy trong container, kiểm tra container resource limit (có thể ảnh hưởng sampler)
```

### Scenario F: Differential checks fail

```text
❌ heavy.payload_bytes <= light.payload_bytes

-> Service không phản ánh đúng input load vào response size.
-> Có thể service có response size limit hoặc query param bị parse sai.

Điều tra:
  1. So sánh response body của light và heavy request
  2. Đếm số lượng items trong data array
  3. Kiểm tra json_items query param có được parse đúng không
  4. Kiểm tra view=full có trả về nhiều field hơn view=compact không
```

---

## 12. Nghịch lý / misconceptions

### Nghịch lý 1: "resource_model.db_rows = số rows thực tế"

```text
SAI. resource_model.db_rows = số rows ĐƯỢC YÊU CẦU (query param).
Nếu query param db_rows=60 nhưng DB chỉ có 30 rows,
resource_model.db_rows vẫn = 60.
```

Tại sao lại thiết kế như vậy? Vì capacity planning cần biết **intended load**, không phải actual rows. Nếu bạn muốn biết "hệ thống chịu được bao nhiêu request 60-row mỗi giây", bạn cần resource_model báo 60 -- ngay cả khi DB hiện tại chỉ có 30 rows. Nếu resource_model báo 30, bạn sẽ underestimate capacity cần thiết khi DB có đủ 60 rows.

### Nghịch lý 2: "Case này quá đơn giản -- bỏ qua được"

```text
SAI. Đây là sanity check quan trọng nhất.
Nếu bỏ qua, mọi DB metric trong case sau có thể là rác.
```

Tương tự như kiểm tra "cân có về 0 không" trước khi cân hàng -- nếu cân sai, mọi phép đo sau đó đều sai. db-05 là "zero calibration" cho toàn bộ DB metrics pipeline.

### Nghịch lý 3: "Chỉ cần test 1-2 endpoint là đủ"

```text
SAI. Mỗi service có thể implement performance middleware khác nhau.
Products service có thể report đúng nhưng Order service có thể sai.
Cần test TẤT CẢ endpoint để đảm bảo consistency.
```

Script test 28+ endpoints trên 5 service (products, auth, cart, order, report) chính vì lý do này. Một service report sai là đủ để làm hỏng capacity analysis cho service đó.

### Nghịch lý 4: "breakdown field luôn present khi resource > 0"

```text
KHÔNG HẲN. Breakdown field chỉ present nếu service ĐO ĐƯỢC thời gian thực thi.
Nếu query thực thi quá nhanh (< 1 microsecond), timer có thể không capture được.
Nhưng với resource > 0, timer LUÔN capture được trong thực tế.
```

Đây là lý do script dùng `hasNumber()` thay vì `> 0` -- giá trị `db_ms = 0` vẫn hợp lệ (query cực nhanh), nhưng `undefined` thì không.

### Nghịch lý 5: "1 VU là quá ít -- cần load test"

```text
SAI. Đây là correctness test, không phải load test.
Thêm VUs chỉ làm nhiễu kết quả (race condition, connection pool reuse)
mà không tăng confidence về correctness.
```

Nếu bạn muốn load test DB, đó là db-06 (capacity sweep). db-05 có mục đích khác: xác nhận contract đúng ở mức cơ bản nhất.

### Nghịch lý 6: "Case này chỉ test DB -- không liên quan memory/CPU"

```text
SAI. Case này test TOÀN BỘ resource_model contract, bao gồm:
  - DB: db_rows, db_writes, db_round_trips
  - CPU: cpu_target_ms
  - JSON: json_target_items
  - Memory: memory_kb, retain_memory_kb, gc_churn_kb, heap_objects
  - I/O: disk_kb, gzip_kb
  - External: external_target_ms

Tất cả đều là resource -- DB chỉ là một phần trong resource model.
```

Tuy case này nằm trong DB layer, scope của nó rộng hơn: verify toàn bộ performance payload contract cho mọi loại resource.

---

## 13. Checklist

### Pre-run

- [ ] Stack `full-no-cdn` đang chạy
- [ ] Tất cả service health check pass (products, auth, cart, order, report)
- [ ] Postgres available
- [ ] **Không cần OPS_AUTH_TOKEN**
- [ ] Đã set `BASE_URL` (mặc định: `http://localhost:80`)
- [ ] Đã set `RESOURCE_CORRECTNESS_RUN_ID` (tùy chọn -- để trace)

### Post-run verification

- [ ] `checks rate = 100%`
- [ ] `http_req_failed rate = 0%`
- [ ] `resource_correctness_failures = 0`
- [ ] Tất cả endpoints verified (~28 requests)
- [ ] `db_ms` present trên read endpoints
- [ ] `db_write_ms` present trên write endpoints
- [ ] `go_sample_available = true` trên mọi response
- [ ] Differential checks pass (heavy > light)
- [ ] `performance.bottleneck` present trên mọi response

### Nếu có failure

- [ ] Xem `resource_correctness_failures` label để biết nguyên nhân
- [ ] Inspect response body của endpoint bị fail
- [ ] So sánh query param với resource_model trong response
- [ ] Kiểm tra log của service tương ứng (grep với RUN_ID)
- [ ] Fix BE trước khi chạy lại

---

## 14. 5 Variations

### Variation 1: Chỉ test read path

Sửa script để chỉ gọi `compareProducts()` và `productsReadCoverage()` -- bỏ qua auth, cart, order, report. Hữu ích khi chỉ products service được deploy.

```javascript
export default function () {
  compareProducts();
  productsReadCoverage();
  // authCartCoverage();     -- skip
  // memoryCoverage();       -- skip
  // orderReportCoverage();  -- skip
}
```

Kết quả mong đợi: ~8 requests, checks vẫn 100% cho read path.

### Variation 2: Tăng db_rows cực đoan

Test với giá trị `db_rows` rất lớn để verify contract không bị break ở extreme values:

```powershell
# Sửa script: thay db_rows=40 thành db_rows=1000 trong compareProducts heavy
$env:BASE_URL = "http://localhost:80"
k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/26-resource-correctness-benchmark.js
```

Điểm cần quan sát:
- `resource_model.db_rows` vẫn = 1000 (không bị clamp)
- `breakdown.db_ms` tăng theo (query nhiều rows hơn -> chậm hơn)
- Response vẫn 200 (không timeout)

### Variation 3: So sánh pre-post deploy

Chạy case này trước và sau mỗi lần deploy để detect regression:

```powershell
# Pre-deploy
$env:RESOURCE_CORRECTNESS_RUN_ID = "pre-deploy-$(git rev-parse --short HEAD)"
k6 run -o cloud ... > pre-deploy-output.txt

# Deploy
# ... deploy new version ...

# Post-deploy
$env:RESOURCE_CORRECTNESS_RUN_ID = "post-deploy-$(git rev-parse --short HEAD)"
k6 run -o cloud ... > post-deploy-output.txt

# So sánh
diff pre-deploy-output.txt post-deploy-output.txt
```

Nếu post-deploy có failure mà pre-deploy không có -> regression.

### Variation 4: Test với memory profile khác nhau

Chạy riêng `memoryCoverage()` với các giá trị memory khác nhau để verify memory contract:

```javascript
// Thêm test case mới:
const memLight = get('/api/sim/products?...&memory_kb=4&retain_memory_kb=64&...');
const memHeavy = get('/api/sim/products?...&memory_kb=256&retain_memory_kb=4096&...');

check({ memLight, memHeavy }, {
  'mem heavy heap delta > light heap delta': (x) =>
    x.memHeavy.observed.heap_alloc_mb_delta > x.memLight.observed.heap_alloc_mb_delta,
});
```

### Variation 5: Test external call contract riêng

Tập trung vào order service để verify `external_ms` contract:

```javascript
// Gọi checkout với external_ms khác nhau
const ext0 = post('/api/sim/checkout?...&external_ms=0&...');
const ext30 = post('/api/sim/checkout?...&external_ms=30&...');
const ext100 = post('/api/sim/checkout?...&external_ms=100&...');

check({ ext0, ext30, ext100 }, {
  'external 30 slower than 0': (x) =>
    x.ext30.breakdown.external_ms > x.ext0.breakdown.external_ms,
  'external 100 slower than 30': (x) =>
    x.ext100.breakdown.external_ms > x.ext30.breakdown.external_ms,
  'external 0 has no external breakdown': (x) =>
    x.ext0.breakdown.external_ms === undefined,
});
```

---

## 15. Anti-patterns

| Anti-pattern | Hậu quả | Cách tránh |
| --- | --- | --- |
| **Bỏ qua case này** | Không biết DB metrics có đáng tin không -- mọi case sau có thể dùng data rác | Luôn chạy db-05 đầu tiên trong DB layer |
| **Không check `db_write_ms`** | Bỏ sót write path contract -- không biết write endpoint có expose metrics không | Verify cả read và write path |
| **Chạy với CDN** | CDN cache response -> `db_ms` bị cache từ request trước -> có thể thấy `db_ms` của request cũ | Luôn dùng profile `full-no-cdn` |
| **Chỉ test 1-2 endpoint** | Bỏ sót inconsistency giữa các service -- products có thể đúng nhưng cart có thể sai | Test tất cả endpoint groups |
| **Không check `go_sample_available`** | Không biết runtime sampler có hoạt động không -> `observed_resource_delta` có thể là dữ liệu cũ hoặc rỗng | Verify `go_sample_available === true` |
| **Không check differential** | Không phát hiện được service bỏ qua query param -- response size giống nhau dù input khác nhau | Luôn include compareProducts pattern |
| **Dùng nhiều VU** | Race condition, log xen kẽ, khó isolate failure | Luôn dùng 1 VU cho correctness test |
| **Không set `Cache-Control: no-cache`** | Browser/proxy cache trả về response cũ | Luôn include cache-control headers |
| **Aggregate checks mà không phân loại** | Chỉ biết "có failure" nhưng không biết failure loại gì | Dùng label tag trên failure counter |
| **Chạy xong không inspect từng response** | Chỉ nhìn checks rate, bỏ qua pattern failure | Nếu có failure, inspect response body của endpoint bị fail |

---

## 16. Real validation data

### Run #116 (2026-06-25) -- PASS

```json
{
  "run_id": "116",
  "date": "2026-06-25",
  "status": "PASS",
  "checks_passes": 355,
  "checks_fails": 0,
  "checks_rate": 1.0,
  "http_req_failed_rate": 0,
  "http_reqs": 28,
  "iterations": 1,
  "vus": 1,
  "vus_max": 1,
  "http_req_duration_avg": 5.6,
  "http_req_duration_med": 2.7,
  "http_req_duration_p95": 20.5,
  "http_req_duration_max": 22.1,
  "resource_correctness_failures": 0
}
```

### Run #116 -- Request breakdown theo endpoint group

| Group | Requests | Avg latency | P95 latency | Notes |
| --- | ---: | ---: | ---: | --- |
| Products compare | 3 | 5.2ms | 6.1ms | zero/light/heavy |
| Products read | 5 | 4.1ms | 5.3ms | detail, categories, search, recommendations, homefeed |
| Auth | 3 | 3.8ms | 4.2ms | login, me, refresh |
| Cart | 5 | 3.5ms | 4.0ms | add, view, summary, update, delete |
| Memory profile | 3 | 6.2ms | 8.1ms | products, auth, cart memory |
| Order + Report | 9 | 8.5ms | 20.5ms | checkout (external call), confirm, report jobs |
| **Total** | **28** | **5.6ms** | **20.5ms** | |

### Run #116 -- Resource model verification (sample)

| Endpoint | db_rows param | resource_model.db_rows | Match |
| --- | ---: | ---: | --- |
| products (zero) | 0 | 0 | Yes |
| products (light) | 1 | 1 | Yes |
| products (heavy) | 40 | 40 | Yes |
| products detail | 1 | 1 | Yes |
| products search | 1 | 1 | Yes |
| auth me | 1 | 1 | Yes |
| cart view | 1 | 1 | Yes |
| order status | 1 | 1 | Yes |
| report | 1 | 1 | Yes |

| Endpoint | db_writes param | resource_model.db_writes | Match |
| --- | ---: | ---: | --- |
| checkout | 1 | 1 | Yes |
| order confirm | 1 | 1 | Yes |
| payment webhook | 1 | 1 | Yes |
| cart add | 1 | 1 | Yes |
| cart update | 1 | 1 | Yes |
| cart delete | 1 | 1 | Yes |

### Run #116 -- Bottleneck distribution

| Bottleneck | Count | % | Notes |
| --- | ---: | ---: | --- |
| `cpu_ms` | 18 | 64% | CPU bottleneck trên hầu hết request nhẹ |
| `db_ms` | 8 | 29% | DB bottleneck trên request có db_rows > 0 |
| `json_ms` | 2 | 7% | JSON bottleneck trên heavy products (json_items=1000) |

### Dashboard chart observations

```text
http_req_duration: phân bố tập trung ở 2-8ms, với outlier ở ~20ms (checkout external call)
Không có spike bất thường -- đồ thị phẳng, đúng như mong đợi cho sequential test
```

---

## 17. Reference

- **Script**: `k6/app/26-resource-correctness-benchmark.js`
- **Catalog**: `k6/db/case-catalog.json` -> case `db-05-resource-db-correctness`
- **Dashboard**: `http://localhost:13001/` -> run #116
- **Next case**: db-01 (DB delay recovery)
- **Overview**: `docs/practice/db/00_overview.md`
- **Related cases**:
  - db-01: DB delay recovery (dùng `db_ms` verified từ case này)
  - db-02: DB pressure recovery (dùng `db_ms` + `db_write_ms`)
  - db-06: Capacity sweep (dùng `resource_model` để map db_rows -> db_ms -> capacity)
- **Performance payload spec**: `performance.breakdown` và `performance.resource_model` trong mọi API response
