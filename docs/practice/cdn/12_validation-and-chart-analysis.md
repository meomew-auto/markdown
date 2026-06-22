# CDN / Varnish validation and chart analysis

> **File tổng hợp validation cho toàn bộ 11 CDN capability cases**
> **Ngày tổng hợp**: 2026-06-22
> **Layer**: CDN / Varnish
> **Môi trường**: `TargetLayer=full`

---

## 1. Mục đích

File này tổng hợp kết quả chạy thực tế của 11 CDN capability cases, phân tích cross-case pattern, so sánh phương pháp validation CDN với executor, và đưa ra hướng dẫn đọc dashboard cho CDN layer.

**Nguyên tắc**:
- Không bịa số. Mọi con số đều từ run logs thực tế trong `.claude-cdn-case-outputs/`.
- Với case chưa có run thật, ghi `pending` và mô tả expected evidence.
- Mọi diễn giải tiếng Việt có dấu đầy đủ.

---

## 2. Validation environment

```text
Required topology: TargetLayer=full
Public URL:        http://localhost:80    (qua Varnish CDN)
Control URL:       http://localhost:8088  (ops/control direct)
Catalog events URL: http://localhost:9091 (event mock)
OPS_AUTH_TOKEN:    redacted
```

**Stack khởi động**:
```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full -ScaleApp 2
```

**Env vars bắt buộc**:
```powershell
$env:BASE_URL = "http://localhost:80"
$env:CONTROL_BASE_URL = "http://localhost:8088"
$env:CATALOG_EVENTS_BASE_URL = "http://localhost:9091"
$env:OPS_AUTH_TOKEN = "<ops-token>"
```

---

## 3. Preflight checklist

| # | Check | Command | Expected | Observed |
| --- | --- | --- | --- | --- |
| 1 | `GET /health` public `:80` | `curl http://localhost:80/health` | 200 | 200 |
| 2 | `GET /health` control `:8088` | `curl http://localhost:8088/health` | 200 | 200 |
| 3 | `GET /health` events `:9091` | `curl http://localhost:9091/health` | 200 | 200 |
| 4 | Target routing | `check-target-routing.ps1 -TargetLayer full` | pass | PASS, 37/37 routes |
| 5 | Control profile with token | control/routing probes with token redacted | 200 | PASS via route + scenario control checks |
| 6 | Origin healthy | scenario setup `resetOriginProfile()` | `healthy: true` before stateful cases | PASS |
| 7 | Origin request counts endpoint | stateful cases 09/10/11 | 200 + JSON | PASS |
| 8 | Cache ban-url endpoint | setup in cases 01/02/04/08/09/10/11 | 200 | PASS |
| 9 | Catalog events endpoint | case 06 event flow | 200 | PASS |
| 10 | Tất cả route app đã sẵn sàng | routing + full runtime suite | app routes ready | PASS |

---

## 4. Runtime summary — bảng tổng hợp 11 case

### 4.1. Tổng quan kết quả

| # | Case | Script | Exit | Checks rate | HTTP failed | Iteration duration | Primary observation | Result |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 01 | HIT smoke | `01-hit-smoke.js` | 0 | 100% (21617/21617) | 0.00% (0/2703) | sustained run | MISS -> HIT sustained | **PASS** |
| 02 | Variant keys | `02-variant-keys.js` | 0 | 100% (3720/3720) | 0.00% (0/600) | deterministic sequence | 5 variant pairs MISS/HIT isolation | **PASS** |
| 03 | Bypass rules | `03-bypass-rules.js` | 0 | 100% (54/54) | 0.00% (0/8) | single iteration | 4 bypass types not HIT | **PASS** |
| 04 | Query normalization | `04-query-normalization.js` | 0 | 100% (36/36) | 0.00% (0/6) | single iteration | tracking params HIT, business param MISS/HIT | **PASS** |
| 05 | Invalidation ops | `05-invalidation-ops.js` | 0 | 100% (42/42) | 0.00% (0/23) | single iteration | purge/ban-url/ban-tag -> MISS | **PASS** |
| 06 | Invalidation events | `06-invalidation-events.js` | 0 | 100% (46/46) | 0.00% (0/23) | single iteration | event -> MISS for detail/recs/search/homefeed | **PASS** |
| 07 | Cache contract | `07-cache-contract.js` | 0 | 100% (22/22) | 0.00% (0/4) | single iteration | headers + 304 revalidation | **PASS** |
| 08 | TTL expiry | `08-ttl-expiry.js` | 0 | 100% (9/9) | 0.00% (0/4) | TTL wait | HIT -> wait TTL -> MISS | **PASS** |
| 09 | Stale while error | `09-stale-while-error.js` | 0 | 100% (22/22) | 0.00% (0/24) | stale/recovery wait | stale HIT while origin unhealthy; stale/recovery checks verified | **PASS** |
| 10 | Request coalescing | `10-request-coalescing.js` | 0 | 100% (24/24) | 0.00% (0/27) | origin delay burst | batch success, follow-up HIT, origin count <= 2 | **PASS** |
| 11 | Negative caching | `11-negative-caching.js` | 0 | 100% (15/15) | 30.00% (3/10) | negative TTL wait | MISS→HIT→MISS; origin count 1→2 | **PASS** |

### 4.2. Chi tiết checks breakdown cho các case đã chạy

