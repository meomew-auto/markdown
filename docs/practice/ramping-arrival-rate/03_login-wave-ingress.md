# Case 03: Payment Webhook Wave

> **Script:** `rar-03-payment-webhook-wave.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 20 arrivals/s
> **Focus:** payment-provider webhook wave vào order service.

## 1. Tình huống thực tế

Payment provider gửi webhook theo wave riêng của nó. Đây là external producer: hệ thống nhận phải hấp thụ wave, không thể nói “backend chậm nên provider gửi chậm lại”.

```text
startRate = 2/s
15s -> 8/s   normal intake
20s -> 20/s  webhook wave peak
15s -> 4/s   drain/recovery
5s  -> 0/s   drain
```

Business question:

```text
Order service có nhận payment webhook wave 2 -> 8 -> 20 -> 4/s mà không mất event không?
```

## 2. Vì sao dùng `ramping-arrival-rate`?

Webhook arrival là open-model ingress. Nếu dùng closed model, throughput sẽ phụ thuộc loop duration của VU và không mô phỏng được provider push events theo rate curve.

## 3. Config mapping

| Tham số | Default | Ý nghĩa |
| --- | ---: | --- |
| `RAR_03_START_RATE` | 2 | rate đầu run |
| `RAR_03_NORMAL_RATE` | 8 | normal intake |
| `RAR_03_WAVE_RATE` | 20 | provider wave peak |
| `RAR_03_DRAIN_RATE` | 4 | drain/recovery |
| `RAR_03_DURATION_SCALE` | 1 | scale stage duration |
| `RAR_03_PREALLOCATED_VUS` | 16 | worker warm sẵn |
| `RAR_03_MAX_VUS` | 50 | worker ceiling |
| `RAR_03_MAX_DROPPED` | 3 | drop budget |
| `RAR_03_USER_POOL` | 500 | user/order identity pool |

Scheduled slots mặc định:

```text
15×(2+8)/2  = 75
20×(8+20)/2 = 280
15×(20+4)/2 = 180
5×(4+0)/2   = 10
total        = 545 arrivals
```

## 4. Service/API flow

Mỗi event là một webhook POST:

| Operation | Method | Endpoint | Expected |
| --- | --- | --- | ---: |
| `payment_webhook_wave_receive` | POST | `/api/sim/orders/webhooks/payment` | 200 |

Request body có `provider_event_id`, `order_id`, `status`, `amount`; header có `Idempotency-Key: payment-webhook-<requestKey>`.

## 5. Metrics cần đọc

```text
ramping_arrival_events_total       ~= iterations
ramping_arrival_api_calls_total    ~= http_reqs ~= iterations
ramping_arrival_events_failed      = webhook receive failures
dropped_iterations                 = provider events k6 không start kịp
ramping_arrival_event_duration_ms  = webhook handling duration
```

## 6. Pass criteria

```text
checks > 0.99
http_req_failed < 0.01
dropped_iterations <= RAR_03_MAX_DROPPED
ramping_arrival_events_failed < 10
```

Default local validation:

```text
iterations=545
http_reqs=545
checks=100%
http failed=0%
dropped_iterations=0
p95≈6.94ms
```

## 7. Cách chạy

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

## 8. Dashboard reading

**Response time.** Filter `payment_webhook_wave_receive`; nếu p99/max cao nhưng dropped=0, intake vẫn giữ được wave nhưng order webhook handler có tail cần theo dõi.

**Execution timeline.** Iterations/http_reqs nên theo 2 -> 8 -> 20 -> 4/s; `http_reqs == iterations` vì 1 call/event.

**VUs vs iter/s.** VU pressure thấp nếu webhook handler nhanh; dropped ở peak nghĩa là handler hoặc VU pool không đủ cho provider wave.

**Executor tab.** Check `case_id=rar-03-payment-webhook-wave` và stage curve đúng.

## 9. Output -> decision

| Output | Kết luận |
| --- | --- |
| dropped=0, checks 100% | Webhook wave pass |
| unexpected status/5xx | Báo order-service webhook path |
| duplicate/idempotency issue | Kiểm idempotency/claim TTL behavior |
| dropped ở wave peak | Tăng capacity hoặc giảm provider peak |

## 10. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js`
