# Case 07: Rate limit and connection pressure

> **Case ID:** `lb-07-rate-limit-and-connection-pressure`  
> **Script:** `07-rate-limit-and-connection-pressure.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** Nginx shed load bằng `429` đúng contract, không phát sinh status bất ngờ

## 1. Tình huống thực tế

Khi request rate hoặc số connection vượt ngưỡng, Gateway cần bảo vệ origin bằng rate limit / connection limit. Trong case này, một phần request bị từ chối bằng `429` là hành vi đúng, không phải lỗi.

## 2. Capability được chứng minh

Case này chứng minh pressure policy của Nginx:

```text
traffic rate cao -> một phần request 200 -> một phần request 429 -> không có status ngoài contract
```

Metrics chính:

- `lb_pressure_200`
- `lb_pressure_429`
- `lb_pressure_unexpected`

## 3. Nginx policy liên quan

Trong `nginx.conf`:

```text
limit_req_zone ... rate=10r/s
limit_req ... burst=5 nodelay
limit_conn ... 4
limit_req_status 429
limit_conn_status 429
```

## 4. Key signals

| Signal | Expected |
| --- | --- |
| status | chỉ `200` hoặc `429` |
| `lb_pressure_200` | > 0 |
| `lb_pressure_429` | > 0 under pressure |
| `lb_pressure_unexpected` | 0 |
| `http_req_failed` | cao là expected vì 429 |

## 5. Pass/fail criteria

PASS khi có cả accepted traffic và shed traffic, nhưng unexpected status = 0.

FAIL khi:

- xuất hiện 5xx hoặc status ngoài 200/429;
- tất cả request đều 429 ở mức traffic không hợp lý;
- không có pressure signal dù rate vượt ngưỡng;
- `lb_pressure_unexpected > 0`.

## 6. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 07-rate-limit-and-connection-pressure
```

Env knobs:

```powershell
$env:LB_PRESSURE_RATE = "30"
$env:LB_PRESSURE_DURATION_SECONDS = "10"
```

## 7. Chart reading

- Status chart phải có 200 + 429.
- `http_req_failed` cao không phải fail nếu chỉ đến từ 429.
- Chart quan trọng nhất là `lb_pressure_unexpected`: phải bằng 0.

## 8. Real validation data

```text
Exit: 0
Checks: 600/600 individual run; 602/602 tuned full profile
HTTP failed: ~65% expected 429s
lb_pressure_200: ~105
lb_pressure_429: ~195
lb_pressure_unexpected: 0
Result: PASS
```

## 9. Reference

- Overview: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/07-rate-limit-and-connection-pressure.js`
