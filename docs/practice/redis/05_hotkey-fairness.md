# redis-05 — Hot-key fairness vs normal keys

## 1. Business scenario

Một celebrity product/order hoặc payment incident tạo hot idempotency key: nhiều request cùng tranh một key. Cùng lúc đó, normal customers vẫn confirm các order riêng. Hệ thống đúng khi hot key bị collapse/dedupe nhưng normal keys không bị starvation.

```text
hotkey lane: nhiều VU dùng cùng orderId + Idempotency-Key
normal lane: nhiều VU dùng orderId/key riêng
```

## 2. Capability được test

Case này kiểm fairness giữa hot key và normal keys:

- hot key chỉ có số fresh bounded, còn lại reuse;
- normal unique keys đều fresh;
- normal lane latency dưới ngưỡng;
- hot key không chiếm toàn bộ worker/Redis path làm request bình thường chậm/fail.

## 3. Script và executor

```text
Script: ../app/19-order-service-hotkey-fairness.js
Executor: per-vu-iterations
Scenarios:
  hotkey_confirm: HOTKEY_VUS VUs, 1 iteration
  normal_confirm: NORMAL_VUS VUs, 1 iteration, startTime=100ms
Default HOTKEY_VUS: 8
Default NORMAL_VUS: 8
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Hai scenario chạy gần đồng thời để tạo cạnh tranh thật giữa hot lane và normal lane.

## 4. Env knobs

```powershell
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_VUS = "8"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_EXTERNAL_MS = "260"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_DB_WRITES = "5"
$env:ORDER_HOTKEY_FAIRNESS_CLAIM_TTL_MS = "3000"
$env:ORDER_HOTKEY_FAIRNESS_HOTKEY_MAX_FRESH = "2"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_EXTERNAL_MS = "20"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_DB_WRITES = "1"
$env:ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS = "1500"
```

## 5. Flow chính

```text
hotkey_confirm:
  POST /api/sim/orders/{sameHotkeyOrderId}/confirm
  Header: same Idempotency-Key
  Expected: fresh count bounded, reuse count high

normal_confirm:
  POST /api/sim/orders/{uniqueNormalOrderId}/confirm
  Header: unique Idempotency-Key per VU
  Expected: every normal request fresh and under max duration
```

## 6. Evidence phải đọc

| Evidence | Expected default |
| --- | ---: |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `order_hotkey_fairness_check_failures` | 0 |
| `order_hotkey_fairness_hotkey_fresh_count` | `>=1` and `<= HOTKEY_MAX_FRESH` |
| `order_hotkey_fairness_hotkey_reuse_count` | `>= HOTKEY_VUS - HOTKEY_MAX_FRESH` |
| `order_hotkey_fairness_normal_fresh_count` | `NORMAL_VUS` |
| normal request duration | `<= ORDER_HOTKEY_FAIRNESS_NORMAL_MAX_MS` |

## 7. Vì sao hotkey fresh count có thể cho phép <= 2?

Trong race thực tế, tùy timing/claim TTL, có thể có một lượng rất nhỏ fresh execution được chấp nhận theo contract script (`HOTKEY_MAX_FRESH`). Mục tiêu không phải luôn đúng 1 như redis-02, mà là bounded hotkey work và không starve normal keys.

So sánh:

```text
redis-02: exact atomic hotkey race -> fresh exactly 1
redis-05: fairness under mixed hot/normal lanes -> hot fresh bounded, normal all fresh
```

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| hotkey fresh count vượt max | Hot key không collapse đủ, có thể duplicate work. |
| hotkey reuse count thấp | Dedupe/reuse thiếu. |
| normal fresh count < NORMAL_VUS | Hotkey/starvation hoặc normal path fail. |
| normal duration > max | Hotkey làm normal users bị ảnh hưởng quá mức. |
| `http_req_failed > 0` | Không expected; cần debug app/Redis/LB. |
| Chỉ nhìn hotkey pass, bỏ normal lane | Sai mục tiêu case; fairness cần cả hai lane. |

## 9. Dashboard/chart reading

Chart nên đọc:

- duration split theo `stage=hotkey_confirm` và `stage=normal_confirm`;
- normal p95/max không vượt ngưỡng;
- custom counters hotkey fresh/reuse và normal fresh;
- request timeline cho thấy hai lane overlap.

Aggregate latency có thể bị hotkey external delay kéo lên. Cần filter theo stage.

## 10. Production lesson

Hotkey mitigation không được hy sinh normal traffic. Một Redis/idempotency design tốt collapse duplicate hotkey work nhưng vẫn cho unique customer operations đi qua. Đây là fairness/capacity correctness, không chỉ race correctness.