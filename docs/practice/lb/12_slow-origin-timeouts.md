# Case 12: Slow origin timeout policy

> **Case ID:** `lb-12-slow-origin-timeouts`  
> **Script:** `12-slow-origin-timeouts.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** Nginx cắt slow origin bằng timeout policy và trả expected 504

## 1. Tình huống thực tế

Một origin chậm quá lâu phải bị Gateway cắt để bảo vệ tài nguyên. Trong case này, `504` không phải bug; nó là policy mong muốn.

## 2. Capability được chứng minh

Nginx config cho `/api/lb/timeout-demo`:

```text
proxy_read_timeout 150ms
X-LB-Timeout-Policy: read_timeout=150ms
```

Case tạo traffic tới slow origin và phân loại:

- expected `504`;
- unexpected status = 0;
- duration gần timeout policy.

## 3. Key signals

| Signal | Expected |
| --- | --- |
| status | 504 |
| `X-LB-Timeout-Policy` | `read_timeout=150ms` |
| `lb_timeout_504` | bằng số request |
| `lb_timeout_unexpected` | 0 |
| p95 duration | gần 150ms |
| `http_req_failed` | 100% expected |

## 4. Pass/fail criteria

PASS khi tất cả request được cắt đúng timeout và không có unexpected status.

FAIL khi:

- request treo quá lâu;
- status không phải 504;
- thiếu timeout policy header;
- người đọc fail case chỉ vì `http_req_failed=100%` mà không đọc checks.

## 5. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 12-slow-origin-timeouts
```

## 6. Chart reading

Chart đúng cần thấy:

- `http_req_failed=100%` nhưng checks 100%;
- `lb_timeout_504` tăng đều;
- `lb_timeout_unexpected=0`;
- p95 duration quanh 150ms.

## 7. Real validation data

```text
Exit: 0
Checks: 260/260
HTTP failed: 100.00% (65/65) expected
lb_timeout_504: 65
lb_timeout_unexpected: 0
p95 duration: ~153ms
Result: PASS
```

## 8. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/12-slow-origin-timeouts.js`
