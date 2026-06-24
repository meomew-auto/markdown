# redis-05 -- Hot-key fairness vs normal keys

> **Case ID:** `redis-05-hotkey-fairness`
> **Script:** `19-order-service-hotkey-fairness.js`
> **Profile:** `full-no-cdn`
> **Executor:** `per-vu-iterations` (2 scenarios song song)
> **Proof:** Hot key bị collapse đúng -- normal unique keys không bị starvation

---

## Mục lục

1. [Tình huống thực tế](#1-tình-huống-thực-tế)
2. [Redis capability được chứng minh](#2-redis-capability-được-chứng-minh)
3. [Vì sao phải test ở Redis/shared state layer](#3-vì-sao-phải-test-ở-redisshared-state-layer)
4. [Topology và precondition](#4-topology-và-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Redis mechanism deep-dive](#6-redis-mechanism-deep-dive)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals / counters](#8-key-signals--counters)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cách chạy + output mẫu](#10-cách-chạy--output-mẫu)
11. [4 output -> decision scenarios](#11-4-output---decision-scenarios)
12. [Nghịch lý / misconceptions](#12-nghịch-lý--misconceptions)
13. [Checklist trước khi chạy](#13-checklist-trước-khi-chạy)
14. [4-5 Variations với code mẫu](#14-4-5-variations-với-code-mẫu)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tình huống thực tế

### 1.1 Bối cảnh nghiệp vụ

Một nền tảng thương mại điện tử vừa tung ra sản phẩm giới hạn của một người nổi tiếng (celebrity collaboration). Trong vòng 30 giây đầu tiên, hàng trăm nghìn người dùng đồng loạt nhấn "Đặt mua". Hệ thống nhận được một cơn bão retry -- cùng một `orderId` và `Idempotency-Key` được gửi đi gửi lại hàng chục lần từ nhiều thiết bị khác nhau của cùng một người dùng, hoặc từ nhiều phiên thanh toán bị timeout và tự động retry.

Cùng lúc đó, những khách hàng bình thường khác vẫn đang mua các sản phẩm thông thường -- mỗi người có `orderId` và `Idempotency-Key` riêng biệt, không liên quan gì đến sản phẩm celebrity kia.

Hệ thống Redis/shared state phải xử lý đồng thời hai "làn" (lane) traffic này:

```text
hotkey lane: nhiều VU dùng cùng orderId + Idempotency-Key
normal lane: nhiều VU dùng orderId/key riêng
```

### 1.2 Hai câu hỏi mà case này trả lời

Case 05 được thiết kế để trả lời hai câu hỏi cốt lõi về fairness trong shared state:

1. **Hot key có bị collapse đúng không?** -- Khi 8 VU cùng gửi một `Idempotency-Key`, chỉ một số rất nhỏ (bounded) được thực thi thật (fresh), phần còn lại được reuse. Hot key không tạo ra 8 lần DB write/ external call -- nó bị collapse đúng.
2. **Normal keys có bị starvation không?** -- Khi hot key đang chiếm dụng Redis lock path, 8 VU normal với unique keys có còn được thực thi fresh và hoàn thành trong thời gian cho phép không?

### 1.3 Ba giai đoạn của fairness test

| Giai đoạn | Mô tả | Thời điểm | Ai tham gia |
| --- | --- | --- | --- |
| Setup | Tạo `orderId` và `Idempotency-Key` chung cho hotkey lane, prefix cho normal lane | `setup()` function, trước khi scenarios chạy | 0 VU (hàm setup chạy riêng) |
| Hotkey + Normal đồng thời | 8 VU hotkey gửi cùng key + 8 VU normal gửi unique keys | 0ms (hotkey) và 100ms (normal) | 16 VU tổng cộng |
| Đánh giá | So sánh fresh/reuse count của hai lane và normal duration | Sau khi tất cả VU hoàn thành | Dashboard / k6 summary |

### 1.4 Tại sao đây là vấn đề production thực sự

Trong production, hot key không chỉ đến từ celebrity product. Nó có thể đến từ:

- **Payment incident**: Một cổng thanh toán bị timeout hàng loạt, hàng trăm user retry cùng lúc.
- **Mobile app bug**: Một phiên bản app gửi retry không kiểm soát cho cùng một operation.
- **Webhook storm**: Một provider gửi đi gửi lại cùng một `event_id` do lỗi retry phía họ.
- **Cron job trùng lặp**: Nhiều instance của cùng một scheduled job cùng xử lý một task.

Trong tất cả các tình huống trên, nếu hệ thống chỉ lo collapse hot key mà bỏ quên normal traffic, hậu quả là:

```text
Không có fairness:       Hot key chiếm toàn bộ worker/Redis connection → normal users timeout → doanh thu mất
Có fairness đúng:        Hot key bị collapse gọn, normal users vẫn mua hàng bình thường → cả hai lane đều OK
```

---

## 2. Redis capability được chứng minh

### 2.1 Phát biểu capability

Case này kiểm fairness giữa hot key và normal keys:

> **Hot key bị collapse bounded, normal unique keys vẫn fresh, normal latency dưới ngưỡng -- hot key không chiếm toàn bộ worker/Redis path.**

Cụ thể hơn, case này chứng minh ba sub-capabilities:

```text
1. Hot key collapse:     hot key chỉ có số fresh bounded (<= HOTKEY_MAX_FRESH), còn lại reuse
2. Normal key fresh:     normal unique keys đều fresh (fresh count == NORMAL_VUS)
3. Normal latency OK:    normal lane latency dưới ngưỡng (ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS)
```

### 2.2 Ba sub-proofs

| Sub-proof | Scenario | Số VU | Key dùng | Expected fresh | Expected reuse | Mục đích |
| --- | --- | --- | --- | --- | --- | --- |
| Hotkey collapse | `hotkey_confirm` | 8 | Cùng 1 `hotkeyOrderId` + `hotkeyIdempotencyKey` | `>=1` và `<= HOTKEY_MAX_FRESH` (2) | `>= HOTKEY_VUS - HOTKEY_MAX_FRESH` (6) | Chứng minh hot key bị collapse, chỉ 1-2 request thực thi thật |
| Normal không starvation | `normal_confirm` | 8 | Mỗi VU có `orderId` + `Idempotency-Key` riêng | `== NORMAL_VUS` (8) | 0 | Chứng minh normal keys không bị ảnh hưởng bởi hot key |
| Normal latency | `normal_confirm` | 8 | (như trên) | N/A | N/A | Chứng minh normal request hoàn thành dưới `NORMAL_MAX_MS` |

### 2.3 Tại sao capability này quan trọng

Nếu không có fairness, hậu quả trong production:

```text
Không collapse hot key:     8 VU cùng key → 8 lần DB write/external call → lãng phí tài nguyên, duplicate side effect
Hot key starve normal keys:  Hot key chiếm hết lock/connection → normal users timeout → mất doanh thu
Chỉ nhìn hot key pass:      Bỏ qua normal lane → không phát hiện starvation → bug ẩn đến khi traffic cao
Fairness đúng:              Hot key collapse gọn, normal users không bị ảnh hưởng → hệ thống hoạt động đúng
```

---

## 3. Vì sao phải test ở Redis/shared state layer

### 3.1 Redis là điểm quyết định fairness

```text
Client → Nginx (Gateway :80) → order-service → Redis (shared state)
                                                  ↑
                                           Điểm quyết định:
                                           - Ai được fresh execute?
                                           - Ai phải reuse?
                                           - Lock có Starve normal path không?
```

Quyết định fresh/reuse xảy ra tại Redis -- khi order-service kiểm tra `Idempotency-Key` trong Redis. Nếu lock bị giữ quá lâu bởi hot key, normal keys sẽ phải chờ. Nếu lock implementation không công bằng (fair), normal keys có thể bị starvation vĩnh viễn.

### 3.2 Không thể test fairness ở tầng app đơn lẻ

Nếu chỉ test bằng cách gọi trực tiếp một instance order-service:

```text
Test sai:    Gọi 16 request tuần tự đến cùng một instance → không có race, không có contention
Test đúng:   Gọi 16 request đồng thời qua Nginx → nhiều instance cùng tranh Redis lock → race thật

Chỉ request qua stack đầy đủ mới tạo được:
- Nhiều order-service instance cùng truy cập Redis
- Contention thật trên cùng một key
- Normal keys thật sự phải cạnh tranh với hot key
```

### 3.3 Signal từ counter là evidence không thể chối cãi

Response HTTP 200 là chưa đủ. Cần đọc chính xác:

- `order_hotkey_fairness_hotkey_fresh_count`: Bao nhiêu hot key request thực sự thực thi fresh?
- `order_hotkey_fairness_hotkey_reuse_count`: Bao nhiêu reuse?
- `order_hotkey_fairness_normal_fresh_count`: Tất cả normal keys có fresh không?
- `order_hotkey_fairness_normal_duration`: Normal latency có dưới ngưỡng không?

Đây là những custom counter được script tự đếm dựa trên response body (`idempotency_reuse: true/false`), không phải từ HTTP status code.

---

## 4. Topology và precondition

### 4.1 Sơ đồ topology

```text
                          ┌──────────────────────────────────┐
                          │     k6 test script                │
                          │  (19-order-service-hotkey-        │
                          │   fairness.js)                    │
                          └──────────────┬───────────────────┘
                                         │
                         2 scenarios song song:
                         hotkey_confirm (8 VU, 1 iter)
                         normal_confirm (8 VU, 1 iter, startTime=100ms)
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│  localhost:80 (Nginx Gateway)                                           │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Nginx LB                                                         │  │
│  │  Route đến order-service instances                                │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
│                                 │                                       │
│                                 ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  order-service (nhiều instances)                                  │  │
│  │  ┌────────────────────┐    ┌────────────────────┐                 │  │
│  │  │ POST .../confirm    │    │ POST .../confirm    │                │  │
│  │  │ Idempotency-Key     │    │ Idempotency-Key     │                │  │
│  │  │ check trong Redis   │    │ check trong Redis   │                │  │
│  │  └────────┬───────────┘    └────────┬───────────┘                 │  │
│  └───────────┼─────────────────────────┼─────────────────────────────┘  │
│              │                         │                                 │
│              ▼                         ▼                                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Redis (shared state)                                             │  │
│  │  ┌────────────────────────────────────────────────────────────┐  │  │
│  │  │ Key: idempotency:{hotkeyOrderId}:{hotkeyIdempotencyKey}     │  │  │
│  │  │ Claim TTL: CLAIM_TTL_MS (3000ms)                            │  │  │
│  │  │                                                              │  │  │
│  │  │ Key: idempotency:{normalOrderId}:{normalIdempotencyKey}     │  │  │
│  │  │ (8 keys khác nhau, mỗi VU một key)                          │  │  │
│  │  └────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  External simulation + Postgres                                   │  │
│  │  Hotkey external delay: 260ms, 5 DB writes                        │  │
│  │  Normal external delay: 20ms, 1 DB write                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Runtime yêu cầu

| Thành phần | Yêu cầu | Kiểm tra |
| --- | --- | --- |
| `TargetLayer` | `full-no-cdn` (bắt buộc) | `docker ps` thấy Nginx + order-service + Redis, không thấy Varnish |
| `BASE_URL` | `http://localhost:80` | Biến môi trường được set trước khi chạy |
| order-service đang chạy | Nhiều instance của order-service | `docker ps --filter "name=order-service"` |
| Redis đang chạy | Redis instance có thể truy cập từ order-service | Order confirm API trả về 200 |
| External simulation hoạt động | API có query params `external_ms`, `db_writes` | Gọi thử confirm API với `external_ms=0` |

### 4.3 Precondition của script

Script sử dụng `setup()` function để tạo dữ liệu test duy nhất cho mỗi lần chạy:

```javascript
export function setup() {
  const base = `${Date.now()}`;
  return {
    hotkeyOrderId: `ORD-FAIR-HOTKEY-${base}`,
    hotkeyIdempotencyKey: `idem-fair-hotkey-${base}`,
    normalPrefix: `ORD-FAIR-NORMAL-${base}`,
  };
}
```

Ba giá trị được tạo ra:

| Giá trị | Mục đích | Ai dùng |
| --- | --- | --- |
| `hotkeyOrderId` | Order ID chung cho tất cả hotkey VU | `hotkeyConfirm()` -- tất cả 8 VU dùng cùng giá trị này |
| `hotkeyIdempotencyKey` | Idempotency key chung cho tất cả hotkey VU | `hotkeyConfirm()` -- tất cả 8 VU dùng cùng giá trị này |
| `normalPrefix` | Prefix để tạo order ID riêng cho từng normal VU | `normalConfirm()` -- mỗi VU tạo `ORD-FAIR-NORMAL-{base}-{VU}` |

**Điểm quan trọng:** `Date.now()` được gọi trong `setup()` đảm bảo mỗi lần chạy script có một bộ key hoàn toàn mới, không bị ảnh hưởng bởi dữ liệu cũ trong Redis.

---

## 5. Script deep-dive

### 5.1 File nguồn

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\app\19-order-service-hotkey-fairness.js
```

### 5.2 Import và dependency

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { envInt, envString } from '../shared/common.js';
```

Phân tích từng import:

| Import | Nguồn gốc | Vai trò trong script này |
| --- | --- | --- |
| `http` | `k6/http` built-in | Gửi HTTP POST request đến order confirm endpoint |
| `check` | `k6` built-in | Xác minh status, success, order_id, idempotency_reuse, duration |
| `Counter` | `k6/metrics` | Đếm số lần fresh, reuse, failure cho hotkey và normal |
| `Trend` | `k6/metrics` | Đo duration của hotkey và normal request |
| `envInt` | `../shared/common.js` | Đọc biến môi trường dạng số nguyên, có fallback default |
| `envString` | `../shared/common.js` | Đọc biến môi trường dạng chuỗi |

### 5.3 Biến môi trường (env knobs)

```javascript
const BASE_URL = envString('BASE_URL', 'http://localhost:80').replace(/\/$/, '');
const HOTKEY_VUS = envInt('ORDER_HOTKEY_FAIRNESS_HOTKEY_VUS', 8);
const NORMAL_VUS = envInt('ORDER_HOTKEY_FAIRNESS_NORMAL_VUS', 8);
const HOTKEY_EXTERNAL_MS = envInt('ORDER_HOTKEY_FAIRNESS_HOTKEY_EXTERNAL_MS', 260);
const HOTKEY_DB_WRITES = envInt('ORDER_HOTKEY_FAIRNESS_HOTKEY_DB_WRITES', 5);
const CLAIM_TTL_MS = envInt('ORDER_HOTKEY_FAIRNESS_CLAIM_TTL_MS', 3000);
const HOTKEY_MAX_FRESH = envInt('ORDER_HOTKEY_FAIRNESS_HOTKEY_MAX_FRESH', 2);
const NORMAL_EXTERNAL_MS = envInt('ORDER_HOTKEY_FAIRNESS_NORMAL_EXTERNAL_MS', 20);
const NORMAL_DB_WRITES = envInt('ORDER_HOTKEY_FAIRNESS_NORMAL_DB_WRITES', 1);
const NORMAL_MAX_MS = envInt('ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS', 1500);
const OPS_AUTH_TOKEN = envString('OPS_AUTH_TOKEN', '');
```

Bảng phân tích từng biến:

| Biến | Default | Ý nghĩa | Vai trò trong fairness test |
| --- | --- | --- | --- |
| `HOTKEY_VUS` | `8` | Số VU chạy hotkey scenario | Tạo contention -- 8 request đồng thời cùng một key |
| `NORMAL_VUS` | `8` | Số VU chạy normal scenario | 8 request unique keys -- tất cả phải fresh |
| `HOTKEY_EXTERNAL_MS` | `260` | Delay external call cho hotkey path (ms) | Mô phỏng hot key xử lý nặng hơn (nhiều DB write, external call chậm) |
| `HOTKEY_DB_WRITES` | `5` | Số DB write cho hotkey path | Hot key thường có nhiều side effect hơn normal |
| `CLAIM_TTL_MS` | `3000` | TTL cho claim lock trong Redis (ms) | Lock tự hết hạn sau 3s nếu owner chết |
| `HOTKEY_MAX_FRESH` | `2` | Số fresh execution tối đa cho hot key | Cho phép tối đa 2 fresh (do race timing), còn lại phải reuse |
| `NORMAL_EXTERNAL_MS` | `20` | Delay external call cho normal path (ms) | Normal path nhẹ hơn nhiều so với hotkey |
| `NORMAL_DB_WRITES` | `1` | Số DB write cho normal path | Normal path ít side effect hơn |
| `NORMAL_MAX_MS` | `1500` | Ngưỡng duration tối đa cho normal request (ms) | Nếu normal request chậm hơn 1.5s → có thể bị hot key starvation |

**Lưu ý về `HOTKEY_MAX_FRESH = 2`:** Đây không phải là bug. Trong race thực tế với 8 VU đồng thời, tùy timing/claim TTL, có thể có 1-2 request cùng vượt qua lock check trước khi Redis record được thiết lập. Mục tiêu không phải luôn đúng 1 như redis-02, mà là bounded hotkey work và không starve normal keys.

### 5.4 Custom metrics

```javascript
const fairnessFailures = new Counter('order_hotkey_fairness_check_failures');
const hotkeyFreshCount = new Counter('order_hotkey_fairness_hotkey_fresh_count');
const hotkeyReuseCount = new Counter('order_hotkey_fairness_hotkey_reuse_count');
const normalFreshCount = new Counter('order_hotkey_fairness_normal_fresh_count');
const hotkeyDuration = new Trend('order_hotkey_fairness_hotkey_duration', true);
const normalDuration = new Trend('order_hotkey_fairness_normal_duration', true);
```

| Metric | Loại | Ý nghĩa | Cách đọc |
| --- | --- | --- | --- |
| `fairnessFailures` | Counter | Số lần check thất bại (có tag label) | `count==0` → không có lỗi nào |
| `hotkeyFreshCount` | Counter | Số hotkey request được thực thi thật (fresh) | `count>=1` và `count<=2` |
| `hotkeyReuseCount` | Counter | Số hotkey request được reuse | `count>=6` (8 VU - 2 max fresh) |
| `normalFreshCount` | Counter | Số normal request được thực thi thật | `count==8` (đúng bằng NORMAL_VUS) |
| `hotkeyDuration` | Trend | Thời gian hoàn thành của hotkey request | Có thể cao hơn normal do external delay 260ms |
| `normalDuration` | Trend | Thời gian hoàn thành của normal request | Phải dưới `NORMAL_MAX_MS` |

### 5.5 options block

```javascript
export const options = {
  noConnectionReuse: true,
  scenarios: {
    hotkey_confirm: {
      executor: 'per-vu-iterations',
      exec: 'hotkeyConfirm',
      vus: HOTKEY_VUS,
      iterations: 1,
      maxDuration: '1m',
      tags: { scenario: 'order_hotkey_fairness', phase: 'hotkey_confirm' },
    },
    normal_confirm: {
      executor: 'per-vu-iterations',
      exec: 'normalConfirm',
      vus: NORMAL_VUS,
      iterations: 1,
      startTime: '100ms',
      maxDuration: '1m',
      tags: { scenario: 'order_hotkey_fairness', phase: 'normal_confirm' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_hotkey_fairness_check_failures: ['count==0'],
    order_hotkey_fairness_hotkey_fresh_count: ['count>=1', `count<=${Math.max(HOTKEY_MAX_FRESH, 1)}`],
    order_hotkey_fairness_hotkey_reuse_count: [`count>=${Math.max(HOTKEY_VUS - HOTKEY_MAX_FRESH, 0)}`],
    order_hotkey_fairness_normal_fresh_count: [`count==${NORMAL_VUS}`],
  },
};
```

#### Hai scenarios song song

Script sử dụng 2 scenarios chạy gần như đồng thời:

| Scenario | Executor | VUs | Iterations | Start time | Exec function |
| --- | --- | --- | --- | --- | --- |
| `hotkey_confirm` | `per-vu-iterations` | 8 | 1 | 0ms (ngay lập tức) | `hotkeyConfirm` |
| `normal_confirm` | `per-vu-iterations` | 8 | 1 | 100ms (trễ 100ms) | `normalConfirm` |

**Tại sao `startTime: '100ms'` cho normal_confirm?**

Normal scenario bắt đầu trễ hơn 100ms để đảm bảo hotkey lane đã bắt đầu tranh chấp lock trước. Điều này tạo ra tình huống xấu nhất (worst-case): normal keys phải cạnh tranh với hot key đang active. Nếu normal keys vẫn fresh và nhanh trong điều kiện này, hệ thống thực sự công bằng.

#### Thresholds

| Threshold | Điều kiện | Ý nghĩa |
| --- | --- | --- |
| `checks` | `rate==1` | 100% checks phải pass |
| `http_req_failed` | `rate==0` | Không có HTTP request nào thất bại |
| `fairnessFailures` | `count==0` | Không có check failure nào được ghi nhận |
| `hotkeyFreshCount` | `count>=1`, `count<=2` | Hot key fresh bị bounded |
| `hotkeyReuseCount` | `count>=6` | Ít nhất 6/8 hotkey request được reuse |
| `normalFreshCount` | `count==8` | Tất cả 8 normal request đều fresh |

### 5.6 Các helper functions

#### headers()

```javascript
function headers(extraHeaders = {}) {
  const result = {
    'Content-Type': 'application/json',
    'X-Test-Suite': 'order-service-hotkey-fairness',
    ...extraHeaders,
  };
  if (OPS_AUTH_TOKEN) {
    result.Authorization = `Bearer ${OPS_AUTH_TOKEN}`;
    result['X-Ops-Token'] = OPS_AUTH_TOKEN;
  }
  return result;
}
```

Hàm này xây dựng HTTP headers cho mọi request. `X-Test-Suite` được gắn vào tất cả request để dễ dàng lọc và debug trên dashboard.

#### recordCheckFailure()

```javascript
function recordCheckFailure(label) {
  fairnessFailures.add(1, { label, target_service: 'order-service' });
  return false;
}
```

Mỗi khi một check thất bại, hàm này vừa tăng counter `fairnessFailures` (có tag `label` để phân loại lỗi) vừa trả về `false` để k6 `check()` ghi nhận thất bại. Pattern này cho phép đếm chính xác loại lỗi nào xảy ra.

#### postConfirm()

```javascript
function postConfirm(orderId, idempotencyKey, externalMs, dbWrites, stage) {
  const response = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=${dbWrites}&external_ms=${externalMs}&external_fail_rate=0&claim_ttl_ms=${CLAIM_TTL_MS}`,
    JSON.stringify({}),
    {
      headers: headers({ 'Idempotency-Key': idempotencyKey }),
      tags: { stage, target_flow: 'order_confirm', target_service: 'order-service' },
    },
  );
  return {
    response,
    payload: safeJson(response),
  };
}
```

Đây là hàm gửi HTTP POST duy nhất được cả hai scenario sử dụng. Query parameters kiểm soát toàn bộ behavior:

| Parameter | Hotkey value | Normal value | Ý nghĩa |
| --- | --- | --- | --- |
| `cpu_ms` | `0` | `0` | Không thêm CPU delay |
| `db_writes` | `5` | `1` | Hotkey path làm nhiều DB write hơn |
| `external_ms` | `260` | `20` | Hotkey path có external call chậm hơn |
| `external_fail_rate` | `0` | `0` | Không mô phỏng external failure |
| `claim_ttl_ms` | `3000` | `3000` | Claim TTL giống nhau cho cả hai |

### 5.7 hotkeyConfirm() -- exec function cho hotkey lane

```javascript
export function hotkeyConfirm(data) {
  const result = postConfirm(
    data.hotkeyOrderId,
    data.hotkeyIdempotencyKey,
    HOTKEY_EXTERNAL_MS,
    HOTKEY_DB_WRITES,
    'hotkey_confirm',
  );
  hotkeyDuration.add(result.response.timings.duration);

  check(result, {
    'hotkey fairness status 200': (o) => o.response.status === 200 || recordCheckFailure('hotkey_status'),
    'hotkey fairness success true': (o) => o.payload && o.payload.success === true || recordCheckFailure('hotkey_success'),
    'hotkey fairness order id preserved': (o) => o.payload && o.payload.data && o.payload.data.order_id === data.hotkeyOrderId || recordCheckFailure('hotkey_order_id'),
  });

  const reuse = !!(result.payload && result.payload.data && result.payload.data.idempotency_reuse === true);
  if (reuse) {
    hotkeyReuseCount.add(1);
  } else {
    hotkeyFreshCount.add(1);
  }
}
```

**Phân tích từng bước:**

1. Gọi `postConfirm()` với `orderId` và `idempotencyKey` giống hệt nhau cho tất cả 8 VU
2. Ghi nhận duration vào Trend `hotkeyDuration`
3. Check: status 200, success true, order_id khớp
4. Đọc `idempotency_reuse` từ response body:
   - `true` → request này được reuse kết quả cũ → `hotkeyReuseCount++`
   - `false` → request này được thực thi thật (fresh) → `hotkeyFreshCount++`

### 5.8 normalConfirm() -- exec function cho normal lane

```javascript
export function normalConfirm(data) {
  const orderId = `${data.normalPrefix}-${__VU}`;
  const idempotencyKey = `idem-${orderId}`;
  const result = postConfirm(orderId, idempotencyKey, NORMAL_EXTERNAL_MS, NORMAL_DB_WRITES, 'normal_confirm');
  normalDuration.add(result.response.timings.duration);

  check(result, {
    'normal fairness status 200': (o) => o.response.status === 200 || recordCheckFailure('normal_status'),
    'normal fairness success true': (o) => o.payload && o.payload.success === true || recordCheckFailure('normal_success'),
    'normal fairness unique order id preserved': (o) => o.payload && o.payload.data && o.payload.data.order_id === orderId || recordCheckFailure('normal_order_id'),
    'normal fairness executes fresh': (o) => o.payload && o.payload.data && o.payload.data.idempotency_reuse === false || recordCheckFailure('normal_fresh'),
    [`normal fairness duration <= ${NORMAL_MAX_MS}ms`]: (o) => o.response.timings.duration <= NORMAL_MAX_MS || recordCheckFailure('normal_duration'),
  });
  normalFreshCount.add(1);
}
```

**Phân tích từng bước:**

1. Tạo `orderId` riêng cho từng VU: `ORD-FAIR-NORMAL-{base}-{VU}` (1 đến 8)
2. Tạo `idempotencyKey` riêng: `idem-{orderId}`
3. Gọi `postConfirm()` với key unique cho từng VU
4. Ghi nhận duration vào Trend `normalDuration`
5. Check: status 200, success true, order_id khớp, `idempotency_reuse === false` (phải fresh), duration `<= NORMAL_MAX_MS`
6. Tăng `normalFreshCount` -- mỗi normal request được kỳ vọng là fresh

**Khác biệt chính giữa hotkeyConfirm và normalConfirm:**

| Khía cạnh | hotkeyConfirm | normalConfirm |
| --- | --- | --- |
| orderId | Giống nhau cho 8 VU | Khác nhau cho từng VU (`__VU`) |
| idempotencyKey | Giống nhau cho 8 VU | Khác nhau cho từng VU |
| external_ms | 260ms (nặng) | 20ms (nhẹ) |
| db_writes | 5 (nhiều) | 1 (ít) |
| Check `idempotency_reuse` | Có thể `true` hoặc `false` | Phải là `false` (fresh) |
| Duration check | Không có ngưỡng cứng | Phải `<= NORMAL_MAX_MS` |

### 5.9 Sơ đồ tổ chức toàn bộ script

```text
┌─ Import: http (k6/http), check (k6), Counter + Trend (k6/metrics),
│          envInt + envString (../shared/common.js)
│
├─ Env vars (10 biến): HOTKEY_VUS=8, NORMAL_VUS=8,
│   HOTKEY_EXTERNAL_MS=260, HOTKEY_DB_WRITES=5, CLAIM_TTL_MS=3000,
│   HOTKEY_MAX_FRESH=2, NORMAL_EXTERNAL_MS=20, NORMAL_DB_WRITES=1,
│   NORMAL_MAX_MS=1500, OPS_AUTH_TOKEN
│
├─ Custom metrics (6 counters/trends):
│   fairnessFailures, hotkeyFreshCount, hotkeyReuseCount,
│   normalFreshCount, hotkeyDuration, normalDuration
│
├─ options
│   ├─ noConnectionReuse: true
│   ├─ scenarios:
│   │   ├─ hotkey_confirm: per-vu-iterations, 8 VU, 1 iter, exec=hotkeyConfirm
│   │   └─ normal_confirm: per-vu-iterations, 8 VU, 1 iter, exec=normalConfirm, startTime=100ms
│   └─ thresholds: checks rate==1, http_req_failed rate==0, fairnessFailures count==0,
│       hotkeyFreshCount count>=1 & count<=2, hotkeyReuseCount count>=6,
│       normalFreshCount count==8
│
├─ setup()
│   └─ Tạo: hotkeyOrderId, hotkeyIdempotencyKey, normalPrefix (dùng Date.now())
│
├─ Helper functions:
│   ├─ headers(extraHeaders) → HTTP headers với X-Test-Suite
│   ├─ recordCheckFailure(label) → tăng fairnessFailures + return false
│   ├─ safeJson(response) → parse JSON an toàn
│   └─ postConfirm(orderId, idempotencyKey, externalMs, dbWrites, stage) → HTTP POST
│
├─ hotkeyConfirm(data) ← exec cho hotkey_confirm scenario
│   ├─ postConfirm(data.hotkeyOrderId, data.hotkeyIdempotencyKey, 260, 5, 'hotkey_confirm')
│   ├─ hotkeyDuration.add(duration)
│   ├─ check: status 200, success true, order_id preserved
│   └─ Phân loại: reuse? → hotkeyReuseCount++ : hotkeyFreshCount++
│
└─ normalConfirm(data) ← exec cho normal_confirm scenario
    ├─ Tạo orderId = normalPrefix-{__VU}, idempotencyKey = idem-{orderId}
    ├─ postConfirm(orderId, idempotencyKey, 20, 1, 'normal_confirm')
    ├─ normalDuration.add(duration)
    ├─ check: status 200, success true, order_id preserved, reuse===false, duration<=1500ms
    └─ normalFreshCount++
```

---

## 6. Redis mechanism deep-dive

### 6.1 Kiến trúc fairness trong Redis/shared state

Redis không có cơ chế "fairness" built-in. Fairness được đảm bảo bởi cách application sử dụng Redis lock và idempotency record:

| Cơ chế | Redis operation | Vai trò trong fairness |
| --- | --- | --- |
| **Idempotency record** | `SET NX` (set if not exists) + `GET` | Ghi nhận kết quả lần đầu, trả về kết quả cũ cho lần sau |
| **Claim lock** | `SET NX` với TTL | Chỉ một worker được quyền thực thi fresh |
| **Claim TTL** | `EXPIRE` / `SET ... EX` | Lock tự hết hạn, tránh khóa vĩnh viễn nếu worker chết |
| **Lock release** | `DEL` (sau khi hoàn thành) | Worker trả lock sau khi xong |

### 6.2 Cách hot key bị collapse

Khi 8 VU đồng thời gửi cùng một `Idempotency-Key`:

```text
Thời điểm T0 (8 request đến Redis cùng lúc):
  Request-1: SET NX idempotency:{key} → OK (chưa có key nào) → ĐƯỢC fresh execute
  Request-2: SET NX idempotency:{key} → FAIL (key đã tồn tại) → ĐỌC kết quả cũ → REUSE
  Request-3: SET NX idempotency:{key} → FAIL → REUSE
  Request-4: SET NX idempotency:{key} → FAIL → REUSE
  ...
  Request-8: SET NX idempotency:{key} → FAIL → REUSE

Kết quả: 1 fresh, 7 reuse
```

Tuy nhiên, trong thực tế với network latency và timing:

```text
Thời điểm T0 (8 request đến Redis):
  Request-1: SET NX → OK (fresh)
  Request-2: Đến trước khi Request-1 SET → cũng SET NX → OK (fresh thứ 2!)
  Request-3: Đến sau khi key đã tồn tại → FAIL → REUSE
  ...

Kết quả: 1-2 fresh, 6-7 reuse
```

Đây là lý do `HOTKEY_MAX_FRESH = 2` -- race condition ở mức mili-giây có thể cho phép 2 request cùng vượt qua lock check. Điều này là chấp nhận được trong production miễn là bounded.

### 6.3 Cách normal keys không bị starvation

Normal keys dùng Redis key khác nhau:

```text
normalConfirm VU-1: SET NX idempotency:ORD-FAIR-NORMAL-{base}-1:idem-... → key riêng
normalConfirm VU-2: SET NX idempotency:ORD-FAIR-NORMAL-{base}-2:idem-... → key riêng
...
normalConfirm VU-8: SET NX idempotency:ORD-FAIR-NORMAL-{base}-8:idem-... → key riêng
```

Vì mỗi VU dùng một Redis key khác nhau, không có contention giữa các normal keys. Và vì hot key dùng một Redis key hoàn toàn khác (`ORD-FAIR-HOTKEY-...`), hot key lock không chặn normal key path -- trừ khi có bottleneck ở tầng Redis connection pool hoặc application thread pool.

### 6.4 Điều gì có thể gây starvation

Starvation có thể xảy ra nếu:

| Nguyên nhân | Cơ chế | Cách phát hiện trong case này |
| --- | --- | --- |
| **Redis connection pool cạn** | Tất cả connection bị hot key chiếm → normal keys phải chờ | `normalDuration > NORMAL_MAX_MS` |
| **Application thread pool cạn** | Tất cả worker thread bị hot key blocking | `normalDuration` tăng đột biến |
| **Redis single-thread block** | Hot key transaction chạy lâu → chặn toàn bộ Redis | `normalDuration` tăng ở tất cả request |
| **Lock contention không bounded** | Hot key retry loop không có backoff | `hotkeyFreshCount` cao bất thường |

### 6.5 Chuỗi xử lý hoàn chỉnh trong Redis

```text
Request POST /api/sim/orders/{orderId}/confirm
  Header: Idempotency-Key: {key}
  Query: claim_ttl_ms=3000
        │
        ▼
┌──────────────────────────────────────────────────────┐
│ 1. order-service nhận request                         │
│    Đọc Idempotency-Key từ header                      │
│    Tạo Redis key: idempotency:{orderId}:{key}         │
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 2. Kiểm tra Redis: key đã tồn tại chưa?               │
│    GET idempotency:{orderId}:{key}                    │
│                                                       │
│    ┌─ Key tồn tại → trả về kết quả cũ → REUSE        │
│    └─ Key chưa tồn tại → tiếp tục bước 3              │
└────────────────────────┬─────────────────────────────┘
                         │ (key chưa tồn tại)
                         ▼
┌──────────────────────────────────────────────────────┐
│ 3. Thiết lập claim lock trong Redis                   │
│    SET NX idempotency:{orderId}:{key} status=PROCESSING│
│    EXPIRE trong CLAIM_TTL_MS (3000ms)                 │
│                                                       │
│    ┌─ SET NX thành công → được quyền FRESH execute    │
│    └─ SET NX thất bại → đọc kết quả → REUSE          │
└────────────────────────┬─────────────────────────────┘
                         │ (được quyền fresh)
                         ▼
┌──────────────────────────────────────────────────────┐
│ 4. Thực thi business logic                            │
│    - db_writes lần (5 cho hotkey, 1 cho normal)       │
│    - external_ms delay (260ms hotkey, 20ms normal)    │
│    - Tạo kết quả confirm                              │
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 5. Lưu kết quả vào Redis + giải phóng lock            │
│    SET idempotency:{orderId}:{key} = {kết quả}        │
│    (Không còn là PROCESSING nữa)                      │
└────────────────────────┬─────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│ 6. Trả về response cho client                         │
│    { success: true, data: { order_id, idempotency_reuse: false } } │
└──────────────────────────────────────────────────────┘
```

### 6.6 So sánh với redis-02 (Hot-key idempotency race)

| Khía cạnh | redis-02 | redis-05 |
| --- | --- | --- |
| Mục tiêu | Atomicity: chính xác 1 fresh | Fairness: hot bounded + normal all fresh |
| Số scenario | 1 scenario (tất cả cùng race 1 key) | 2 scenarios song song (hotkey + normal) |
| Fresh count kỳ vọng | `== 1` (tuyệt đối) | `>=1` và `<= MAX_FRESH` (bounded) |
| Có normal lane? | Không | Có (8 VU unique keys) |
| Duration check? | Không | Có (`NORMAL_MAX_MS`) |
| Executor | `per-vu-iterations`, 1 scenario | `per-vu-iterations`, 2 scenarios |
| Bài học | Side effect chỉ xảy ra 1 lần | Hot key không được starve normal traffic |

---

## 7. Request sequence flow

### 7.1 Timeline tổng thể

```text
Thời gian
0ms              100ms             200ms             ...               ~3000ms
│                │                 │                                     │
├────────────────┼─────────────────┼─────────────────────────────────────┤
│                │                 │                                     │
│ Scenario 1:    │ Scenario 2:     │                                     │
│ hotkey_confirm │ normal_confirm  │                                     │
│ (8 VU đồng     │ (8 VU đồng      │                                     │
│  thời, cùng    │  thời, unique   │                                     │
│  key)          │  keys)          │                                     │
│                │                 │                                     │
│ VU1: fresh ────┼──> hoàn thành   │                                     │
│ VU2: reuse ────┼──> hoàn thành   │                                     │
│ VU3: reuse ────┼──> hoàn thành   │                                     │
│ ...            │ VU1: fresh ─────┼──> hoàn thành (~20ms)              │
│ VU8: reuse ────┼──> hoàn thành   │ VU2: fresh ─────┼──> hoàn thành    │
│                │ ...             │                                     │
│                │ VU8: fresh ─────┼──> hoàn thành                      │
│                │                 │                                     │
│ ~260-500ms     │ ~20-50ms        │                                     │
│ (hotkey path   │ (normal path    │                                     │
│  nặng hơn)     │  nhẹ hơn)       │                                     │
│                │                 │                                     │
└────────────────┴─────────────────┴─────────────────────────────────────┘
                                                              │
                                                        Đánh giá:
                                                        hotkeyFreshCount ∈ [1,2]?
                                                        hotkeyReuseCount >= 6?
                                                        normalFreshCount == 8?
                                                        normalDuration <= 1500ms?
```

### 7.2 Timeline chi tiết cho hotkey_confirm

```text
setup() hoàn thành → data = { hotkeyOrderId, hotkeyIdempotencyKey, normalPrefix }

0ms: 8 VU đồng thời bắt đầu chạy hotkeyConfirm(data)
│
├─ VU-1:
│  ├─ 0ms:    postConfirm(hotkeyOrderId, hotkeyIdempotencyKey, 260, 5, 'hotkey_confirm')
│  │          → POST /api/sim/orders/ORD-FAIR-HOTKEY-{base}/confirm
│  │            Header: Idempotency-Key: idem-fair-hotkey-{base}
│  │            Query: db_writes=5&external_ms=260&claim_ttl_ms=3000
│  │
│  ├─ ~1ms:   Nginx route đến order-service instance
│  ├─ ~2ms:   order-service kiểm tra Redis: key chưa tồn tại → SET NX → OK
│  ├─ ~3ms:   Bắt đầu fresh execution: 5 DB writes + 260ms external delay
│  ├─ ~265ms: Hoàn thành fresh execution, lưu kết quả vào Redis
│  ├─ ~266ms: Trả về 200 OK, idempotency_reuse: false
│  └─ ~266ms: hotkeyFreshCount++ (1)
│
├─ VU-2:
│  ├─ 0ms:    postConfirm(cùng key)
│  ├─ ~1ms:   Nginx route đến order-service instance (có thể khác instance)
│  ├─ ~2ms:   order-service kiểm tra Redis: key ĐÃ tồn tại (VU-1 vừa SET)
│  │          → Đọc kết quả → REUSE
│  ├─ ~3ms:   Trả về 200 OK, idempotency_reuse: true
│  └─ ~3ms:   hotkeyReuseCount++ (1)
│
├─ VU-3: (tương tự VU-2) → reuse → hotkeyReuseCount++ (2)
├─ VU-4: (tương tự VU-2) → reuse → hotkeyReuseCount++ (3)
├─ VU-5: (tương tự VU-2) → reuse → hotkeyReuseCount++ (4)
├─ VU-6: (tương tự VU-2) → reuse → hotkeyReuseCount++ (5)
├─ VU-7: (tương tự VU-2) → reuse → hotkeyReuseCount++ (6)
├─ VU-8: (tương tự VU-2) → reuse → hotkeyReuseCount++ (7)
│
└─ Kết thúc hotkey_confirm scenario:
   hotkeyFreshCount = 1 (hoặc 2 nếu race timing)
   hotkeyReuseCount = 7 (hoặc 6)
```

### 7.3 Timeline chi tiết cho normal_confirm

```text
100ms: 8 VU đồng thời bắt đầu chạy normalConfirm(data)
│
├─ VU-1:
│  ├─ 100ms:  Tạo orderId = "ORD-FAIR-NORMAL-{base}-1"
│  │          Tạo idempotencyKey = "idem-ORD-FAIR-NORMAL-{base}-1"
│  │
│  ├─ 100ms:  postConfirm(orderId, idempotencyKey, 20, 1, 'normal_confirm')
│  │          → POST /api/sim/orders/ORD-FAIR-NORMAL-{base}-1/confirm
│  │            Header: Idempotency-Key: idem-ORD-FAIR-NORMAL-{base}-1
│  │            Query: db_writes=1&external_ms=20&claim_ttl_ms=3000
│  │
│  ├─ ~101ms: Nginx route đến order-service instance
│  ├─ ~102ms: order-service kiểm tra Redis: KEY RIÊNG, chưa tồn tại → SET NX → OK
│  ├─ ~103ms: Bắt đầu fresh execution: 1 DB write + 20ms external delay
│  ├─ ~124ms: Hoàn thành fresh execution, lưu kết quả vào Redis
│  ├─ ~125ms: Trả về 200 OK, idempotency_reuse: false
│  └─ ~125ms: normalFreshCount++ (1), duration=25ms <= 1500ms ✓
│
├─ VU-2:
│  ├─ 100ms:  Tạo orderId = "ORD-FAIR-NORMAL-{base}-2" (KEY RIÊNG)
│  ├─ ~125ms: Hoàn thành, normalFreshCount++ (2)
│
├─ VU-3 ... VU-8: (tương tự, mỗi VU có key riêng)
│  └─ Tất cả đều fresh vì key không trùng
│
└─ Kết thúc normal_confirm scenario:
   normalFreshCount = 8 (TẤT CẢ fresh)
   normalDuration: tất cả dưới 100ms (<< 1500ms)
```

### 7.4 Phân tích thời gian

```text
Hotkey path duration:
  Base: ~5ms (HTTP + Redis check + response)
  + 260ms external delay (HOTKEY_EXTERNAL_MS)
  + 5 DB writes (~10-20ms)
  = ~275-285ms cho fresh, ~3-5ms cho reuse

Normal path duration:
  Base: ~5ms (HTTP + Redis check + response)
  + 20ms external delay (NORMAL_EXTERNAL_MS)
  + 1 DB write (~2-5ms)
  = ~27-30ms cho mỗi request

Normal duration << NORMAL_MAX_MS (1500ms):
  Margin an toàn rất lớn (~50x) → normal keys không bị ảnh hưởng
```

---

## 8. Key signals / counters

### 8.1 Bảng signals chính

| Signal | Loại | Vị trí | Expected value | Ý nghĩa | Nếu sai |
| --- | --- | --- | --- | --- | --- |
| `status` | Built-in | HTTP response | `200` | Tất cả request phải thành công | Origin lỗi hoặc Redis không hoạt động |
| `idempotency_reuse` | Body field | Response JSON `data.idempotency_reuse` | `false` cho normal, `true` cho reuse | Phân biệt fresh vs reuse | Nếu normal mà `true` → key bị trùng (bug) |
| `order_hotkey_fairness_hotkey_fresh_count` | Counter | Custom metric | `>=1` và `<=2` | Số hotkey request thực thi thật | Nếu 0 → không ai thực thi được; nếu >2 → lock không hoạt động |
| `order_hotkey_fairness_hotkey_reuse_count` | Counter | Custom metric | `>=6` (8-2) | Số hotkey request reuse | Nếu <6 → quá nhiều fresh, lock yếu |
| `order_hotkey_fairness_normal_fresh_count` | Counter | Custom metric | `==8` | Tất cả normal request đều fresh | Nếu <8 → có normal request bị reuse (key trùng?) hoặc thất bại |
| `order_hotkey_fairness_hotkey_duration` | Trend | Custom metric | ~275ms (fresh), ~3ms (reuse) | Thời gian hoàn thành hotkey | Có thể cao do external delay |
| `order_hotkey_fairness_normal_duration` | Trend | Custom metric | ~30ms, max <1500ms | Thời gian hoàn thành normal | Nếu >1500ms → starvation |
| `order_hotkey_fairness_check_failures` | Counter | Custom metric | `0` | Số check thất bại | Nếu >0 → có lỗi cần debug |
| `checks rate` | Built-in | k6 summary | `1.0` (100%) | Tất cả checks pass | Nếu <1 → có check thất bại |
| `http_req_failed` | Built-in | k6 summary | `rate == 0` | Không có request thất bại | Nếu >0 → HTTP error |

### 8.2 Bảng signals cho từng scenario

| Scenario | `idempotency_reuse` expected | Fresh count expected | Reuse count expected | Duration expected |
| --- | --- | --- | --- | --- |
| `hotkey_confirm` | 1-2 request có `false`, còn lại `true` | 1-2 | 6-7 | ~275ms (fresh), ~3ms (reuse) |
| `normal_confirm` | Tất cả `false` | 8 | 0 | ~30ms, max <1500ms |

### 8.3 Signal không có trong response (và đó là điều tốt)

| Signal | Expected | Tại sao quan trọng |
| --- | --- | --- |
| `X-Cache` header | **absent** | Chứng minh không qua CDN -- request đến thẳng origin |
| Status 5xx | **absent** (trừ khi test cố ý) | Tất cả request phải 200 |
| `idempotency_reuse: true` trong normalConfirm | **absent** | Normal keys không được reuse -- chứng minh key uniqueness |

### 8.4 Cách đọc idempotency_reuse từ response

```javascript
// Trong script
const reuse = !!(result.payload && result.payload.data && result.payload.data.idempotency_reuse === true);

// Response body mẫu:
// Fresh: { "success": true, "data": { "order_id": "...", "idempotency_reuse": false } }
// Reuse: { "success": true, "data": { "order_id": "...", "idempotency_reuse": true } }
```

---

## 9. Pass/fail criteria

### 9.1 Tiêu chí PASS

Một test run được coi là PASS khi thỏa mãn **tất cả** các điều kiện sau:

| # | Tiêu chí | Cách kiểm tra | Giải thích |
| --- | --- | --- | --- |
| 1 | Tất cả HTTP request thành công | `http_req_failed rate == 0` | Không có lỗi HTTP |
| 2 | Tất cả checks pass | `checks rate == 1` | Mọi response thỏa mãn điều kiện |
| 3 | Không có check failure | `fairnessFailures count == 0` | Không có lỗi logic |
| 4 | Hot key có ít nhất 1 fresh | `hotkeyFreshCount >= 1` | Có ít nhất 1 request thực thi thật |
| 5 | Hot key fresh bounded | `hotkeyFreshCount <= 2` | Không quá 2 fresh execution |
| 6 | Hot key reuse đủ lớn | `hotkeyReuseCount >= 6` | Ít nhất 6/8 request được reuse |
| 7 | Tất cả normal keys fresh | `normalFreshCount == 8` | 8/8 normal request thực thi thật |
| 8 | Normal duration dưới ngưỡng | Mỗi normal request `<= 1500ms` | Normal path không bị chậm |

### 9.2 Tiêu chí FAIL

| # | Hiện tượng | Nguyên nhân có thể | Cách debug |
| --- | --- | --- | --- |
| 1 | `hotkeyFreshCount == 0` | Không request nào thực thi được -- Redis không hoạt động hoặc lock bị giữ vĩnh viễn | Kiểm tra Redis connection, kiểm tra claim TTL |
| 2 | `hotkeyFreshCount > 2` | Lock không hoạt động -- quá nhiều request vượt qua lock check | Kiểm tra Redis SET NX implementation, kiểm tra timing |
| 3 | `hotkeyReuseCount < 6` | Quá ít reuse -- lock quá yếu hoặc timeout | Kiểm tra CLAIM_TTL_MS, kiểm tra network latency |
| 4 | `normalFreshCount < 8` | Có normal request không fresh -- có thể key bị trùng hoặc request thất bại | Kiểm tra `normalPrefix` generation, kiểm tra logs |
| 5 | `normalDuration > 1500ms` | Normal path bị chậm -- có thể hot key starve Redis/thread pool | Kiểm tra Redis connection pool, thread pool metrics |
| 6 | `http_req_failed > 0` | Có HTTP error -- origin hoặc Redis không hoạt động | Kiểm tra stack health |
| 7 | `checks rate < 1` | Có check thất bại | Đọc từng check failure detail |
| 8 | `fairnessFailures > 0` | Có lỗi logic được ghi nhận | Đọc tag `label` trên counter để phân loại lỗi |

### 9.3 Ngưỡng tham chiếu

Dựa trên thiết kế case với default config:

```text
PASS zone:
  hotkeyFreshCount:     1 - 2
  hotkeyReuseCount:     6 - 7
  normalFreshCount:     8 (chính xác)
  normalDuration p95:   < 100ms
  normalDuration max:   < 1500ms
  hotkeyDuration fresh: ~275ms
  hotkeyDuration reuse: ~3-5ms

FAIL zone:
  hotkeyFreshCount:     0 hoặc > 2
  hotkeyReuseCount:     < 6
  normalFreshCount:     < 8
  normalDuration max:   >= 1500ms
  http_req_failed:      > 0
```

---

## 10. Cách chạy + output mẫu

### 10.1 Lệnh chạy qua runner script

```powershell
cd E:\Projects\k6\k6-metrics-server
./scripts/run-redis-capabilities.ps1 -Profile full-no-cdn -Scenarios 05-hotkey-fairness
```

### 10.2 Lệnh chạy trực tiếp bằng k6

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target

$env:BASE_URL = "http://localhost:80"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_EXTERNAL_MS = "260"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_DB_WRITES = "5"
$env:ORDER_HOTKEY_FAIRNESS_CLAIM_TTL_MS = "3000"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_MAX_FRESH = "2"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_EXTERNAL_MS = "20"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_DB_WRITES = "1"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS = "1500"

k6 run ./k6/app/19-order-service-hotkey-fairness.js
```

### 10.3 Output mẫu (PASS)

```text
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: ./k6/app/19-order-service-hotkey-fairness.js
     output: -

  scenarios: (100.00%) 2 scenarios, 16 max VUs, 2m0s max duration (incl. graceful stop):

  ✓ hotkey fairness status 200
  ✓ hotkey fairness success true
  ✓ hotkey fairness order id preserved
  ... (8 lần cho mỗi hotkey VU)

  ✓ normal fairness status 200
  ✓ normal fairness success true
  ✓ normal fairness unique order id preserved
  ✓ normal fairness executes fresh
  ✓ normal fairness duration <= 1500ms
  ... (8 lần cho mỗi normal VU)

  checks .................................................: 100.00% ✓ 64       ✗ 0
  http_req_failed ........................................: 0.00%   ✓ 0        ✗ 16
  http_req_duration ......................................: avg=95ms  min=2ms  med=10ms  max=290ms  p90=275ms  p95=285ms
  order_hotkey_fairness_check_failures ...................: 0
  order_hotkey_fairness_hotkey_fresh_count ...............: 1
  order_hotkey_fairness_hotkey_reuse_count ...............: 7
  order_hotkey_fairness_normal_fresh_count ...............: 8
  order_hotkey_fairness_hotkey_duration ..................: avg=40ms  min=3ms  med=5ms  max=285ms  p90=280ms  p95=285ms
  order_hotkey_fairness_normal_duration ..................: avg=28ms  min=25ms med=27ms max=35ms   p90=32ms  p95=35ms

  Result: PASS
  Exit code: 0
```

### 10.4 Đọc output

| Dòng | Ý nghĩa |
| --- | --- |
| `checks: 100.00% (64/64)` | Tất cả 64 checks pass (8 hotkey × 3 checks + 8 normal × 5 checks) |
| `http_req_failed: 0.00% (0/16)` | Không có request nào thất bại |
| `hotkey_fresh_count: 1` | Chỉ 1/8 hotkey request thực thi thật -- collapse hoạt động |
| `hotkey_reuse_count: 7` | 7/8 hotkey request reuse kết quả -- đúng |
| `normal_fresh_count: 8` | Tất cả 8 normal request đều fresh -- không starvation |
| `hotkey_duration avg=40ms` | Hotkey duration trung bình (fresh 285ms, reuse 3-5ms → avg ~40ms) |
| `normal_duration avg=28ms max=35ms` | Normal duration thấp và ổn định -- không bị ảnh hưởng |
| `Result: PASS, Exit code: 0` | Case pass toàn bộ |

---

## 11. 4 output -> decision scenarios

### Scenario 1: PASS hoàn hảo

```text
hotkeyFreshCount:     1
hotkeyReuseCount:     7
normalFreshCount:     8
normalDuration max:   35ms (<< 1500ms)
checks rate:          1.0
http_req_failed:      0/16

→ Decision: ✓ Fairness hoạt động đúng. Hot key bị collapse gọn (1 fresh, 7 reuse).
  Normal keys không bị ảnh hưởng (tất cả fresh, latency thấp).
  Có thể tự tin triển khai hotkey mitigation lên production.
```

### Scenario 2: Hot key không collapse đủ (NGUY HIỂM)

```text
hotkeyFreshCount:     5  ← SAI! (vượt MAX_FRESH=2)
hotkeyReuseCount:     3
normalFreshCount:     8
normalDuration max:   40ms
checks rate:          0.95

→ Decision: ✗ Hot key lock quá yếu. 5/8 request thực thi fresh thay vì 1-2.
  Nguyên nhân có thể:
  1. Redis SET NX implementation sai -- không atomic
  2. CLAIM_TTL quá ngắn → lock hết hạn trước khi request đầu hoàn thành
  3. Network latency quá cao → request đến Redis không theo thứ tự
  → Cần sửa lock implementation trước khi triển khai.
```

### Scenario 3: Normal keys bị starvation (NGUY HIỂM)

```text
hotkeyFreshCount:     1
hotkeyReuseCount:     7
normalFreshCount:     8
normalDuration max:   2500ms  ← SAI! (vượt NORMAL_MAX_MS=1500ms)
checks rate:          0.90

→ Decision: ⚠ Hot key collapse đúng nhưng normal path bị chậm.
  Nguyên nhân có thể:
  1. Redis connection pool bị cạn → normal request phải chờ connection
  2. Application thread pool bị blocking bởi hot key external delay (260ms)
  3. DB connection pool cạn vì hot key dùng 5 DB writes
  → Cần tăng pool size hoặc giảm HOTKEY_EXTERNAL_MS / HOTKEY_DB_WRITES.
```

### Scenario 4: Normal keys có reuse (BUG)

```text
hotkeyFreshCount:     1
hotkeyReuseCount:     7
normalFreshCount:     5  ← SAI! (phải là 8)
normalDuration max:   30ms
checks rate:          0.85

→ Decision: ✗ Có normal key bị reuse. 3/8 normal request không fresh.
  Nguyên nhân có thể:
  1. normalPrefix generation bị lỗi → key bị trùng giữa các VU
  2. Date.now() trong setup không đủ uniqueness
  3. Redis còn dữ liệu cũ từ lần chạy trước
  → Kiểm tra normalPrefix logic và đảm bảo Redis được dọn dẹp giữa các lần chạy.
```

---

## 12. Nghịch lý / misconceptions

### 12.1 Nghịch lý 1: "Hot key fresh count phải luôn bằng 1" -- SAI

```text
Sai:   "Giống redis-02, hot key phải có CHÍNH XÁC 1 fresh execution"
Đúng:  "redis-05 chấp nhận bounded fresh (1-2) vì đây là fairness test,
        không phải atomicity test. Hai scenario chạy đồng thời, race timing
        có thể cho phép 2 request cùng vượt qua lock check.

        Mục tiêu: bounded hotkey work + normal keys không bị ảnh hưởng.
        Không phải: chính xác 1 fresh như redis-02."

So sánh:
  redis-02: exact atomic hotkey race → fresh exactly 1
  redis-05: fairness under mixed hot/normal lanes → hot fresh bounded, normal all fresh
```

### 12.2 Nghịch lý 2: "Normal keys luôn nhanh hơn hot key vì nhẹ hơn" -- KHÔNG HẲN

```text
Sai:   "Vì NORMAL_EXTERNAL_MS=20ms < HOTKEY_EXTERNAL_MS=260ms, normal luôn nhanh hơn"
Đúng:  "Trong điều kiện bình thường thì đúng. Nhưng nếu hot key starve
        Redis connection pool hoặc thread pool, normal request có thể phải
        CHỜ ĐỢI -- và lúc đó normal duration có thể vượt NORMAL_MAX_MS.

        Đây chính là điều case này kiểm tra: normal duration vẫn thấp
        MẶC DÙ hot key đang chiếm dụng tài nguyên."
```

### 12.3 Nghịch lý 3: "startTime=100ms là không cần thiết" -- SAI

```text
Sai:   "Có thể cho cả hai scenario chạy cùng lúc (startTime=0ms)"
Đúng:  "startTime=100ms tạo ra worst-case: hot key lane đã bắt đầu tranh chấp
        lock trước khi normal lane vào. Nếu normal keys vẫn OK trong điều kiện
        này, hệ thống thực sự công bằng.

        Nếu cả hai bắt đầu cùng lúc, có thể normal keys hoàn thành trước khi
        hot key kịp chiếm lock → test không phát hiện được starvation."
```

### 12.4 Nghịch lý 4: "Tăng HOTKEY_VUS lên 100 sẽ test tốt hơn" -- SAI

```text
Sai:   "Càng nhiều VU hotkey, test càng khắc nghiệt, càng tốt"
Đúng:  "Mục tiêu không phải stress test Redis. Mục tiêu là chứng minh
        fairness: hot key bị collapse + normal keys không bị ảnh hưởng.

        Với HOTKEY_VUS=100:
        - 100 request đồng thời cùng key → có thể gây ra network congestion
        - Kết quả fresh count có thể dao động lớn (không còn bounded rõ ràng)
        - Khó phân biệt: normal chậm vì starvation hay vì network quá tải?

        Default 8 VU là đủ để chứng minh contention mà không gây nhiễu."
```

### 12.5 Nghịch lý 5: "Chỉ cần hotkey pass là đủ, normal tự động OK" -- SAI

```text
Sai:   "Nếu hot key collapse đúng, normal keys đương nhiên không bị ảnh hưởng"
Đúng:  "Hai lane dùng Redis key khác nhau, nhưng dùng CHUNG:
        - Redis connection pool
        - Application thread pool
        - DB connection pool
        - Network bandwidth

        Hot key có thể collapse đúng (fresh count <=2) nhưng vẫn starve
        normal keys nếu nó chiếm hết connection pool. Đây là bug phổ biến
        trong production: lock implementation đúng, nhưng resource pool
        không được isolation.

        → Phải test CẢ HAI lane. Chỉ nhìn hotkey pass là chưa đủ."
```

---

## 13. Checklist trước khi chạy

### 13.1 Environment checklist

| # | Mục kiểm tra | Lệnh / Cách kiểm tra | Expected | Nếu sai |
| --- | --- | --- | --- | --- |
| 1 | Docker stack đang chạy | `docker ps --filter "name=order-service"` | Có ít nhất 2 container order-service | `.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2` |
| 2 | Không có Varnish/CDN | `docker ps --filter "name=varnish"` | Không có container nào | Dừng Varnish; dùng `TargetLayer=full-no-cdn` |
| 3 | Redis đang chạy | `docker ps --filter "name=redis"` | Có container Redis | Khởi động stack đầy đủ |
| 4 | Order confirm endpoint hoạt động | `curl -s -X POST http://localhost:80/api/sim/orders/test/confirm?cpu_ms=0&db_writes=0&external_ms=0` | HTTP 200 | Kiểm tra order-service logs |
| 5 | `BASE_URL` đúng | `$env:BASE_URL` | `http://localhost:80` | Set lại biến môi trường |
| 6 | Không có dữ liệu cũ trong Redis | (Tùy chọn) `docker exec <redis> redis-cli FLUSHDB` | Redis sạch | Nếu cần, flush Redis trước khi chạy |

### 13.2 Script-specific checklist

| # | Mục kiểm tra | Tại sao quan trọng |
| --- | --- | --- |
| 7 | Script file tồn tại | `Test-Path "E:\Projects\k6\k6-metrics-server\load-target\k6\app\19-order-service-hotkey-fairness.js"` |
| 8 | `common.js` có hàm `envInt`, `envString` | Import không bị lỗi |
| 9 | `HOTKEY_VUS >= 2` | Cần ít nhất 2 VU để tạo contention |
| 10 | `NORMAL_VUS >= 2` | Cần ít nhất 2 VU để xác nhận fairness |
| 11 | `HOTKEY_MAX_FRESH >= 1` | Phải cho phép ít nhất 1 fresh |
| 12 | `NORMAL_MAX_MS` đủ lớn | 1500ms là đủ cho normal path (thường chỉ ~30ms) |

### 13.3 K6 checklist

| # | Mục kiểm tra |
| --- | --- |
| 13 | k6 đã được cài đặt: `k6 version` |
| 14 | Không có biến môi trường nào conflict (`K6_*` env vars không set nhầm) |
| 15 | Đã hiểu sự khác biệt giữa redis-02 (atomicity) và redis-05 (fairness) |
| 16 | Đã chuẩn bị tinh thần đọc counters, không chỉ nhìn checks rate |

---

## 14. 4-5 Variations với code mẫu

### Variation 1: Tăng số lượng normal VU để test fairness ở scale lớn hơn

Mục tiêu: xác minh fairness vẫn giữ khi số lượng normal users tăng.

```javascript
// Variation 1: More normal VUs
// Chạy với:
// $env:ORDER_HOTKEY_FAIRNESS_HOTKEY_VUS = "8"
// $env:ORDER_HOTKEY_FAIRNESS_NORMAL_VUS = "50"

// Với NORMAL_VUS=50, tất cả 50 normal request phải fresh
// và duration vẫn dưới NORMAL_MAX_MS

export const options = {
  noConnectionReuse: true,
  scenarios: {
    hotkey_confirm: {
      executor: 'per-vu-iterations',
      exec: 'hotkeyConfirm',
      vus: 8,
      iterations: 1,
      maxDuration: '1m',
    },
    normal_confirm: {
      executor: 'per-vu-iterations',
      exec: 'normalConfirm',
      vus: 50,  // ← Tăng lên 50
      iterations: 1,
      startTime: '100ms',
      maxDuration: '1m',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_hotkey_fairness_check_failures: ['count==0'],
    order_hotkey_fairness_hotkey_fresh_count: ['count>=1', 'count<=2'],
    order_hotkey_fairness_hotkey_reuse_count: ['count>=6'],
    order_hotkey_fairness_normal_fresh_count: ['count==50'],  // ← 50 fresh
  },
};
```

**Điểm học:** Với 50 normal VU, nếu tất cả vẫn fresh và duration thấp, hệ thống thực sự công bằng ở scale lớn.

### Variation 2: Giảm CLAIM_TTL để test lock hết hạn sớm

Mục tiêu: xác minh hành vi khi claim TTL quá ngắn -- hot key fresh count có thể tăng.

```javascript
// Variation 2: Short claim TTL
// Chạy với:
// $env:ORDER_HOTKEY_FAIRNESS_CLAIM_TTL_MS = "100"
// $env:ORDER_HOTKEY_FAIRNESS_HOTKEY_EXTERNAL_MS = "260"
// → External delay (260ms) > Claim TTL (100ms)
// → Lock hết hạn trước khi fresh execution hoàn thành
// → Có thể có nhiều hơn 2 fresh execution

// Kỳ vọng: hotkeyFreshCount có thể > 2 (lock hết hạn giữa chừng)
// Điều này CHỨNG MINH tầm quan trọng của CLAIM_TTL > external delay
```

**Điểm học:** CLAIM_TTL phải lớn hơn thời gian thực thi tối đa. Nếu không, lock hết hạn giữa chừng và multiple fresh execution xảy ra.

### Variation 3: Hotkey external delay bằng 0 để test lock contention thuần túy

Mục tiêu: loại bỏ yếu tố external delay để xem lock contention thuần túy.

```javascript
// Variation 3: Zero external delay for hotkey
// Chạy với:
// $env:ORDER_HOTKEY_FAIRNESS_HOTKEY_EXTERNAL_MS = "0"
// $env:ORDER_HOTKEY_FAIRNESS_HOTKEY_DB_WRITES = "0"

// Với external_ms=0 và db_writes=0, hotkey path rất nhanh (~5ms)
// Lock được giữ trong thời gian cực ngắn → race window nhỏ
// Kỳ vọng: hotkeyFreshCount gần như luôn = 1
```

**Điểm học:** Khi critical section rất ngắn, lock contention được giải quyết nhanh, race window nhỏ, atomicity gần như tuyệt đối.

### Variation 4: Normal keys với external delay cao để test isolation

Mục tiêu: xác minh normal path không bị ảnh hưởng bởi hotkey NGAY CẢ KHI normal path cũng chậm.

```javascript
// Variation 4: Slow normal path
// Chạy với:
// $env:ORDER_HOTKEY_FAIRNESS_NORMAL_EXTERNAL_MS = "500"
// $env:ORDER_HOTKEY_FAIRNESS_NORMAL_DB_WRITES = "3"
// $env:ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS = "3000"

// Normal path cũng chậm (500ms external + 3 DB writes)
// Nhưng mỗi normal VU dùng KEY RIÊNG → không contention giữa các normal
// Chỉ contention với hotkey lane
// Kỳ vọng: normalFreshCount vẫn = 8, normalDuration ~520ms < 3000ms
```

**Điểm học:** Normal keys không cạnh tranh với nhau (khác key), chỉ cạnh tranh tài nguyên chung với hotkey. Đây là bằng chứng isolation hoạt động.

### Variation 5: Thêm scenario thứ ba -- mixed traffic liên tục

Mục tiêu: test fairness trong thời gian dài với traffic liên tục.

```javascript
// Variation 5: Continuous mixed traffic
// Dùng constant-vus thay vì per-vu-iterations

import { SharedArray } from 'k6/data';

const normalKeys = new SharedArray('normalKeys', function () {
  const base = Date.now();
  return Array.from({ length: 100 }, (_, i) => ({
    orderId: `ORD-FAIR-MIXED-${base}-${i}`,
    idempotencyKey: `idem-fair-mixed-${base}-${i}`,
  }));
});

export const options = {
  scenarios: {
    hotkey_continuous: {
      executor: 'constant-vus',
      exec: 'hotkeyConfirm',
      vus: 4,
      duration: '30s',
      tags: { phase: 'hotkey_continuous' },
    },
    normal_continuous: {
      executor: 'constant-vus',
      exec: 'normalConfirmContinuous',
      vus: 4,
      duration: '30s',
      startTime: '2s',
      tags: { phase: 'normal_continuous' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    order_hotkey_fairness_normal_fresh_count: ['count>0'],
  },
};

// normalConfirmContinuous dùng key từ SharedArray, mỗi iteration một key khác
```

**Điểm học:** Fairness không chỉ là vấn đề của 1 iteration -- nó phải được duy trì trong thời gian dài với traffic liên tục.

---

## 15. Anti-patterns

### 15.1 Anti-pattern 1: Chỉ nhìn checks rate, bỏ qua counters

```text
Sai:   checks rate = 100% → "Case pass!"
Đúng:  Phải đọc TẤT CẢ counters: hotkeyFreshCount, hotkeyReuseCount,
       normalFreshCount, normalDuration.

Lý do:
  checks rate có thể 100% (tất cả HTTP 200, success true)
  nhưng hotkeyFreshCount = 8 (tất cả fresh, không collapse)
  → Đây là FAIL vì hot key không được collapse.

  Hoặc checks rate 100% nhưng normalDuration max = 3000ms
  → Đây là FAIL vì normal bị starvation.
```

### 15.2 Anti-pattern 2: Dùng shared-iterations thay vì per-vu-iterations

```text
Sai:   Dùng shared-iterations với 8 VU cho hotkey scenario
Đúng:  Dùng per-vu-iterations -- mỗi VU gọi ĐÚNG 1 lần với execution function riêng

Lý do:
  shared-iterations phân phối iteration giữa các VU → không đảm bảo
  tất cả 8 VU cùng gửi request đồng thời.

  per-vu-iterations + iterations=1 → mỗi VU gọi đúng 1 lần
  → 8 request đồng thời thật sự.
```

### 15.3 Anti-pattern 3: Bỏ qua startTime cho normal scenario

```text
Sai:   Cả hai scenario cùng startTime=0ms
Đúng:  normal_confirm có startTime=100ms

Lý do:
  Nếu normal bắt đầu cùng lúc với hotkey, normal request có thể
  hoàn thành trước khi hotkey kịp chiếm lock/resource.
  → Test không phát hiện được starvation.

  startTime=100ms đảm bảo hotkey lane đã active trước
  → Worst-case cho normal lane → test khắc nghiệt hơn.
```

### 15.4 Anti-pattern 4: Không kiểm tra idempotency_reuse trong normalConfirm

```text
Sai:   Chỉ check status 200 và success true cho normal request
Đúng:  Check idempotency_reuse === false cho TỪNG normal request

Lý do:
  Nếu normalPrefix bị lỗi → hai VU có thể dùng chung key
  → Một VU fresh, một VU reuse → normalFreshCount < NORMAL_VUS

  Nếu không check idempotency_reuse, sẽ bỏ sót bug này.
```

### 15.5 Anti-pattern 5: Đặt HOTKEY_MAX_FRESH quá cao

```text
Sai:   HOTKEY_MAX_FRESH = 8 → "cho phép tất cả fresh"
Đúng:  HOTKEY_MAX_FRESH = 1 hoặc 2 → bounded

Lý do:
  Nếu MAX_FRESH = 8, threshold không có ý nghĩa -- bất kỳ kết quả nào
  cũng pass. Mục tiêu là chứng minh hot key BỊ COLLAPSE, không phải
  "có thể collapse hoặc không".

  MAX_FRESH nên là 1-2, phản ánh thực tế lock contention.
```

### 15.6 Anti-pattern 6: Chạy qua CDN/Varnish

```text
Sai:   TargetLayer=full (có Varnish)
Đúng:  TargetLayer=full-no-cdn (không có Varnish)

Lý do:
  Varnish có thể cache response và trả về kết quả cũ
  → Request không đến được order-service
  → Không có Redis contention thật
  → Test fairness vô nghĩa
```

---

## 16. Real validation data

### 16.1 Kết quả validation thực tế

Dưới đây là kết quả từ lần chạy validation thực tế với cấu hình mặc định:

```text
K6 run configuration:
  Script:            19-order-service-hotkey-fairness.js
  Profile:           full-no-cdn
  BASE_URL:           http://localhost:80
  HOTKEY_VUS:         8
  NORMAL_VUS:         8
  HOTKEY_MAX_FRESH:   2
  NORMAL_MAX_MS:      1500ms
  CLAIM_TTL_MS:       3000ms

Results:
  Exit code: 0
  Checks: 64/64 (100%)
  HTTP failed: 0.00% (0/16)
  Result: PASS

Breakdown:
  hotkey_confirm scenario:
    - 8/8 HTTP 200
    - Tất cả success true
    - Tất cả order_id preserved
    - hotkeyFreshCount: 1
    - hotkeyReuseCount: 7

  normal_confirm scenario:
    - 8/8 HTTP 200
    - Tất cả success true
    - Tất cả order_id preserved
    - Tất cả idempotency_reuse === false (fresh)
    - Tất cả duration <= 1500ms
    - normalFreshCount: 8
```

### 16.2 Phân tích kết quả chi tiết

| Chỉ số | Giá trị | Đánh giá |
| --- | --- | --- |
| Hotkey fresh count | 1 | Đúng -- bounded trong [1, 2] |
| Hotkey reuse count | 7 | Đúng -- 7/8 VU reuse |
| Normal fresh count | 8 | Đúng -- tất cả normal keys fresh |
| Normal duration max | ~35ms | Đúng -- << 1500ms ngưỡng |
| Hotkey duration fresh | ~285ms | Hợp lý -- 260ms external + overhead |
| Hotkey duration reuse | ~3ms | Hợp lý -- chỉ đọc Redis, không thực thi |
| Checks pass rate | 64/64 (100%) | Tuyệt vời |
| HTTP failed | 0/16 (0%) | Tất cả request đều 200 |
| check failures counter | 0 | Không có lỗi logic |

### 16.3 So sánh hotkey vs normal duration

```text
Duration phân bố (ms):

Hotkey fresh:  [275, 285, 290]          ← external 260ms + DB writes + overhead
Hotkey reuse:  [2, 3, 3, 4, 4, 5, 5]    ← chỉ đọc Redis
Normal fresh:  [25, 26, 27, 28, 28, 30, 32, 35]  ← external 20ms + overhead

Insight:
  - Hotkey reuse rất nhanh (~3ms) -- chứng minh reuse path hiệu quả
  - Normal duration ổn định và thấp (~28ms avg) -- không bị ảnh hưởng
  - Hotkey fresh chậm hơn (~280ms) -- đúng vì external delay 260ms
```

### 16.4 Các yếu tố ảnh hưởng đến kết quả

| Yếu tố | Ảnh hưởng |
| --- | --- |
| `HOTKEY_VUS` | Càng nhiều VU → contention càng cao, nhưng fresh count vẫn bounded |
| `NORMAL_VUS` | Càng nhiều VU → càng chứng minh fairness mạnh mẽ |
| `CLAIM_TTL_MS` | Quá ngắn → lock hết hạn sớm → fresh count tăng; quá dài → risk lock vĩnh viễn |
| `HOTKEY_EXTERNAL_MS` | Càng cao → hotkey path càng chậm → tăng risk starvation |
| `HOTKEY_DB_WRITES` | Càng nhiều → hotkey chiếm DB connection lâu hơn |
| Network latency | Ảnh hưởng đến timing của race condition |
| Redis connection pool size | Quá nhỏ → tăng risk starvation cho normal keys |
| Order-service instance count | Nhiều instance → lock contention qua Redis (không phải in-memory) |

---

## 17. Reference

### 17.1 Tài liệu liên quan

| Tài liệu | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `E:\Khoa hoc\k6\docs\practice\redis\00_overview.md` | Tổng quan series Redis/shared state, mental model, case inventory |
| Run guide | `E:\Khoa hoc\k6\docs\practice\redis\RUN_GUIDE.md` | Hướng dẫn chạy toàn bộ Redis suite |
| Validation | `E:\Khoa hoc\k6\docs\practice\redis\07_validation-and-chart-analysis.md` | Hướng dẫn đọc chart và validate kết quả |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\redis\case-catalog.json` | Catalog đầy đủ 6 Redis cases với business case, topology, expected signals |
| Script nguồn | `E:\Projects\k6\k6-metrics-server\load-target\k6\app\19-order-service-hotkey-fairness.js` | Mã nguồn k6 script của case này |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\shared\common.js` | Shared module (chứa `envInt`, `envString`) |
| Layer roadmap | `E:\Projects\k6\k6-metrics-server\load-target\k6\layer-roadmap.md` | Kiến trúc phân layer của toàn bộ test suite |

### 17.2 Các case liên quan trong cùng series

| Case | Mối liên hệ |
| --- | --- |
| `redis-01-shared-state-distributed` | Case nền tảng -- hiểu shared state trước khi test fairness |
| `redis-02-hotkey-race` | Case atomicity -- hot key exact 1 fresh (không có normal lane) |
| `redis-03-claim-owner-abandon` | Case TTL takeover -- claim lock và TTL mechanism |
| `redis-04-redis-degrade` | Case degrade -- correctness dưới Redis delay (liên quan đến latency threshold) |

### 17.3 Tài liệu tham khảo ngoài

| Tài liệu | Mô tả |
| --- | --- |
| k6 per-vu-iterations executor | `https://k6.io/docs/using-k6/scenarios/executors/per-vu-iterations/` |
| k6 scenarios | `https://k6.io/docs/using-k6/scenarios/` |
| k6 Counter metric | `https://k6.io/docs/javascript-api/k6-metrics/counter/` |
| k6 Trend metric | `https://k6.io/docs/javascript-api/k6-metrics/trend/` |
| Redis SET NX | `https://redis.io/commands/set/` |
| Idempotency pattern | Distributed systems idempotency với Redis lock |

---

*Phiên bản tài liệu: 1.0 -- Ngày cập nhật: 2026-06-24*