**Case 09 — Stale while error (PASS)**:
```
✓ reset origin profile status 200
✓ reset origin request counts status 200
✓ ban-url ... status 200
✓ stale first status 200
✓ stale first cache state MISS
✓ stale second status 200
✓ stale second cache state HIT
✓ set origin profile status 200
✓ stale after origin unhealthy status 200
✓ stale after origin unhealthy cache state HIT
✓ stale after origin unhealthy X-Cache-Stale equals true
✓ stale after origin unhealthy X-Cache-Backend-Healthy equals false
✓ origin request counts status 200
```

**Case 10 — Request coalescing rerun (PASS)**:
```
✓ reset origin profile status 200
✓ reset origin request counts status 200
✓ ban-url ... status 200
✓ coalescing batch 0 status 200
✓ coalescing batch 1 status 200
✓ coalescing after warm status 200
✓ coalescing after warm cache state HIT
✓ origin request counts status 200
```
HTTP metrics: `http_req_duration: avg=179.38ms, max=803.59ms` — thể hiện delay từ origin (800ms `COALESCE_ORIGIN_DELAY_MS`).

**Case 11 — Negative caching rerun (PASS)**:
```
✓ reset origin profile status 200
✓ reset origin request counts status 200
✓ ban-url ... status 200
✓ negative first status 404
✓ negative first cache state MISS
✓ negative first X-Negative-Cache equals true
✓ negative second status 404
✓ negative second cache state HIT
✓ negative second X-Negative-Cache equals true
✓ origin request counts status 200
✓ negative after expiry status 404
✓ negative after expiry cache state MISS
```
HTTP metrics: `http_req_failed: 30.00%` — expected vì 3 response 404.

---

## 5. Special proof table cho cases 09-11

Đây là các case cần evidence từ header/counter ngoài cache state thông thường:

### 5.1. Case 09 — Stale while origin error

| Evidence | Expected | Observed (PASS) | Verified? |
| --- | --- | --- | --- |
| `X-Cache-Stale` | `true` | `true` | Yes |
| `X-Cache-Backend-Healthy` | `false` | `false` | Yes |
| `X-Cache` after origin unhealthy | `HIT` | `HIT` | Yes |
| HTTP status after origin unhealthy | `200` | `200` | Yes |
| Origin request count | `1` (chỉ warm, không gọi thêm) | Verified (không throw error) | Yes |
| `X-Cache-Stale` absent on warm requests | Không có | Không có | Yes |

### 5.2. Case 10 — Request coalescing

| Evidence | Expected | Observed | Verified? |
| --- | --- | --- | --- |
| Batch response status | 200 for all | all batch status checks passed | Yes |
| Follow-up cache state | `HIT` | `HIT` | Yes |
| Origin request count | `<= 2` | script counter assertion passed | Yes |
| `http_req_failed` | `0.00%` | `0.00% (0/27)` | Yes |
| Checks | 100% | `24/24` | Yes |

**Ghi chú**: Issue cũ là case 10 fail khi chạy ngay sau case 09 vì backend/CDN health chưa recover đủ nhanh. Sau fix, full sequential suite chạy `09 -> 10` trực tiếp và case 10 pass, nên race này đã được verify fixed.

### 5.3. Case 11 — Negative caching

| Evidence | Expected | Observed | Verified? |
| --- | --- | --- | --- |
| First response | 404 MISS | check passed | Yes |
| `X-Negative-Cache` first | `true` | check passed | Yes |
| Second response | 404 HIT | check passed | Yes |
| Origin count before expiry | `1` | script counter assertion passed | Yes |
| After expiry response | 404 MISS | check passed | Yes |
| Origin count after expiry | `2` | script counter assertion passed | Yes |
| `http_req_failed` rate | `~30%` expected 404s | `30.00% (3/10)` | Yes — expected |

**Ghi chú**: Với case 11, `http_req_failed=30%` không phải defect. Đây là hệ quả của 3 response 404 expected trong negative caching proof; pass/fail phải đọc bằng checks, `X-Negative-Cache`, cache sequence và origin counters.

---

## 6. Cross-case pattern analysis

### 6.1. Pattern nào lặp lại?

**Pattern 1 — MISS → HIT sequence (xuất hiện trong 8/11 case)**

Hầu hết các case đều dùng pattern: ban/purge URL → first request MISS → second request HIT.

| Case | Warm-up pattern | Số request warm-up |
| --- | --- | --- |
| 01 | `banUrl` → first MISS → second HIT | 2 |
| 02 | `banUrl` → first MISS → second HIT (x5 variant pairs) | 20 |
| 04 | `banPrefix` → canonical MISS → canonical HIT | 4 |
| 05 | `purgeUrl`/`banUrl` → warm MISS → warm HIT → purge → MISS | 6+ |
| 06 | `banUrl` → warm MISS → warm HIT → event → MISS | 8+ |
| 08 | `banUrl` → first MISS → second HIT → wait TTL → MISS | 3 |
| 09 | `banUrl` → first MISS → second HIT → set unhealthy → stale HIT | 3 |
| 10 | `banUrl` → batch → follow-up HIT | 13 |
| 11 | `banUrl` → first 404 MISS → second 404 HIT → wait TTL → 404 MISS | 3 |

**Pattern 2 — Origin request count làm evidence định lượng (case 09, 10, 11)**

Ba case cuối đều dùng `getOriginRequestCounts()` + `findOriginRequestCount()` như evidence cuối cùng, không chỉ dựa vào cache state.

