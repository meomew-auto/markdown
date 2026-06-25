# soak-01 -- Short green-path endurance

> **Case ID:** `soak-01-green-business-flow`
> **Script:** `../app/30-capacity-sizing-sweep.js`
> **Profile:** `full-no-cdn`, constant-arrival-rate, rate=3
> **Proof:** Mixed API flow on dinh trong >5 phut -- memory flat, latency stable, 0 backpressure.

---

## 1. Tinh huong thuc te

```text
Ban vua chay smoke test 30 giay:
  100 requests, 100% success, p95=12ms, memory=45MB
  -> "System OK, ready to deploy!"

Nhung cau hoi that su la:
  - Sau 5 phut, memory con 45MB khong?
  - Sau 5 phut, p95 con 12ms khong?
  - Sau 5 phut, co 429 nao xuat hien khong?
  - GC cycle co gay latency spike sau vai tram request khong?

Short test chi la snapshot.
Soak test la movie -- no cho thay system behavior over time.
```

He thong chay on sau 30s test, nhung sau 5 phut thi sao? Day la cau hoi soak-01 tra loi.

## 2. Capability

- Observe **memory slope** cua tung service theo thoi gian (tu `/v1/tests/:id/resources`)
- Observe **latency drift**: p95/p99 co tang dan trong khi rate giu nguyen 3 req/s?
- Observe **backpressure stability**: 429 ratio co = 0% trong suot 5 phut?
- Observe **scheduler health**: dropped_iterations = 0?
- Phan biet **warmup phase** (0-60s) vs **steady state** (60-300s)

## 3. Realistic mix -- tai sao quan trong

`realistic_mix` profile mo phong traffic that cua mot e-commerce site:

| Endpoint | Weight | Loai |
| --- | ---: | --- |
| Products list | 28% | DB read (nang) |
| Checkout | 15% | DB write + external call |
| Products detail | 12% | DB read (vua) |
| Products search | 12% | DB read + CPU |
| Cart add | 10% | DB write |
| Cart summary | 10% | DB read (nhe) |
| Auth me | 8% | CPU + memory |
| Report | 5% | CPU + GZIP |

Day khong phai la 1 endpoint duy nhat -- la toan bo business flow.
Neu bat ky endpoint nao gay memory leak hoac latency drift, soak se tim ra.

## 4. Pass/fail

```text
PASS:
  - Memory flat sau warmup (slope < 0.5MB/min)
  - p95 stable trong steady state (khong tang qua 5ms so voi warmup)
  - p99 khong co spike bat thuong
  - dropped_iterations = 0
  - http_req_failed = 0 (expected_status = 200)
  - 429 ratio = 0%

FAIL signals (bat ky signal nao):
  - Memory tang > 2MB/min va khong cham lai -> LEAK
  - p95 tang > 5ms/phut trong steady state -> DRIFT
  - 429 xuat hien va tang dan -> BACKPRESSURE
  - dropped_iterations > 0 -> SCHEDULER OVERLOAD
```

## 5. Cach chay

### Short profile (5m -- an toan cho classroom)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:CAPACITY_RUN_ID = "soak-green-short"
$env:CAPACITY_PROFILE = "realistic_mix"
$env:CAPACITY_RATE = "3"
$env:CAPACITY_DURATION_SECONDS = "300"
$env:CAPACITY_PRE_ALLOCATED_VUS = "12"
$env:CAPACITY_MAX_VUS = "30"

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

Thoi gian chay: **5 phut**. So request du kien: 3 req/s * 300s = **~900 requests**.

### Medium profile (15m -- dev verification)

```powershell
$env:CAPACITY_DURATION_SECONDS = "900"
$env:CAPACITY_RUN_ID = "soak-green-medium"
# Cac env khac giu nguyen nhu short profile

k6 run -o cloud E:/Projects/k6/k6-metrics-server/load-target/k6/app/30-capacity-sizing-sweep.js
```

> **CANH BAO MEDIUM:** 15 phut chay lien tuc. Dam bao stack duoc lap rieng,
> khong co ai khac dang test tren cung stack.

## 6. What to watch (theo thoi gian)

### Minute 0-1: Warmup phase

```text
- Memory: Co the tang nhe (allocation ban dau, cache fill)
- Latency: Co the cao hon steady state (JIT, cold caches)
- CPU: Co the spike luc dau
-> Day la binh thuong. Dung lo neu memory tang trong 60s dau.
```

### Minute 2-5: Steady state

```text
- Memory: PHAI flat. Neu van tang -> leak hoac cache growth khong gioi han
- Latency: PHAI stable. p95 khong duoc tang qua 5ms so voi minute 1
- Backpressure: PHAI = 0. 429 ratio = 0%
- CPU: PHAI on dinh, khong co upward trend
-> Day la phase quan trong nhat. Moi drift o day la signal can dieu tra.
```

### Cach doc dashboard

```text
Memory slope panel:
  products-service:  flat o 46MB  --------  Khoe
  auth-service:      flat o 22MB  --------  Khoe
  cart-service:      flat o 18MB  --------  Khoe

Latency trend panel:
  p95:  12ms (m1) -> 13ms (m2) -> 12ms (m3) -> 13ms (m4) -> 13ms (m5)  Khoe
  p99:  25ms (m1) -> 28ms (m2) -> 26ms (m3) -> 27ms (m4) -> 26ms (m5)  Khoe

Backpressure panel:
  200: 100% |||||||||||||||||||||||||||||||||||||||||||  Khoe
  429:   0% |                                           Khoe
```

## 7. Real validation

**Run #152** (2026-06-25): Smoke test (60s run at rate=3).

- 121 requests, 121/121 checks (100%)
- Duration: 60s (khong phai full 5m soak -- day la smoke validation)
- Resource samples: 30
- avg=12.45ms, p95=18.2ms, p99=22.1ms
- http_req_failed: 0%
- dropped_iterations: 0
- Memory: flat trong 60s window

**Ket qua: PASS** -- basic smoke confirm he thong on dinh trong 1 phut.

> **Can lam:** Chay lai voi `CAPACITY_DURATION_SECONDS=300` de co full 5m soak validation.
> Run #152 chi la smoke test (60s), chua phai soak test that su.
> Xem RUN_GUIDE.md de biet cach chay day du 5 phut.

## 8. Troubleshooting

| Hien tuong | Nguyen nhan co the | Cach kiem tra |
| --- | --- | --- |
| Memory tang deu | Memory leak trong service | Check `observed_resource_delta.heap_alloc_mb_delta` -- neu luon duong, co the co leak |
| p95 tang dan | Queue build-up | Tang `CAPACITY_PRE_ALLOCATED_VUS`, xem co giam drift khong |
| 429 xuat hien | Rate vuot sustained capacity | Giam `CAPACITY_RATE` xuong 2 hoac 1 |
| dropped_iterations > 0 | VU pool qua nho | Tang `CAPACITY_PRE_ALLOCATED_VUS` len 20-30 |
| CPU spike dinh ky | GC cycle | Xem `observed_resource_delta.gc_cycles_delta` |

Neu tat ca signals deu PASS: He thong cua ban khoe trong 5 phut. Tiep theo co the thu medium (15m) hoac chuyen sang case khac (soak-02 DB read, soak-03 dep recovery).
