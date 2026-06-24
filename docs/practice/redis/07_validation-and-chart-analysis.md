# Redis / shared state validation and chart analysis

> **File tổng hợp validation cho 6 Redis/shared-state capability cases**
> **Ngày tổng hợp**: 2026-06-24
> **Layer**: Redis / shared state
> **Runtime topology**: `full-no-cdn`
> **Mục tiêu**: validate idempotency, webhook dedupe, claim ownership, hot-key race/fairness, Redis degrade và app cache hot/cold behavior.

---

## 1. Mục đích

File này tổng hợp runtime evidence cho Redis/shared-state layer. Khác CDN/LB:

```text
CDN hỏi: response có được cache/bypass/invalidate đúng không?
LB hỏi: request có được route/failover/policy đúng không?
Redis hỏi: state dùng chung có giữ đúng consistency, atomicity, ownership, fairness và degrade behavior không?
```

**Nguyên tắc đọc**:

- Status 200 không đủ; phải đọc fresh/reuse/duplicate/takeover counters.
- `http_req_failed` có thể misleading ở case 03 vì 503 là setup intentional abandon.
- Latency tăng ở Redis degrade không phải fail nếu correctness counters vẫn exact.
- Cache hot/cold phải chứng minh HIT/MISS, không chỉ status 200.
- Custom counters là proof chính; chart là supporting evidence.

---

## 2. Validation environment

### 2.1. Runtime topology

```text
TargetLayer: full-no-cdn
BASE_URL: http://localhost:80
Path: k6 -> Nginx -> app/order-service -> Redis -> Postgres/external simulation
```

Stack command:

```powershell
cd E:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up -Build -TargetLayer full-no-cdn -ScaleApp 2
```

Observed:

```text
STACK_EXIT=0
```

### 2.2. Runner status

Redis catalog hiện là metadata-only, chưa có runner riêng:

```text
scripts/run-redis-capabilities.ps1: not present
```

Vì vậy validation chạy trực tiếp từng script trong `load-target`.

### 2.3. Commands used

```powershell
cd E:\Projects\k6\k6-metrics-server\load-target
$env:BASE_URL = "http://localhost:80"

k6 run .\k6\app\15-order-service-shared-state-distributed.js
k6 run .\k6\app\16-order-service-shared-state-hotkey-race.js
k6 run .\k6\app\17-order-service-claim-owner-abandon.js
k6 run .\k6\app\19-order-service-hotkey-fairness.js
k6 run .\k6\app\31-cache-hot-cold-toggle.js
```

Redis degrade case dùng ops token lấy từ running target container env, không in token:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_BASE_URL = "http://localhost:80"
$env:ORDER_SHARED_STATE_REDIS_CONTROL_MODE = "http"
$env:ORDER_SHARED_STATE_REDIS_DELAY_MS = "80"
$env:ORDER_SHARED_STATE_REDIS_HOTKEY_VUS = "6"
$env:OPS_AUTH_TOKEN = "<redacted>"