**Pattern 3 — Control plane setup là prerequisite (case 05, 06, 09, 10, 11)**

5/11 case yêu cầu control plane (`:8088`) để setup (purge, ban, set origin profile, reset counter) trước khi test public path.

**Pattern 4 — `resetOriginProfile()` trong setup và teardown (case 09, 10, 11)**

Ba case cuối đều phải reset origin profile về healthy để không bị ảnh hưởng bởi case trước (đặc biệt case 09 set origin unhealthy).

### 6.2. Case nào khó nhất?

Xếp hạng độ khó của 11 case (1 = dễ nhất, 11 = khó nhất):

| Rank | Case | Độ khó | Lý do |
| --- | --- | --- | --- |
| 1 | 01 HIT smoke | Thấp | Chỉ cần MISS→HIT, không có control plane phức tạp |
| 2 | 08 TTL expiry | Thấp | Giống case 01 + sleep, nhưng cần chờ 21s |
| 3 | 03 Bypass rules | Thấp | Chỉ cần assert NOT HIT, không cần control |
| 4 | 07 Cache contract | Trung bình | Cần check nhiều header cùng lúc |
| 5 | 04 Query normalization | Trung bình | Cần hiểu query param semantics |
| 6 | 02 Variant keys | Trung bình | 5 variant pairs, dễ nhầm expected cache key |
| 7 | 05 Invalidation ops | Trung bình | 3 loại invalidation, cần warm-up trước khi test |
| 8 | 06 Invalidation events | Trung bình | Event-driven, cần mock catalog event |
| 9 | 11 Negative caching | Cao | 404 là expected, dễ hiểu sai; cần origin counter; cần sleep |
| 10 | 10 Request coalescing | Cao | Cần batch concurrent, origin delay, counter proof |
| 11 | 09 Stale while error | Rất cao | Cần set origin unhealthy, chờ TTL, verify stale headers, reset teardown |

### 6.3. Điểm khác biệt giữa case đơn giản và phức tạp

| Khía cạnh | Case đơn giản (01, 03, 08) | Case phức tạp (09, 10, 11) |
| --- | --- | --- |
| Số assertion | 3-6 checks | 10-15 checks |
| Control plane | Không hoặc ít | Nhiều (profile, counter, purge) |
| Sleep/wait | Không hoặc ít (case 08: 21s) | Có (case 09: 7s, case 10: ~0.8s, case 11: 6s) |
| State ảnh hưởng case sau | Thấp | Cao (origin profile unhealthy) |
| Evidence định lượng | Cache state + status | Cache state + status + origin counter + special headers |
| Dễ false positive? | Thấp | Cao (HIT có thể từ object khác, counter có thể sai) |
| Dễ false negative? | Thấp | Cao (404 bị coi là fail, origin delay gây timeout) |

### 6.4. Phân tích dependency graph giữa các case

```text
Case 01 (HIT smoke) — foundation
  ├── Case 02 (Variant keys) — mở rộng: nhiều cache key
  ├── Case 03 (Bypass rules) — mở rộng: private traffic
  ├── Case 04 (Query normalization) — mở rộng: query params
  ├── Case 05 (Manual invalidation) — mở rộng: control plane purge
  │     └── Case 06 (Event invalidation) — mở rộng: automated invalidation
  ├── Case 07 (Cache contract) — mở rộng: response headers
  ├── Case 08 (TTL expiry) — mở rộng: time-based cache
  │     ├── Case 09 (Stale while error) — mở rộng: stale serving
  │     ├── Case 10 (Request coalescing) — mở rộng: concurrency
  │     └── Case 11 (Negative caching) — mở rộng: error caching
```

**Dependency ngược**:
- Case 09, 10, 11 đều phụ thuộc vào control plane từ case 05.
- Case 09 để lại state (origin unhealthy) ảnh hưởng case 10 và 11.
- Case 10 và 11 không phụ thuộc lẫn nhau, nhưng đều cần origin healthy.

### 6.5. Case nào dễ bị false positive nhất?

**Case 10 (Request coalescing)** là case dễ false positive nhất:

```text
Tại sao:
  - Tất cả response 200 + follow-up HIT → nhìn như PASS
  - Nhưng nếu không check origin count, không biết coalescing có hoạt động không
  - CDN có thể không coalesce nhưng vẫn cache object → user thấy HIT, origin bị gọi 12 lần

Cách tránh:
  - Luôn check origin request count <= 2
  - Nếu count > 2, COALESCE FAIL dù tất cả status 200
```

**Case 11 (Negative caching)** là case dễ false negative nhất:

```text
Tại sao:
  - 404 bị coi là HTTP failure → test framework có thể tự động fail
  - Nếu dùng http_req_failed threshold, luôn fail
  - Người đọc output thấy 30% failed → kết luận sai là "có vấn đề"

Cách tránh:
  - Không set http_req_failed threshold cho case 11
  - Đọc checks list, không đọc HTTP failed rate
```

### 6.6. Ma trận tương tác giữa các case

