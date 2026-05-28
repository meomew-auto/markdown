# Case 07: Predictable batch validation cho CI

## Tình huống thực tế

Pre-merge gate trong CI/CD pipeline. Cần test:

```text
- Chạy CHÍNH XÁC 1000 iter
- 2000 http request total
- p95 latency thay đổi < 10% so với baseline
- Fail PR nếu vượt threshold
```

CI cần con số ổn định để compare baseline qua các lần PR.

## Why per-vu-iterations?

```text
CI cần DETERMINISTIC count, không phải duration-based:
  - per-vu: total = vus × iters = 1000 (chính xác)
  - constant-vus 5m duration: không biết bao nhiêu request
  - constant-arrival-rate có thể drop -> count thiếu
  - shared-iterations: count chính xác nhưng không control per-VU
```

## Config

```js
const VUS = 50;
const ITERS_PER_VU = 20;
// Total = 50 × 20 = 1000 (chính xác)

export const options = {
  scenarios: {
    ci_batch: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERS_PER_VU,
      maxDuration: "10m",
    },
  },
  thresholds: {
    iterations: ["count==1000"],
    http_reqs: ["count==2000"],
    "http_req_duration{tag:critical}": ["p(95)<550"],  // baseline 500 + 10%
    http_req_failed: ["rate<0.01"],
  },
};
```

## Endpoint flow

```text
Mỗi iter:
  GET /
  GET /api/quotes
  sleep(0.1)

Total: 2 req × 1000 iter = 2000 req
```

## Pass criteria (CI gate)

```text
1. iterations == 1000 (chính xác)
2. http_reqs == 2000 (chính xác)
3. p95 < baseline × 1.10
4. http_req_failed < 1%
```

## CI integration

```powershell
# Set baseline từ lần chạy ổn định trước (commit vào repo CI config)
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
$env:BASELINE_P95_MS = "500"

cd "E:\Khoa hoc\k6"
k6 run -o cloud .\examples\per-vu-iterations\pvi-07-ci-batch.js

# Local run không cần cloud upload
k6 run --quiet .\examples\per-vu-iterations\pvi-07-ci-batch.js

if ($LASTEXITCODE -ne 0) {
  Write-Host "CI gate FAILED: regression detected"
  exit 1
}
```

> Stack setup chung: xem [RUN_GUIDE.md](RUN_GUIDE.md).

**Verify trên UI** (dùng cloud output):

```text
1. Paste token, click run mới nhất
2. Tile "iterations": 1000 ✓ (chính xác)
3. Tile "http_reqs": 2000 ✓ (chính xác)
4. http_req_duration{name=homepage} p95 < 550ms (baseline 500 + 10%)
5. http_req_duration{name=api_quotes} p95 < 550ms
```

## Update baseline khi cần

```bash
# Sau khi optimize, p95 giảm xuống 400ms
# Update baseline:
echo "BASELINE_P95_MS=400" > ci-baseline.env
```

## Anti-pattern

```text
❌ constant-vus với duration:
   Số iter biến thiên theo network -> CI flakey

❌ constant-arrival-rate:
   Có thể drop -> count thiếu
   p95 latency biến thiên cao do queueing

❌ Bỏ tag critical:
   Threshold tính cả /api/static (CSS, JS)
   -> p95 không phản ánh API performance
```

## Mở rộng

### A: Multi-environment baseline

```js
const env = __ENV.K6_ENV || "staging";
const baselines = {
  staging: 500,
  production: 300,
  local: 100,
};
const BASELINE = baselines[env];
```

### B: Per-endpoint threshold

```js
thresholds: {
  "http_req_duration{name:homepage}": ["p(95)<200"],
  "http_req_duration{name:api_quotes}": ["p(95)<800"],
}
```

### C: Output JSON cho CI parser

```bash
k6 run --out json=ci-result.json pvi-07-ci-batch.js
# Parse ci-result.json để post comment lên PR
```

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- k6 thresholds: https://k6.io/docs/using-k6/thresholds/
