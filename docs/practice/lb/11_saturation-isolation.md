# Case 11: Saturation isolation

> **Case ID:** `lb-11-saturation-isolation`  
> **Script:** `11-saturation-isolation.js`  
> **Profile:** `full-no-cdn`  
> **Proof:** slow lane không kéo sập fast lane

## 1. Tình huống thực tế

Một upstream chậm không nên làm toàn bộ Gateway bị chậm. Nếu slow route và fast route dùng upstream/pool isolation đúng, fast lane vẫn có latency thấp dù slow lane có request dài.

## 2. Capability được chứng minh

Case này chạy song song hai lane:

- `lb_isolation_fast_demo` -> stable origin nhanh;
- `lb_isolation_slow_demo` -> slow origin có latency cao có chủ đích.

Pass/fail phải đọc theo endpoint tag, không đọc aggregate latency.

## 3. Key signals

| Signal | Expected |
| --- | --- |
| fast endpoint upstream | `lb-stable-origin` |
| slow endpoint upstream | `lb-slow-origin` |
| fast p95 | thấp |
| slow p95 | cao có chủ đích |
| failed rate fast/slow | 0% |
| checks | 100% |

## 4. Pass/fail criteria

PASS khi fast lane vẫn nhanh và không fail trong lúc slow lane chậm.

FAIL khi:

- fast lane p95 bị kéo lên theo slow lane;
- fast lane có failed request;
- route isolation header sai;
- aggregate p95 bị dùng làm kết luận duy nhất.

## 5. Cách chạy

```powershell
./scripts/run-lb-capabilities.ps1 -Profile full-no-cdn -Scenarios 11-saturation-isolation
```

## 6. Chart reading

Chart quan trọng nhất:

```text
http_req_duration{endpoint:lb_isolation_fast_demo}
http_req_duration{endpoint:lb_isolation_slow_demo}
```

Không dùng aggregate p95 vì nó trộn fast và slow lane.

## 7. Real validation data

Individual run:

```text
Exit: 0
Checks: 1872/1872
HTTP failed: 0.00% (0/312)
fast p95: ~4.29ms
slow p95: ~616.27ms
Result: PASS
```

Tuned full profile:

```text
Checks: 1866/1866
HTTP failed: 0.00% (0/311)
Result: PASS
```

## 8. Reference

- Overview: `./00_overview.md`
- Validation: `./13_validation-and-chart-analysis.md`
- Script: `E:/Projects/k6/k6-metrics-server/load-target/k6/lb/11-saturation-isolation.js`