| Case | Cần control plane? | Cần origin healthy? | Cần sleep? | Để lại state bẩn? | Bị ảnh hưởng bởi case trước? |
| --- | --- | --- | --- | --- | --- |
| 01 | Không | Có | Không | Không | Không |
| 02 | Không | Có | Không | Không | Không |
| 03 | Không | Có | Không | Không | Không |
| 04 | Có (banPrefix) | Có | Không | Không | Không |
| 05 | Có (purge/ban) | Có | Không | Không | Không |
| 06 | Có (ban, event) | Có | Không | Không | Không |
| 07 | Không | Có | Không | Không | Không |
| 08 | Có (banUrl) | Có | Có (21s) | Không | Không |
| 09 | Có (profile, counter) | Có → Không | Có (7s) | **Có** (origin unhealthy) | Cần origin healthy từ case trước |
| 10 | Có (profile, counter) | **Có** | Không (origin delay) | Không (có teardown) | **Có** (cần origin healthy) |
| 11 | Có (profile, counter) | **Có** | Có (6s) | Không (có teardown) | **Có** (cần origin healthy) |

---

## 7. So sánh CDN validation với executor validation

### 7.1. Bảng so sánh tổng quan

| Khía cạnh | Executor validation | CDN validation |
| --- | --- | --- |
| **Câu hỏi chính** | "Traffic shape có đúng không?" | "Cache contract có đúng không?" |
| **Evidence chính** | Throughput (RPS), latency (p95/p99), iteration duration | Header sequence (X-Cache, X-Cache-Stale), cache state, origin counter |
| **Số liệu quan trọng** | `http_reqs`, `http_req_duration`, `iterations` | `checks`, `X-Cache` sequence, origin request counts |
| **Pass/fail criteria** | Thresholds (`rate>0.95`, `p(95)<200ms`) | Check 100% + origin count chính xác |
| **HTTP status expectation** | Hầu như luôn 200 | 200, 304, 404 — tùy case |
| **http_req_failed threshold** | Luôn set (`rate<0.01` hoặc `rate==0`) | Có case không set (case 11: 404 là expected) |
| **Duration** | 10s-30m (load test) | 0.8ms-31s (correctness proof) |
| **VUs** | 10-1000 (tạo tải) | 1 (tuần tự) |
| **Iterations** | Hàng nghìn đến hàng triệu | 1 (single-run proof) |
| **Concurrent?** | Luôn có | Chỉ case 10 (coalescing) |
| **Cần control plane?** | Không | Có (5/11 case) |
| **State management** | Stateless | Stateful (cache, origin profile, counter) |
| **Chạy song song?** | Có thể (nếu isolate) | Không (shared cache/control state) |
| **Output chính** | Dashboard chart, summary statistics | Check list, header table, origin count |

### 7.2. Khi nào dùng executor validation, khi nào dùng CDN validation?

```text
Executor validation:
  - Khi cần biết: "Hệ thống chịu được bao nhiêu RPS?"
  - Khi cần biết: "P95 latency ở 1000 VUs là bao nhiêu?"
  - Khi cần chứng minh: "Có thể scale lên N concurrent users"
  - Dùng: constant-vus, ramping-vus, shared-iterations

CDN validation:
  - Khi cần biết: "Cache có hoạt động đúng không?"
  - Khi cần biết: "Purge có invalidate object không?"
  - Khi cần biết: "Origin có bị gọi quá nhiều không?"
  - Dùng: single-VU, 1 iteration, control endpoints
```

### 7.3. Tại sao không thể dùng executor benchmark thay thế CDN test?

1. **Executor benchmark không thấy `X-Cache` header**: Benchmark chỉ quan tâm latency và throughput. Nó không kiểm tra sequence MISS→HIT→stale→MISS.

2. **Executor benchmark không có control plane**: Không thể purge/ban, không thể set origin unhealthy, không thể đọc origin counter.

3. **Executor benchmark không phân biệt 200 từ cache vs 200 từ origin**: 200 HIT và 200 MISS đều có latency khác nhau, nhưng benchmark không biết object đến từ đâu.

4. **Executor benchmark không test được negative caching**: Với benchmark, 404 là HTTP failure cần tránh. Với CDN test, 404 là expected outcome.

5. **Executor benchmark không test được invalidation correctness**: Purge xong mà object vẫn HIT — benchmark không phát hiện được. CDN test phát hiện ngay vì check cache state sequence.

---

## 8. Diễn giải quan trọng về pass/fail

### 8.1. Cache state sequence quan trọng hơn status code

```text
Nguyên tắc số 1 của CDN validation:
  HIT/MISS/BYPASS/stale sequence > HTTP status code

Ví dụ:
  Status 200 + X-Cache: MISS → PASS về mặt HTTP, nhưng FAIL về mặt CDN nếu expected HIT
  Status 404 + X-Cache: HIT  → FAIL về mặt HTTP, nhưng PASS về mặt CDN (case 11)
```

### 8.2. Control endpoint 200 != proof

```text
Nguyên tắc số 2:
  Control endpoint returning 200 is setup evidence, not final proof.
  Final proof is the NEXT public request showing the expected cache effect.

Ví dụ:
  ban-url trả 200 → setup OK
  Nhưng request tiếp theo vẫn HIT → ban không hoạt động
  → Kết luận: FAIL (mặc dù control trả 200)
```

### 8.3. Origin counter là evidence vàng

```text
Nguyên tắc số 3:
  X-Cache: HIT có thể là false positive.
  Chỉ origin request count mới chứng minh origin không bị gọi.

Ví dụ (case 11):
  Second request: X-Cache: HIT ✓
  Nhưng origin count = 3 → object đến từ đâu đó khác, không phải negative cache
  → Kết luận: FAIL
```

### 8.4. http_req_failed không áp dụng cho mọi case

