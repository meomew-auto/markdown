# redis-06 — Application cache hot/cold toggle

## 1. Business scenario

Một endpoint cache trong app phục vụ cùng một key lặp lại (hot key), sau đó chuyển sang nhiều key unique (cold keys). Đây là cách chứng minh app cache tạo khác biệt HIT/MISS thật để những benchmark sau không bị đọc nhầm.

```text
hot phase: repeated same key -> expected HIT
cold phase: unique keys -> expected MISS
```

Case này không test CDN/Varnish. Nó test app/Redis-style cache phía origin.

## 2. Capability được test

Case này chứng minh:

- hot repeated key được warm và trả HIT trong phase hot;
- cold unique keys trả MISS trong phase cold;
- header/cache signal khớp phase;
- latency hot/cold có thể khác nhau theo cache mode;
- benchmark có thể tách hot cache traffic khỏi cold/no-cache traffic.

## 3. Script và executor

```text
Script: ../app/31-cache-hot-cold-toggle.js
Executor: constant-vus
Scenario: toggle
Default VUs: 4
Default duration: HOT_DURATION_SECONDS + COLD_DURATION_SECONDS = 24s
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Khác các case Redis order-service, case này chạy sustained traffic để quan sát hot phase và cold phase theo thời gian.

## 4. Env knobs

```powershell
$env:CACHE_TOGGLE_VUS = "4"
$env:CACHE_TOGGLE_HOT_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_COLD_DURATION_SECONDS = "12"
$env:CACHE_TOGGLE_TTL_SECONDS = "120"
$env:CACHE_TOGGLE_SLEEP_SECONDS = "0.05"
$env:CACHE_TOGGLE_RUN_ID = "<optional-run-id>"
$env:CACHE_TOGGLE_HOT_KEY = "<optional-hot-key>"
$env:CACHE_TOGGLE_COLD_PREFIX = "<optional-cold-prefix>"
```

## 5. Flow chính

Setup warmup:

```text
GET /api/cached?key={hotKey}&ttl_seconds={ttl}
GET /api/cached?key={hotKey}&ttl_seconds={ttl}
```

Runtime:

```text
Hot phase:
  GET /api/cached?key={sameHotKey}&ttl_seconds={ttl}
  Expected cache status includes HIT

Cold phase:
  GET /api/cached?key={coldPrefix}-{VU}-{ITER}&ttl_seconds={ttl}
  Expected cache status includes MISS
```

Headers gửi:

```text
X-Test-Run-ID: <run id>
X-Test-Scenario: cache_hot_cold_toggle
Cache-Control: max-age=0 cho hot, no-cache cho cold
```

## 6. Evidence phải đọc

| Evidence | Expected |
| --- | --- |
| `checks` | 100% |
| `http_req_failed` | 0.00% |
| `cache_toggle_failures` | 0 |
| `cache_hot_hits` | > 0 |
| `cache_hot_misses` | 0 hoặc không đáng kể sau warmup; script check yêu cầu từng hot request HIT |
| `cache_cold_misses` | > 0 |
| `cache_cold_hits` | 0; script check yêu cầu cold request MISS |
| `X-Cache-Status` hoặc `X-Cache` | contains `HIT` trong hot, `MISS` trong cold |
| `X-Test-Scenario` | `cache_hot_cold_toggle` |

## 7. Hot/cold không phải CDN

Dễ nhầm case này với CDN case 01. Điểm khác:

| CDN HIT smoke | Redis/app cache hot/cold |
| --- | --- |
| Varnish edge cache trước Nginx | App cache sau Nginx/origin path |
| Signal chính `X-Cache` của CDN | `X-Cache-Status`/app cache signal |
| Chứng minh edge offload | Chứng minh app cache mode và benchmark validity |
| Runtime `full` | Runtime `full-no-cdn` |

## 8. Invalid-result patterns

| Pattern | Ý nghĩa |
| --- | --- |
| Hot phase có MISS | Warmup/cache key/TTL/header sai; hot benchmark không thật sự hot. |
| Cold phase có HIT | Cold keys không unique hoặc no-cache semantics sai. |
| Tất cả status 200 nhưng cache counters sai | Case fail; status không chứng minh cache mode. |
| Chạy qua `TargetLayer=full` | Có thể bị CDN cache nhiễu, không còn app cache proof. |
| TTL quá ngắn | Hot key có thể expire giữa phase, tạo MISS ngoài ý muốn. |
| Cold prefix reused giữa runs | Có thể xuất hiện HIT do state cũ. |

## 9. Dashboard/chart reading

Chart nên đọc:

- request timeline chia rõ hot 12s đầu và cold 12s sau;
- `cache_hot_latency_ms` vs `cache_cold_latency_ms`;
- counters `cache_hot_hits`, `cache_cold_misses`;
- checks rate 100%;
- status 200 toàn bộ chỉ là điều kiện phụ.

Nếu hot latency thấp hơn cold, đó là supporting evidence. Pass/fail vẫn dựa vào HIT/MISS checks.

## 10. Production lesson

Nhiều benchmark bị sai vì không biết traffic đang hot cache hay cold cache. Case này dạy cách chủ động tạo và chứng minh hai mode. Nếu toggle sai, mọi kết luận latency/RPS về app cache đều không đáng tin.