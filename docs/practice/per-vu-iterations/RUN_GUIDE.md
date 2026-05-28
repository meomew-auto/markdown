# Run Guide — Stack setup + chạy test

> File này dùng chung cho tất cả case trong series. Mỗi case có thêm
> hướng dẫn riêng (token, env vars phù hợp) trong doc của case.

## 3 stack cần start

| Service | URL | Mục đích |
| --- | --- | --- |
| UI Dashboard | http://localhost:13001 | Mở browser, paste token để xem result |
| Metrics API | http://localhost:18080 | k6 cloud endpoint (output `-o cloud`) |
| Load-target | http://localhost:80 | Endpoints `/api/sim/*` cho k6 test |
| Grafana (optional) | http://localhost:13002 | Dashboard ingest health |
| InfluxDB (internal) | localhost:18181 | Storage |

## Start stack

```powershell
# 1. Metrics + UI
cd e:\Projects\k6\k6-metrics-server\deploy\private-metrics
docker compose --env-file .env `
  -f compose.private-metrics.yml `
  -f compose.tier1-small.yml `
  up -d

# 2. Load-target
cd e:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action up
```

## Token có sẵn trong `.env`

| Token | Class | Identity | Role |
| --- | --- | --- | --- |
| `student-token-1234567890` | class-a | student-a | student |
| `teacher-token-1234567890` | class-a | teacher-a | teacher |
| `admin-token-1234567890` | ops | admin | admin |

→ Dùng `student-token-...` cho hầu hết case (load test thường).
→ Dùng `teacher-token-...` cho case cần permission cao (admin endpoint).
→ Dùng `admin-token-...` cho ops/maintenance test.

## Env vars cho mọi run

```powershell
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
```

Hoặc Linux/Bash:

```bash
export BASE_URL=http://localhost:80
export K6_CLOUD_HOST=http://localhost:18080
export K6_CLOUD_TOKEN=student-token-1234567890
```

## Run pattern chung

```powershell
cd "E:\Khoa hoc\k6"

# Run với cloud output (lên UI)
k6 run -o cloud .\examples\per-vu-iterations\pvi-NN-<case>.js

# Hoặc run local (chỉ summary)
k6 run .\examples\per-vu-iterations\pvi-NN-<case>.js
```

## Verify trên UI

```text
1. Mở http://localhost:13001
2. Paste token vào ô Token (top right)
3. Run catalog hiện run mới nhất
4. Click vào run → tile "Trend percentile":
   - "Computed from raw samples on disk — 1:1 with k6 CLI summary"
     → đúng path raw_exact (chính xác)
   - "Reconstructed from HDR buckets"
     → fallback HDR (xấp xỉ)
```

## Sanity check connectivity

```bash
# Capabilities
curl http://localhost:18080/v1/capabilities
# Expect: {"auth_required":true,"production_mode":true,...}

# Auth verify
curl -H "Authorization: Bearer student-token-1234567890" \
  http://localhost:18080/v1/me
# Expect: {"auth_enabled":true,"class_id":"class-a","student_id":"student-a",...}

# Load-target health
curl http://localhost:80/health
# Expect: {"status":"ok","service":"load-target",...}
```

## Stop stack

```powershell
# Metrics + UI
cd e:\Projects\k6\k6-metrics-server\deploy\private-metrics
docker compose --env-file .env `
  -f compose.private-metrics.yml `
  -f compose.tier1-small.yml `
  down

# Load-target
cd e:\Projects\k6\k6-metrics-server
.\scripts\stack.ps1 -Stack target -Action down
```

## Troubleshooting

### Stack không start được

```powershell
# Image cũ -> rebuild
cd e:\Projects\k6\k6-metrics-server
docker build -t k6-metrics-server:localprod .
```

### `.env` thiếu var

Cần có:

```text
ALLOWED_ORIGINS=http://localhost:13001,http://localhost:3001
RAW_SAMPLES_ENABLED=true
OPS_AUTH_TOKEN=<some-secret>
```

### k6 cloud upload fail

```text
Check K6_CLOUD_HOST đúng (http://localhost:18080)
Check token còn valid (curl /v1/me)
Check ALLOWED_ORIGINS chứa origin của UI (13001)
```