```text
Nguyên tắc số 4:
  Không set http_req_failed threshold cho case có expected non-200.

  Case 01-10: http_req_failed: ['rate==0'] → hợp lý
  Case 11:     KHÔNG set http_req_failed threshold → 30% là bình thường
```

### 8.5. Teardown quan trọng không kém setup

```text
Nguyên tắc số 5:
  Teardown phải reset state để không ảnh hưởng case sau.

  Case 09: set origin unhealthy trong default → teardown reset healthy
  Case 10: cần origin healthy → nếu case 09 không reset, case 10 fail
  Case 11: cần origin healthy → tương tự
```

Bài học thực tế: Lần chạy đầu của case 10 fail vì chạy ngay sau case 09 mà không có bước reset origin profile thủ công giữa các lần chạy. Khi chạy qua runner script `run-cdn-capabilities.ps1 -Scenarios all`, runner sẽ gọi teardown đúng thứ tự.

---

## 9. Phân tích dashboard/chart cho CDN cases

### 9.1. Đánh giá pass/fail đã đủ chưa?

**Có.** Với CDN layer, kết luận pass/fail không phụ thuộc dashboard. Full runtime suite đã đủ evidence để kết luận vì mỗi case encode contract bằng checks:

```text
Full runtime: 11/11 scenarios passed
Checks: 100% cho tất cả case
Routing: 37/37 pass
Case 09/10/11: có thêm header/counter proof
Case 11: http_req_failed=30% là expected do 404 negative caching
```

Dashboard/chart chỉ là **supporting evidence** để nhìn hình dạng thời gian, latency và status mix. Chart không thay thế được `X-Cache`, `X-Cache-Stale`, `X-Negative-Cache`, `Surrogate-Key`, hoặc origin request counters.

### 9.2. Vì sao chart của CDN khác chart của executor?

| Điểm đọc | Executor docs | CDN docs |
| --- | --- | --- |
| Mục tiêu chart | Chứng minh traffic shape, throughput, latency dưới tải | Quan sát timing/state transition của cache proof |
| RPS/VUs | Rất quan trọng | Ít quan trọng, đa số case 1 VU/1 iteration |
| Latency p95/p99 | Evidence chính | Chỉ là phụ trợ; cache correctness mới là chính |
| Status code | Gần như luôn mong 2xx | Có 200, 304, và expected 404 |
| Tags/checks | Hữu ích | Bắt buộc để đọc từng bước MISS/HIT/stale/negative |
| Counter/header evidence | Thường không cần | Bắt buộc cho 09/10/11 |

Nói ngắn gọn: executor chart trả lời **“traffic có đúng shape không?”**. CDN chart chỉ giúp giải thích **“các bước proof xảy ra theo thời gian như thế nào?”**.

### 9.3. Chart nên đọc theo từng nhóm case

| Nhóm case | Chart nên xem | Dạng chart expected | Không được kết luận chỉ từ chart |
| --- | --- | --- | --- |
| 01 HIT smoke | checks, request timeline, latency by tag | một đoạn sustained traffic, checks 100%, request failed 0% | không thể biết HIT nếu không đọc `X-Cache` checks |
| 02 Variant keys | checks by tag/group | nhiều cụm request nhỏ cho từng variant | hit ratio cao không chứng minh không leakage |
| 03 Bypass rules | checks + status codes | status 200, checks 100%, failed 0% | chart không cho biết request có bypass hay không |
| 04 Query normalization | checks by tag | canonical/tracking/business-param sequence đều pass | RPS/latency không chứng minh query normalization đúng |
| 05 Manual invalidation | checks timeline | warm HIT trước invalidation, next request pass MISS check | control 200 trên chart không đủ; phải có next public MISS |
| 06 Event invalidation | checks timeline + status | event call 200, affected public requests pass MISS check | event endpoint 200 không chứng minh invalidation nếu thiếu public MISS |
| 07 Cache contract | status code mix | 200 + 304, checks 100% | 304 phải đi kèm ETag/If-None-Match checks |
| 08 TTL expiry | request timeline | gap theo `TTL_WAIT_SECONDS`, after-expiry request pass MISS check | latency sau wait không tự chứng minh TTL |
| 09 Stale while error | timeline, status, checks | warm MISS/HIT, wait, stale probe 200, failed 0% | 200 không chứng minh stale; cần `X-Cache-Stale=true` và backend unhealthy header |
| 10 Request coalescing | batch latency, checks, failed rate | burst ngắn, all 200, follow-up HIT, failed 0% | all 200 không chứng minh coalescing; cần origin count `<=2` |
| 11 Negative caching | status code mix, request timeline | expected 404s, `http_req_failed≈30%`, checks 100% | HTTP failed chart nhìn đỏ nhưng không phải fail |

### 9.4. Chart-by-chart deep dive

#### Checks rate over time

Đây là chart dashboard quan trọng nhất cho CDN suite.

Expected:

```text
checks rate = 100% từ đầu đến cuối
không có drop ở case 09 -> 10
không có drop ở case 11 dù status là 404
```

Nếu chart có drop:

- drop ở setup checks → control plane/token/routing issue;
- drop ở cache-state checks → VCL/cache behavior issue;
- drop ở header checks → origin/VCL header contract issue;
- drop ở counter checks → origin offload/coalescing/stale proof issue.

#### HTTP failed rate

Không đọc giống executor.