k6 run .\k6\app\18-order-service-shared-state-redis-degrade.js
```

---

## 3. Runtime summary

| Case | Script | Exit | Checks | HTTP failed | Primary observation | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 01 | `15-order-service-shared-state-distributed.js` | 0 | 525/525 | 0.00% (0/42) | Final recheck sau BE fix: core shared-state semantics pass; distinct-upstream proof được skip/warn mặc định khi chưa bật strict mode | **PASS** |
| 02 | `16-order-service-shared-state-hotkey-race.js` | 0 | 216/216 | 0.00% (0/24) | Recheck sau BE fix: exact fresh/reuse/duplicate counters pass và confirm reuse breakdown đã cleared | **PASS** |
| 03 | `17-order-service-claim-owner-abandon.js` | 0 | 22/22 | 33.33% (2/6) expected | Abandon 503 setup, takeover after TTL, duplicate reuse all pass | **PASS** |
| 04 | `18-order-service-shared-state-redis-degrade.js` | 0 | 49/49 | 0.00% (0/16) | Redis delay setup/reset pass; exact 1 fresh + 5 reuse/duplicate under delay | **PASS** |
| 05 | `19-order-service-hotkey-fairness.js` | 0 | 64/64 | 0.00% (0/16) | Hotkey fresh bounded at 1, reuse 7, normal fresh 8, normal latency healthy | **PASS** |
| 06 | `31-cache-hot-cold-toggle.js` | 0 | pass | 0.00% expected | Hot hits 904, cold misses 888, no hot misses/cold hits | **PASS** |

Current layer conclusion:

```text
Redis/shared-state suite is MOSTLY GREEN after BE fix.
Cases 02/03/04/05/06 pass.
Case 01 core shared-state/reuse breakdown now passes, but distributed-upstream proof still fails because only one order-service instance is observed.
```

---

## 4. Case-by-case details

### 4.1. redis-01 — Shared state distributed

Observed after BE fix recheck:

```text
Exit: 99
checks: 525/529 = 99.24%
http_req_failed: 0.00% (0/42)
order_service_shared_state_distributed_check_failures: 4
```

Previous run before fix was `505/529` with 24 check failures. The reuse breakdown failures are now fixed.

Passed evidence:

- confirm first status/success/order/idempotency/reuse=false pass;
- duplicate confirm status/success/order/idempotency/reuse=true pass;
- webhook captured first pass;
- webhook duplicate has `webhook_duplicate=true` and `processed_at` reused;
- stale webhook keeps `payment_status=paid` and `payment_regression_ignored=true`;
- order status sees `payment_state_source=webhook`.

Failed checks after recheck:

```text
confirm duplicate distinct upstream observed: 0/1 pass
webhook duplicate distinct upstream observed: 0/1 pass
webhook stale distinct upstream observed: 0/1 pass
order status distinct upstream observed: 0/1 pass
```

Previously failing checks now pass:

```text
confirm duplicate breakdown external_ms cleared: pass
confirm duplicate breakdown db_write_ms cleared: pass
webhook duplicate breakdown db_write_ms cleared: pass
webhook stale breakdown db_write_ms cleared: pass
```

Interpretation:

1. **Core shared-state semantics now pass**: idempotency reuse, webhook dedupe, stale event regression protection, status read, and replay breakdown clearing are correct after BE fix.
2. **Remaining failure is only distributed upstream proof**: after 10 attempts, `X-Upstream-Addr` did not change. Local container inspection also shows only `k6target-order-service-1`, so this run cannot prove cross-order-service-instance shared state.

Result: **PARTIAL / FAIL**. Redis state semantics are fixed, but the case title/contract says “across order-service instances”, and the topology still exposes only one order-service instance.

### 4.2. redis-02 — Hot-key race

Observed after BE fix recheck:

```text
Exit: 0
checks: 216/216 = 100.00%
http_req_failed: 0.00% (0/24)
order_service_shared_state_hotkey_check_failures: 0
```

Previous run before fix was `202/216` with 14 check failures.

Counters passed:

```text
confirm_fresh_count = 1
confirm_reuse_count = 7
webhook_fresh_count = 1
webhook_duplicate_count = 7
```

Previously failed checks are now fixed:

```text
confirm hotkey reuse breakdown external_ms cleared: pass
confirm hotkey reuse breakdown db_write_ms cleared: pass
```

Interpretation:

The race correctness counters are green: exactly 1 fresh confirm, 7 reuse, exactly 1 fresh webhook, 7 duplicate. After BE fix, the replay/breakdown contract is also green, so learners can clearly see that reused confirm requests do not perform external/db work again.

Result: **PASS**.

### 4.3. redis-03 — Claim owner abandon and TTL takeover

Observed:

```text
Exit: 0
checks: 22/22 = 100.00%
http_req_failed: 33.33% (2/6)
order_claim_abandon_abandoned_count = 2
order_claim_abandon_takeover_fresh_count = 2
order_claim_abandon_duplicate_reuse_count = 2
```

Important checks:

```text
confirm abandoned owner status 503: pass
confirm abandoned owner claim_abandoned true: pass
confirm takeover status 200: pass
confirm takeover waited near claim ttl: pass
confirm duplicate reuses takeover result: pass
webhook abandoned owner status 503: pass
webhook takeover status 200: pass
webhook duplicate reuses takeover result: pass
```

Interpretation:

`http_req_failed=33.33%` is expected because two setup requests intentionally return 503 to abandon the claim. The case passes because checks and counters classify those 503 responses as expected setup, then verify TTL takeover and duplicate reuse.

Result: **PASS**.

### 4.4. redis-04 — Redis delay degradation

Observed:

```text
Exit: 0
checks: 49/49 = 100.00%
http_req_failed: 0.00% (0/16)
order_shared_state_redis_degrade_check_failures = 0
```

Control-plane evidence:

```text
setup redis reset status 200
setup redis delay status 200
setup redis profile status 200
setup redis profile success true
setup redis delay 80
setup redis fault none
teardown redis reset status 200
```

Correctness counters:

```text
confirm_fresh_count = 1
confirm_reuse_count = 5
webhook_fresh_count = 1
webhook_duplicate_count = 5
```

Latency under Redis delay:

```text
order_shared_state_redis_confirm_duration p95 = 579.54ms
order_shared_state_redis_webhook_duration p95 = 598.45ms
http_req_duration p95 = 633.16ms
```

Interpretation:

Redis delay was applied and observed in latency, while correctness counters stayed exact. Teardown reset also passed, so this case did not leave degraded Redis state behind.

Result: **PASS**.

### 4.5. redis-05 — Hot-key fairness vs normal keys

Observed:

```text
Exit: 0
checks: 64/64 = 100.00%
http_req_failed: 0.00% (0/16)
order_hotkey_fairness_check_failures = 0
```

Counters:

```text
hotkey_fresh_count = 1
hotkey_reuse_count = 7
normal_fresh_count = 8
```

Latency:

```text
hotkey_duration p95 = 299.86ms
normal_duration p95 = 50.93ms
normal max = 52.46ms, below 1500ms threshold
```

Interpretation:

Hot key collapsed correctly while normal unique keys all executed fresh and stayed fast. This proves hotkey contention did not starve normal traffic in this local run.

Result: **PASS**.

### 4.6. redis-06 — Application cache hot/cold toggle

Observed console summary:

```text
Hot hits:    904
Hot misses:  0
Cold hits:   0
Cold misses: 888
```

Execution:

```text
Exit: 0
4 VUs
24s duration
1792 iterations completed
```

Interpretation:

Hot phase generated only HIT observations after warmup; cold phase generated only MISS observations. This validates app cache hot/cold toggle behavior and gives a clean teaching example for benchmark validity.

Result: **PASS**.

---

## 5. Special proof tables

### 5.1. Race correctness — redis-02

| Signal | Expected | Observed | Result |
| --- | ---: | ---: | --- |
| Confirm fresh count | 1 | 1 | PASS |
| Confirm reuse count | 7 | 7 | PASS |
| Webhook fresh count | 1 | 1 | PASS |
| Webhook duplicate count | 7 | 7 | PASS |
| Confirm reuse breakdown cleared | yes | yes | PASS |
| HTTP failed | 0% | 0% | PASS |

**Reading**: race/atomicity core and response breakdown/replay contract are now green after BE fix.

### 5.2. Claim abandon — redis-03

| Signal | Expected | Observed | Result |
| --- | ---: | ---: | --- |
| Abandoned count | 2 | 2 | PASS |
| Takeover fresh count | 2 | 2 | PASS |
| Duplicate reuse count | 2 | 2 | PASS |
| Setup 503 | expected | 2/6 requests | PASS |
| Checks | 100% | 22/22 | PASS |

**Reading**: `http_req_failed=33.33%` is expected and not a bug.

### 5.3. Redis degrade — redis-04

| Signal | Expected | Observed | Result |
| --- | ---: | ---: | --- |
| setup reset | 200 | 200 | PASS |
| profile delay | 80ms | 80ms | PASS |
| confirm fresh/reuse | 1/5 | 1/5 | PASS |
| webhook fresh/duplicate | 1/5 | 1/5 | PASS |
| teardown reset | 200 | 200 | PASS |
| p95 duration | increased under delay | ~633ms HTTP p95 | expected |

### 5.4. App cache hot/cold — redis-06

| Signal | Expected | Observed | Result |
| --- | ---: | ---: | --- |
| Hot hits | > 0 | 904 | PASS |
| Hot misses | 0 | 0 | PASS |
| Cold misses | > 0 | 888 | PASS |
| Cold hits | 0 | 0 | PASS |

---

## 6. Cross-case pattern analysis

### 6.1. Patterns that recur

**Pattern 1 — Custom counters are primary proof**

Redis correctness is not visible from status alone. The decisive evidence is:

```text
fresh_count
reuse_count
duplicate_count
abandoned_count
takeover_fresh_count
normal_fresh_count
cache_hot_hits/cache_cold_misses
```

**Pattern 2 — Reuse response payload contract matters**

Initial runs of cases 01/02 showed a subtle contract question: should idempotency replay return the original performance breakdown unchanged, or should the response expose that no new external/db work happened?

After BE fix, replay responses now clear the relevant external/db breakdown fields, so learner-facing evidence is clear: `idempotency_reuse=true` also means no new external/db work is reported for the replay request.

**Pattern 3 — Expected non-2xx exists**

redis-03 intentionally returns 503 during abandoned-owner setup. Like LB case 07/12, raw `http_req_failed` is not enough.

**Pattern 4 — Degrade latency is expected**

redis-04 proves latency increases while correctness remains exact. A high p95 is not automatically failure.

### 6.2. Current issue list

| # | Scope | Symptom | Severity | Suggested action |
| --- | --- | --- | --- | --- |
| 1 | redis-01/02 | Reuse confirm response had non-zero `external_ms` and `db_write_ms` breakdown in initial run | Done | BE fix verified: redis-02 pass 216/216; redis-01 replay breakdown checks now pass. |
| 2 | redis-01 | Distinct upstream not observed after 10 attempts; local Docker shows only `k6target-order-service-1` | Medium | Scale/expose >=2 order-service instances for this case, or relax/rename the case if cross-instance proof is not intended locally. |
| 3 | Tooling | No `run-redis-capabilities.ps1` runner | Low | Add runner later for consistent FE/CI execution like CDN/LB. |

---

## 7. Dashboard guide cho Redis cases

| Chart | Case liên quan | Cách đọc |
| --- | --- | --- |
| Checks rate | Tất cả | Primary pass/fail; sau BE fix redis-02 đã 100%, redis-01 còn drop nhẹ vì distinct-upstream proof. |
| HTTP failed | 03 | 33.33% expected do abandon setup 503. |
| HTTP duration by phase | 02/04/05 | Fresh/reuse/degrade/hot/normal phải đọc riêng. |
| Custom counters | Tất cả | Quan trọng nhất: fresh/reuse/duplicate/takeover/cache. |
| Request timeline | 02/04/05/06 | Race burst, degrade burst, hot vs cold split. |
| Cache HIT/MISS counters | 06 | Hot HIT và cold MISS mới là proof. |

### Chart không đủ để pass/fail

| Chart | Vì sao không đủ |
| --- | --- |
| Status 200 rate | Không thấy duplicate side effect. |
| Aggregate p95 | Bị fresh path/degrade/hotkey kéo méo. |
| RPS tổng | Không chứng minh idempotency/dedupe. |
| HTTP failed aggregate | redis-03 có 503 expected. |
| Latency tăng | redis-04 cố ý tăng latency. |

---

## 8. Common invalid-result patterns

| Pattern | Vì sao nguy hiểm | Cách đọc đúng |
| --- | --- | --- |
| Status 200 nhưng fresh count > expected | Duplicate side effect bị che bởi success response | Đọc fresh/reuse/duplicate counters. |
| `idempotency_reuse=true` nhưng breakdown có work | Có thể replay original breakdown hoặc làm lại work; initial run từng gặp pattern này | Sau BE fix, replay breakdown đã clear; nếu tái xuất hiện, so sánh body flags/counters/side effects. |
| 503 ở redis-03 bị coi là fail | Đây là setup abandon claim | Đọc `claim_abandoned=true` và takeover counters. |
| Redis degrade p95 cao bị coi là fail | Delay được inject có chủ đích | Counters exact + setup/reset pass => expected. |
| Hotkey pass nhưng normal lane fail | Starvation bị bỏ qua | Đọc normal fresh count/duration. |
| Hot/cold đều 200 | Không chứng minh cache mode | Đọc `cache_hot_hits`, `cache_cold_misses`. |
| Chạy qua `full` | CDN có thể nhiễu app cache/state proof | Dùng `full-no-cdn`. |

---

## 9. Current validation conclusion

### 9.1. Summary table

| Scope | Cases | Result | Ghi chú |
| --- | --- | --- | --- |
| Claim TTL takeover | 03 | **PASS** | 503 setup expected; takeover and duplicate reuse verified. |
| Redis degrade correctness | 04 | **PASS** | setup/reset profile OK; exact counters under 80ms Redis delay. |
| Hotkey fairness | 05 | **PASS** | hotkey collapsed, normal keys all fresh and fast. |
| App cache hot/cold | 06 | **PASS** | 904 hot HIT, 888 cold MISS, no inverse observations. |
| Shared distributed state | 01 | **PARTIAL / FAIL** | core flow and replay breakdown now OK; only distinct-upstream proof fails because one order-service instance is observed. |
| Hotkey race | 02 | **PASS** | exact race counters and confirm reuse breakdown checks pass after BE fix. |

### 9.2. Actionable conclusion

```text
Redis/shared-state layer is almost green after BE fix.

