# redis-03 — Claim owner abandon and TTL takeover

## 1. Business scenario

Một worker/request claim quyền xử lý idempotency key hoặc webhook event rồi chết giữa chừng: process crash, timeout, deploy restart, hoặc upstream disconnect. Nếu claim không có TTL/takeover, checkout/payment flow có thể bị kẹt vĩnh viễn.

```text
owner A claim -> owner A abandon -> TTL expires -> owner B takeover -> duplicate reuses owner B result
```

## 2. Capability được test

Case này chứng minh Redis claim ownership có TTL và takeover an toàn:

- initial abandoned owner trả 503 có chủ đích;
- response báo `claim_abandoned=true`;
- request kế tiếp chờ gần claim TTL rồi fresh execution;
- duplicate sau takeover reuse kết quả mới;
- cả confirm flow và webhook flow đều recover.

## 3. Script và executor

```text
Script: ../app/17-order-service-claim-owner-abandon.js
Executor: options vus=1, iterations=1
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Một VU là đúng vì case cần deterministic sequence. Chạy song song sẽ làm nhiễu claim state.

## 4. Env knobs

```powershell
$env:ORDER_CLAIM_ABANDON_TTL_MS = "900"
$env:ORDER_CLAIM_ABANDON_AFTER_MS = "80"
$env:ORDER_CLAIM_ABANDON_CONFIRM_DB_WRITES = "2"
$env:ORDER_CLAIM_ABANDON_CONFIRM_EXTERNAL_MS = "90"
$env:ORDER_CLAIM_ABANDON_WEBHOOK_DB_WRITES = "2"
```

## 5. Flow chính

```text
1. confirm_abandoned_owner
   POST /api/sim/orders/{orderId}/confirm?abandon_claim=true
   Expected: 503, success=false, claim_abandoned=true

2. confirm_takeover_after_ttl
   POST cùng order/key
   Expected: 200, fresh execution, waited near TTL

3. confirm_duplicate_after_takeover
   POST cùng order/key
   Expected: 200, idempotency_reuse=true

4. webhook_abandoned_owner
   POST /api/sim/orders/webhooks/payment?abandon_claim=true
   Expected: 503, claim_abandoned=true

5. webhook_takeover_after_ttl
   POST cùng event id
   Expected: 200, webhook_duplicate=false

6. webhook_duplicate_after_takeover
   POST cùng event id
   Expected: 200, webhook_duplicate=true
```

## 6. Evidence phải đọc

| Evidence | Expected default |
| --- | ---: |
| `checks` | 100% |
| `order_claim_abandon_check_failures` | 0 |
| `order_claim_abandon_abandoned_count` | 2 |
| `order_claim_abandon_takeover_fresh_count` | 2 |
| `order_claim_abandon_duplicate_reuse_count` | 2 |
| Initial abandoned status | 503 expected |
| Takeover status | 200 |
| Duplicate after takeover | reuse/duplicate true |

## 7. Cách đọc `http_req_failed`

Case này có initial 503 intentional. Vì vậy raw `http_req_failed` có thể không phải pass/fail signal chính nếu k6 đánh 503 là failed HTTP.

Cách đọc đúng:

```text
checks rate == 100%
claim_abandoned=true cho 503 setup
takeover counters đúng
duplicate reuse counters đúng
```

Nếu 503 xuất hiện ở takeover/duplicate phase thì mới là bug.

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Abandon request không 503 | Setup không tạo được abandoned claim; case không chứng minh takeover. |
| Abandon response không `claim_abandoned=true` | Không chắc claim thật sự bị abandon. |
| Takeover không chờ gần TTL | Claim TTL/takeover semantics sai hoặc takeover quá sớm. |
| Takeover không fresh | Owner mới không thực thi đúng sau TTL. |
| Duplicate sau takeover không reuse | Idempotency result sau takeover không được lưu. |
| Lock kẹt làm request sau fail/timeout | Stuck lock bug nghiêm trọng. |

## 9. Dashboard/chart reading

Chart nên đọc:

- duration của takeover gần `ORDER_CLAIM_ABANDON_TTL_MS`;
- status code có 503 ở setup phase, 200 ở takeover/duplicate phase;
- counters abandon/takeover/duplicate đúng số lượng;
- checks rate 100%.

Không đọc “có 503 => fail” một cách máy móc.

## 10. Production lesson

Claim owner abandon là lỗi production rất thật: worker chết trong critical section. Redis lock không có TTL sẽ tạo stuck checkout/payment. TTL takeover không đúng sẽ tạo duplicate active owner. Case này kiểm cả hai rủi ro đó.