| Case | Expected `http_req_failed` | Diễn giải |
| --- | --- | --- |
| 01-10 | `0.00%` | mọi request trong proof là expected 2xx/304 behavior |
| 11 | khoảng `30%` trong run hiện tại | 3 response 404 expected trong 10 HTTP requests |

Vì vậy dashboard `http_req_failed` đỏ ở case 11 là **false alarm nếu checks vẫn 100%**.

#### HTTP status codes

Expected status mix:

- case 01-06, 08-10: chủ yếu 200;
- case 07: 200 + 304 revalidation;
- case 11: 404 là expected business outcome.

Nếu dashboard gom cả suite, status-code chart có thể làm người đọc nhầm rằng 404 là lỗi. Cách đọc đúng là filter theo `scenario=cdn_negative_caching` hoặc đọc cùng checks.

#### HTTP request duration / latency

Latency chỉ là support signal:

- HIT thường nhanh hơn MISS, nhưng local Docker noise có thể che khác biệt.
- Case 08/09/11 có sleep/wait nên **iteration duration** dài; đó không phải latency backend.
- Case 10 có `origin_delay_ms` để tạo cold burst; latency batch có thể cao hơn follow-up HIT.
- Nếu case 10 all 200 nhưng origin counter cao, latency chart vẫn không đủ để pass.

Nguyên tắc: latency chart giúp hiểu “request nào phải đợi origin”, nhưng không chứng minh cache correctness.

#### Request timeline

Chart này hữu ích nhất để dạy flow:

```text
Case 08: MISS -> HIT -> sleep TTL -> MISS
Case 09: MISS -> HIT -> sleep TTL -> set unhealthy -> stale HIT
Case 10: concurrent batch -> follow-up HIT
Case 11: 404 MISS -> 404 HIT -> sleep negative TTL -> 404 MISS
```

Nếu timeline không có gap ở case 08/09/11, nghĩa là env wait bị override sai hoặc script không chạy đúng path.

#### VUs / iterations

Expected:

- hầu hết cases: `vus=1`, `iterations=1`;
- case 01 có sustained traffic theo config riêng;
- case 10 tạo concurrency bằng `http.batch`, không phải bằng nhiều VUs.

Nếu dashboard cho thấy nhiều VUs ở case 02/05/06/08/09/11, kết quả có thể bị nhiễu vì CDN cases phụ thuộc sequence deterministic.

### 9.5. Đọc chart cho issue cũ `09 -> 10`

Trước fix, nếu nhìn dashboard, pattern sẽ là:

```text
case 09: checks 100%, http failed 0%
case 10 ngay sau đó: checks drop mạnh, http failed spike
```

Dễ kết luận nhầm là coalescing hỏng. Nhưng evidence đúng cho thấy case 10 pass isolated và pass nếu chờ recovery, nên root cause là recovery race giữa stale test và coalescing test.

Sau fix, full sequential run expected chart:

```text
case 09: checks 100%, failed 0%
case 10: checks 100%, failed 0%
không còn spike failure giữa hai case
```

Đây là giá trị chính của dashboard ở đây: nhìn được **transition giữa case 09 và case 10** đã sạch.

### 9.6. Chart KHÔNG nên dùng làm pass/fail proof

| Chart | Vì sao không đủ |
| --- | --- |
| RPS | CDN correctness suite quá nhỏ; RPS thấp không có ý nghĩa capacity |
| Aggregate p95/p99 toàn suite | bị sleep của case 08/09/11 và origin delay case 10 làm méo |
| Hit ratio tổng | có thể cao nhưng vẫn variant leakage hoặc invalidation fail |
| Status code tổng | case 11 intentionally 404; aggregate status dễ gây false negative |
| Network I/O | payload nhỏ; không chứng minh cache state |

### 9.7. Nếu muốn dashboard/cloud evidence thật

Run hiện tại là local validation. Nếu muốn phần chart giống executor theo nghĩa có run ID/screenshot, cần thêm một pass có output dashboard/cloud, rồi điền:

```text
run id / dashboard URL
screenshots hoặc exported panels
checks-over-time panel
status-code panel
http_req_duration by scenario/tag
request timeline cho case 08/09/10/11
```

Nhưng đây là **bổ sung trình bày**, không phải điều kiện để kết luận CDN pass/fail. Với evidence hiện tại, phần đánh giá correctness đã đủ.

### 9.8. Cách export evidence cho audit

```powershell
# Export JSON summary
k6 run .\k6\cdn\11-negative-caching.js --summary-export cdn-11-summary.json

# Export chi tiết từng event/check
k6 run .\k6\cdn\11-negative-caching.js --out json=cdn-11-results.json

# Lưu console output
k6 run .\k6\cdn\11-negative-caching.js 2>&1 | Tee-Object cdn-11-console.txt
```

---

## 10. Common invalid-result patterns