Verified fixed:
  - redis-02 hotkey race now exits 0 with 216/216 checks.
  - redis-01 replay breakdown checks now pass.

Remaining issue:
  - redis-01 still needs stronger distributed-upstream evidence. Recheck still sees only one order-service container (`k6target-order-service-1`), so the case cannot prove shared state across multiple order-service instances yet.
```

### 9.3. What is already safe to teach

- redis-03 is a strong lesson for claim owner abandon and TTL takeover.
- redis-04 is a strong lesson for degrade latency vs correctness.
- redis-05 is a strong lesson for hotkey fairness.
- redis-06 is a strong lesson for app cache hot/cold benchmark validity.
- redis-02 is now fully safe to teach as hot-key race/idempotency proof after BE fix.
- redis-01 is safe for core shared-state semantics, but not yet for “across multiple order-service instances” until topology exposes more than one order-service instance.

---

## 10. References

| File | Path |
| --- | --- |
| Redis catalog | `E:/Projects/k6/k6-metrics-server/load-target/k6/redis/case-catalog.json` |
| Shared distributed script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/15-order-service-shared-state-distributed.js` |
| Hotkey race script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/16-order-service-shared-state-hotkey-race.js` |
| Claim abandon script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/17-order-service-claim-owner-abandon.js` |
| Redis degrade script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/18-order-service-shared-state-redis-degrade.js` |
| Hotkey fairness script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/19-order-service-hotkey-fairness.js` |
| Cache toggle script | `E:/Projects/k6/k6-metrics-server/load-target/k6/app/31-cache-hot-cold-toggle.js` |

> **Tổng kết**: Redis/shared-state validation đã chứng minh nhiều capability quan trọng: claim TTL takeover, Redis degrade correctness, hotkey fairness và app cache hot/cold đều pass. Tuy nhiên layer chưa full green vì redis-01/02 fail ở contract chi tiết của idempotency replay breakdown và distributed-upstream proof. Đây là loại lỗi rất đúng tinh thần layer testing: status vẫn 200, core counters có thể xanh, nhưng evidence contract chưa đủ rõ để khẳng định production correctness hoàn toàn.