### 10.1. Bảng tổng hợp invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng | Case liên quan |
| --- | --- | --- | --- |
| Status 200 nhưng `X-Cache` sai | App trả OK nhưng CDN contract fail | Luôn kiểm sequence HIT/MISS/BYPASS/stale | 01, 02, 05, 06 |
| Hit ratio cao nhưng variant leakage | Cache nhanh nhưng serve sai audience | Kiểm `X-Cache-Key-*` và response body variant | 02 |
| Purge/ban trả 200 nhưng next request vẫn HIT | Control plane không invalidated object thật | Warm -> invalidate -> request lại phải MISS | 05, 06 |
| Event gửi thành công nhưng cache không MISS | Event pipeline không trigger invalidation | Check event response body `success=true` + next request MISS | 06 |
| Expected 404 bị coi là fail | Negative caching dùng 404 làm expected outcome | Case 11 pass bằng checks/cache headers/origin count | 11 |
| Stale case pass vì status 200 | 200 có thể là origin hoặc stale | Cần `X-Cache-Stale=true`, backend healthy=false, origin count không tăng | 09 |
| Coalescing all 200 nhưng origin count cao | User thấy OK nhưng origin bị stampede | Origin count <= 2; nếu >2, coalescing fail | 10 |
| TTL case: vẫn HIT sau sleep | TTL chưa hết hạn hoặc VCL ghi đè TTL | Tăng wait time hoặc kiểm tra VCL `beresp.ttl` | 08, 11 |
| Chạy cases song song | Shared cache/control state làm nhiễu proof | Luôn chạy tuần tự, reset state theo case | Tất cả |
| Quên reset origin profile | Origin unhealthy từ case trước làm fail case sau | Luôn `resetOriginProfile()` trong setup và teardown | 09, 10, 11 |
| `http_req_failed` threshold quá cứng | Case 11 có HTTP fail expected | Không set threshold cho case 11 | 11 |
| Không check teardown hoàn thành | State bẩn cho case sau | Verify teardown không throw error | 09, 10, 11 |

### 10.2. Phân tích chi tiết 3 pattern nguy hiểm nhất

**Pattern A — Variant leakage (case 02)**

```text
Nguy hiểm: User VN thấy giá USD, user mobile thấy layout desktop.
           Dữ liệu cá nhân (segment) bị leak sang segment khác.

Phát hiện: X-Cache-Key-Language khác expected.
           Response body chứa ngôn ngữ sai.

Phòng tránh: Luôn test ít nhất 2 variant mỗi dimension.
             Không chỉ test MISS/HIT mà còn check response body.
```

**Pattern B — Hidden stampede (case 10)**

```text
Nguy hiểm: 1000 concurrent request cold, user thấy 200 OK,
           nhưng origin bị gọi 800 lần thay vì 1-2 lần.
           CDN không coalescing, origin bị stampede.

Phát hiện: origin request count >> 2 cho cold burst.
           http_req_duration distribution rộng (có request phải chờ origin).

Phòng tránh: Luôn dùng origin counter, không chỉ check status 200.
             Test với COALESCE_CONCURRENCY cao (20+) để chắc chắn.
```

**Pattern C — False negative do state bẩn (case 09→10→11)**

```text
Nguy hiểm: Case 09 set origin unhealthy().
           Case 10 chạy ngay sau, origin vẫn unhealthy.
           Batch request toàn bộ fail → false negative.

Phát hiện: Case 10 có http_req_failed cao bất thường.
           http_req_duration = 0s (connection refused, không có response).

Phòng tránh: Luôn chạy teardown. Luôn `resetOriginProfile()` trong setup.
             Dùng runner script thay vì chạy thủ công từng case.
```

### 10.3. Debug process khi gặp invalid result

```text
1. Xác định case nào fail → đọc error message đầy đủ.
2. Kiểm tra state: origin healthy? counter đã reset? cache đã ban?
3. Chạy curl thủ công để isolate: CDN issue hay app issue?
4. Kiểm tra VCL: có rule nào vô hiệu hóa behavior mong đợi không?
5. Kiểm tra thứ tự chạy: case trước có để lại state bẩn không?
6. Chạy lại case đó độc lập (không chạy cả suite).
7. Nếu pass khi chạy độc lập → state bẩn từ case trước.
8. Nếu vẫn fail → VCL hoặc app issue cần fix.
```

### 10.4. Flowchart chẩn đoán nhanh

```text
Case fail?
  ├── Checks < 100%?
  │     ├── Setup checks fail? → Control plane issue (token, endpoint, network)
  │     ├── Status code checks fail? → App issue (route, logic, handler)
  │     ├── Cache state checks fail? → VCL issue (cache policy, TTL, pass rules)
  │     ├── Header checks fail? → Origin response issue (thiếu header)
  │     └── Origin count checks fail? → Cache/VCL issue (không cache, counter sai)
  │
  └── Throw Error (không phải check fail)?
        ├── "got 0" → Request không đến origin
        ├── "got N > expected" → Cache không hoạt động hoặc counter sai
        └── "missing ETag" / "did not succeed" → App response không đúng contract
```

### 10.5. So sánh tần suất lỗi theo loại case

Dựa trên kinh nghiệm chạy thực tế:

| Loại lỗi | Case thường gặp | Tần suất | Mức độ nghiêm trọng |
| --- | --- | --- | --- |
| VCL config sai | 09, 10, 11 | Trung bình | Cao — toàn bộ cache behavior sai |
| App route chưa sẵn sàng | 11 | Cao (first run) | Thấp — fix bằng cách chờ app ready |
| Token ops hết hạn | 05, 06, 09, 10, 11 | Thấp | Trung bình — cần refresh token |
| State bẩn từ case trước | 10, 11 | Cao (nếu chạy thủ công) | Trung bình — fix bằng runner script |
| Origin counter không hoạt động | 09, 10, 11 | Thấp | Cao — không thể verify evidence |
| http_req_failed threshold sai | 11 | Cao (nếu copy config) | Thấp — bỏ threshold là xong |
| Network issue (port sai) | Tất cả | Thấp | Cao — không test được gì |

### 10.6. CDN validation maturity model

**Cấp độ 1 — Smoke only (chỉ case 01)**:
```text
Biết: CDN có cache response 200 không.
Chưa biết: variant isolation, invalidation, TTL, stale, coalescing, negative caching.
Rủi ro: variant leakage, purge không hoạt động, origin stampede.
```

**Cấp độ 2 — Core cache (case 01-07)**:
```text
Biết: cache HIT, variant keys, bypass, query normalization, invalidation, headers.
Chưa biết: TTL behavior, stale serving, coalescing, negative caching.
Rủi ro: TTL không được tôn trọng, origin down thì user thấy lỗi.
```

**Cấp độ 3 — Time-based (case 01-08)**:
```text
Biết: thêm TTL expiry.
Chưa biết: stale serving, coalescing, negative caching.
Rủi ro: origin down = user thấy 503; cold burst = stampede; 404 = origin overload.
```

**Cấp độ 4 — Full contract (tất cả 11 case)**:
```text
Biết: toàn bộ cache contract.
Rủi ro: minimal — mọi edge case đã được test.
Đây là trạng thái mong muốn trước khi deploy production.
```

**Lộ trình áp dụng cho team mới**:
```text
Tuần 1: Chạy case 01-03 (HIT, variant, bypass) — nắm cơ bản.
Tuần 2: Chạy case 04-07 (query, invalidation, headers) — hiểu control plane.
Tuần 3: Chạy case 08-11 (TTL, stale, coalescing, negative) — hiểu edge cases.
Tuần 4: Tích hợp vào CI/CD — chạy tự động mỗi khi deploy.
```

---

## 11. Bài học từ thực tế chạy

### 11.1. Tầm quan trọng của runner script

Runner script `run-cdn-capabilities.ps1` không chỉ là convenience — nó đảm bảo:
- Chạy tuần tự (không song song).
- Teardown của case trước hoàn thành trước khi setup case sau.
- State isolation giữa các case.

Chạy thủ công từng case bằng `k6 run` dễ dẫn đến false negative do quên reset state.

### 11.2. Tại sao case 09-10-11 cần chạy theo thứ tự

```text
Thứ tự đúng: 09 → 10 → 11

Case 09: set origin unhealthy → teardown reset healthy
Case 10: cần origin healthy → PASS (nếu teardown case 09 hoạt động)
Case 11: cần origin healthy → PASS

Nếu case 09 không reset:
Case 10: origin unhealthy → batch request fail → FAIL
Case 11: origin unhealthy → first request fail → FAIL
```

### 11.3. First-run failure pattern

Cả case 10 và 11 đều có first-run failure:
- **Case 10 first run**: origin unhealthy từ case trước → FAIL
- **Case 11 first run**: application route chưa sẵn sàng → FAIL

Bài học: First run của các case cuối (09-11) có xác suất fail cao hơn vì:
1. Phụ thuộc state từ case trước.
2. Yêu cầu application fully initialized.
3. Cần control plane hoạt động đầy đủ.

**Khuyến nghị**: Luôn chạy preflight checklist trước khi chạy suite. Nếu first run fail, kiểm tra state và rerun — đừng kết luận bug ngay.

---

## 12. Reference

### 12.1. Source files

| File | Đường dẫn | Mô tả |
| --- | --- | --- |
| Overview | `./00_overview.md` | Tổng quan series CDN |
| Run guide | `./RUN_GUIDE.md` | Hướng dẫn chạy tất cả case |
| Case 01-11 docs | `./01_hit-smoke.md` đến `./11_negative-caching.md` | Tài liệu từng case |
| Source scripts | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\*.js` | k6 test scripts |
| Shared helpers | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\shared.js` | Helper functions |
| Run outputs | `E:\Khoa hoc\k6\.claude-cdn-case-outputs\*.txt` | Console output từng lần chạy |
| Case catalog | `E:\Projects\k6\k6-metrics-server\load-target\k6\cdn\case-catalog.json` | Catalog metadata |
| Runner script | `E:\Projects\k6\k6-metrics-server\scripts\run-cdn-capabilities.ps1` | PowerShell runner |

### 12.2. Tài liệu tham khảo ngoài

| Tài liệu | Mô tả |
| --- | --- |
| Varnish Cache docs | VCL reference, `vcl_backend_response`, `vcl_deliver` |
| HTTP Caching RFC 7234 | HTTP caching specification |
| k6 docs: Checks | https://k6.io/docs/using-k6/checks/ |
| k6 docs: Thresholds | https://k6.io/docs/using-k6/thresholds/ |
| k6 docs: Tags | https://k6.io/docs/using-k6/tags-and-groups/ |
| Fastly: Negative caching | Edge caching best practices |
| Cloudflare: Default cache behavior | CDN cache policy defaults |

---

> **Tổng kết**: CDN validation khác biệt cơ bản với executor validation. Trong khi executor hỏi "hệ thống nhanh không?", CDN validation hỏi "cache có đúng không?". Hai câu hỏi bổ trợ nhau và đều cần thiết trước khi deploy lên production. 11 CDN cases trong series này bao phủ toàn bộ cache contract: từ HIT cơ bản, variant keying, bypass rules, query normalization, invalidation (manual + event-driven), cache contract headers, TTL expiry, stale serving, request coalescing, đến negative caching. Mỗi case là một mảnh ghép của bức tranh "public edge cache correctness".
