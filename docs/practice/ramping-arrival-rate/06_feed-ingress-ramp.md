# Case 06: Cache/Feed Wave -- Little's Law Star

> **Script:** `rar-06-cache-feed-wave.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 36 arrivals/s
> **Focus:** personalized homefeed + recommendations read-heavy wave. Peak cao nhat nhung VU thap nhat series.
> **Teaching value:** Day ve Little's Law qua du lieu that -- peak 36/s chi can 1 active VU.

---

## 1. Tinh huong thuc te

### Boi canh kinh doanh

Users mo mobile app -> man hinh homefeed load len. Trong vong vai giay dau tien,
nguoi dung nhin thay danh sach san pham duoc ca nhan hoa (personalized
homefeed) va cac goi y recommendations. Day la **read path nhay cam nhat** ve
mat UX -- neu homefeed cham, nguoi dung nghi app "lag" va thoat ngay lap tuc.

Traffic nay co dac diem gi?

```text
TRAFFIC PATTERN: ENGAGEMENT WAVE (DAILY CURVE)

    arrivals/s
        ^
     36 |                          /\
        |                         /  \
        |                        /    \
     24 |                       /      \
        |                      /        \
     12 |           /\--------/          \
        |          /                       \--------\
      8 |         /                                   \
        |        /                                     \
      4 |  -----                                       -----
        |
      0 +----+----+----+----+----+----+----+----+----+----> time (s)
        0    5   10   15   20   25   30   35   40   45   50   55

        |--normal--|-----feed peak-----|--recovery--|-drain-|
        |-- feed --|                                        |
        |  15s     |      20s          |    15s     |  5s   |
```

Khac voi cac case khac trong series:
- **rar-01 (campaign surge):** Traffic marketing, bung ra roi xuong (28/s peak)
- **rar-02 (login burst):** Traffic login dot bien (24/s peak)
- **rar-03 (webhook):** Traffic thanh toan den tu ben ngoai (20/s peak)
- **rar-04 (checkout flash-sale):** Traffic checkout, nhieu API calls (12/s peak)
- **rar-05 (report job):** Traffic async, VU-hungry (8/s peak)

rar-06 la **dinh cao cua series**: peak 36/s -- con so cao nhat trong toan bo 7
case. Nhung dong thoi, no cung la case co **active VU thap nhat** (max=1). Day
chinh la dieu lam cho case nay dac biet.

### Vi sao feed traffic lai khac biet?

Homefeed/recommendations la **pure read path**:

```text
REQUEST CHARACTERISTICS:
  - GET only (khong co POST/PUT/DELETE)
  - Khong co auth session can khoi tao (anonymous hoac token trong header)
  - Khong co multi-step flow (1 API call = 1 event)
  - Response nho (gzip_kb=1, chi ~1KB compressed)
  - Backend simulation: cpu_ms=1, db_rows=3 (rat nhanh)
  - Du lieu da duoc cache trong memory/Redis
```

Trong kien truc that, feed path duoc toi uu den tan cung:

```text
CDN (CloudFront/CloudFlare)
    |
    v
API Gateway (rate limiting, routing)
    |
    v
Products Service (cache L1: in-memory)
    |
    v
Redis Cluster (cache L2: distributed)
    |
    v
PostgreSQL (cache L3: only on miss) -- RARELY HIT
```

Moi tang cache lam giam latency di mot bac. Ket qua: **p95 ~ 4ms**. Day la
response time cuc ki thap -- gan nhu ngay lap tuc.

### Cau hoi kinh doanh

Team infrastructure khong hoi "feed co chiu duoc traffic khong". Ho hoi:

```text
"Products/feed path co giu duoc 36 arrivals/s o peak ma
 khong drop request nao khong?"
```

Day la cau hoi cua **RPS contract cho feed path**, nhung khong phai la contract
co dinh (constant rate) -- ma la contract theo **engagement curve bien thien
theo thoi gian**.

### Engagement wave la gi?

Trong he thong that, feed traffic khong den deu dan 24/7:

```text
MOT NGAY BINH THUONG CUA FEED TRAFFIC:

06:00 - 08:00:  Wake-up peak     (users check phone in bed)
08:00 - 09:00:  Commute peak     (users scroll on bus/train)
09:00 - 12:00:  Normal           (background scrolling at work)
12:00 - 13:00:  Lunch peak       (scroll while eating)
13:00 - 18:00:  Afternoon dip    (lower engagement)
18:00 - 20:00:  Evening peak     (BIGGEST: after work, at home)
20:00 - 23:00:  Prime-time       (high engagement, then tapering)
23:00 - 06:00:  Night/off-peak   (minimal traffic)
```

Ramping-arrival-rate mo phong **mot "slice" cua engagement curve nay** -- cu
the la 55s mo ta mot wave traffic: normal rate tang dan -> peak buoi toi -> ha
dan -> het.

### Scale cua traffic nay

```text
Tong scheduled slots = 950 arrivals trong 55s
Trung binh = 950 / 55 ≈ 17.3 arrivals/s

Nhung peak la 36/s -- gap 2x so voi trung binh.
```

Cong thuc tinh toan slots duoc trinh bay chi tiet trong Section 4 (Config
mapping).

### Y nghia cua case nay trong toan bo series

```text
rar-01: Peak 28/s, VU=1  |--| Doc ve arrival curve co ban
rar-02: Peak 24/s, VU=1  |--| Doc ve login burst voi POST
rar-03: Peak 20/s, VU=0  |--| Doc ve webhook don gian nhat
rar-04: Peak 12/s, VU=1  |--| Doc ve multi-call flow (3 calls/event)
rar-05: Peak  8/s, VU=45 |--| Doc ve async/sleep VU pressure
rar-06: Peak 36/s, VU=1  |<-- CAO NHAT peak, THAP NHAT VU
rar-07: Peak 32/s, VU=6  |--| Doc ve mixed workload
```

rar-06 la **demonstration hoan hao nhat** cua Little's Law trong thuc te k6:

```text
LITTLE'S LAW (ap dung vao k6):
  L = λ × W

  Trong do:
    L = So VU trung binh can thiet (active workers)
    λ = Arrival rate (arrivals/s)
    W = Thoi gian trung binh moi event (seconds)

  Voi rar-06 o peak:
    λ = 36 arrivals/s
    W = 0.004s (4ms p95)
    L = 36 × 0.004 = 0.144 VU

  -> Can it hon 1 VU de xu ly toan bo 36 arrivals/s!

  So sanh voi rar-05 o peak:
    λ = 8 arrivals/s
    W = 9.01s (event p95 voi sleep)
    L = 8 × 9.01 = 72.08 VU

  -> Can 72 VU chi de xu ly 8 arrivals/s!

  MUC DO TAC DONG CUA EVENT DURATION LEN VU DEMAND:
    rar-06: peak cao gap 4.5x rar-05 (36 vs 8)
    Nhung VU demand rar-05 cao gap 500x rar-06 (72 vs 0.14)
    Ly do: W_rar05 / W_rar06 = 9.01 / 0.004 = 2252x
```

Day la bai hoc quan trong nhat cua toan bo series ramping-arrival-rate. Toi se
khai thac sau hon trong Section 6 (Open model deep-dive) va Section 15
(Nghich ly).

---

## 2. Hai yeu cau cot loi

Case nay co **2 yeu cau cot loi** ma chi `ramping-arrival-rate` open model moi
thoa man duoc dong thoi.

### Yeu cau (a): GIU INGRESS CURVE BIEN THIEN (variable arrival rate)

**Y nghia**: K6 phai bat dau iteration moi theo dung duong cong
`startRate + stages`, bat ke backend dang nhanh hay cham. Day la dieu kien
tien quyet de test engagement wave contract.

**Vi du cu the**:

```text
Config: startRate=4/s, stages:
  stage 1: 15s -> 12/s (ramp to normal)
  stage 2: 20s -> 36/s (ramp to feed peak)
  stage 3: 15s -> 8/s  (ramp to recovery)
  stage 4: 5s  -> 0/s  (ramp to drain)

Timeline 55 giay:
  t=0.0s:  startRate=4/s, slot duoc schedule
  t=0.5s:  rate ~ 4.27/s (dang ramp tu 4 len 12)
  ...
  t=15.0s: rate = 12/s, stage 1 ket thuc
  t=15.5s: rate ~ 12.6/s (dang ramp tu 12 len 36)
  ...
  t=35.0s: rate = 36/s, stage 2 ket thuc (PEAK)
  t=35.5s: rate ~ 35.1/s (dang ramp tu 36 xuong 8)
  ...
  t=50.0s: rate = 8/s, stage 3 ket thuc
  t=50.5s: rate ~ 7.2/s (dang ramp tu 8 xuong 0)
  ...
  t=55.0s: rate = 0/s, test ket thuc
```

Diem quan trong: rate thay doi lien tuc theo linear interpolation giua cac
stage targets. Khong phai la "bat dau stage voi rate X". Ma la:

```text
Trong stage 1 (15s, target tu 4->12):
  - Tai t=0s: rate = 4/s
  - Tai t=7.5s: rate = 8/s (midpoint)
  - Tai t=15s: rate = 12/s
  - K6 interpolation lien tuc, khong buoc nhay
```

### Yeu cau (b): PHAT HIEN CONTRACT BREACH QUA dropped_iterations

**Y nghia**: Khi backend khong du capacity de xu ly duong cong arrivals, test
phai **bao loi ro rang** qua `dropped_iterations`, khong duoc "im lang pass"
nhu closed model.

**Vi du cu the tu rar-05**:

```text
rar-05 report job (Run default):
  rate peak = 8/s
  scheduled_slots = 220
  iterations thuc te = 199
  dropped_iterations = 20
  event p95 = 9.01s

  => Contract breach duoc phat hien!
  => dropped_iterations = 20 > maxDropped = 0 -> FAIL
```

Trong rar-06, yeu cau (b) **khong duoc kich hoat** vi backend cache rat nhanh
va event duration cuc ki thap (4ms). Nhung no VAN LA yeu cau -- neu co su co
(cache miss hang loat, Redis down), dropped_iterations SE tang va test SE
bao FAIL.

### Tai sao ca 2 yeu cau phai thoa man DONG THOI?

```text
Neu CHI co (a) ma khong co (b):
  - Arrival curve dung nhung khong co co che bao breach
  - Giong nhu xe bus chay dung lich nhung khong ai dem hanh khach
  - Cache miss xay ra -> dropped_iterations tang -> nhung test van pass
    vi threshold qua rong hoac khong co threshold

Neu CHI co (b) ma khong co (a):
  - Co bao loi nhung arrival rate khong theo dung curve
  - Khong test duoc engagement wave contract
  - Giong nhu bao chay nhung khong co lua

Ca 2 cung co -> ramping-arrival-rate la executor DUY NHAT thoa man.
```

---

## 3. Vi sao dung `ramping-arrival-rate`?

### So sanh voi cac executor khac

| Executor | Model | Cach hoat dong | Vi sao KHONG phu hop cho feed wave? |
| --- | --- | --- | --- |
| `constant-vus` | Closed | VU loop: gui request -> doi response -> gui tiep | Throughput TU GIAM khi backend cham -> khong giu duoc arrival curve -> khong test duoc engagement wave |
| `constant-arrival-rate` | Open | Arrival rate CO DINH (rate/timeUnit) | Chi giu duoc MOT rate co dinh -> khong mo phong duoc dang curve bien thien cua engagement wave |
| `shared-iterations` | Closed | Chia N iterations cho V VUs | Iterations co dinh (khong theo toc do) -> khong mo phong duoc ingress traffic |
| `per-vu-iterations` | Closed | Moi VU chay N iterations roi dung | Giong shared-iterations nhung phan bo theo VU -> khong lien quan den ingress rate |
| `ramping-vus` | Closed | VUs tang/giam theo stages | VU thay doi nhung arrival rate KHONG duoc dam bao -> nhu constant-vus nhung co VU bien thien |
| **`ramping-arrival-rate`** | **Open** | **Arrival rate bien thien theo stages** | **Mo phong duoc engagement curve: rate tang tu normal -> peak -> recovery -> drain. Co bao breach qua dropped_iterations.** |

### Su khac biet cot loi: Open model vs Closed model

```text
CLOSED MODEL (constant-vus, ramping-vus, shared-iterations, per-vu-iterations):
  VUs ----> Requests
  So VU quyet dinh throughput
  Neu backend cham -> VU loop cham hon -> throughput GIAM
  KHONG giu duoc arrival rate co dinh
  KHONG co dropped_iterations (VU khong the "drop" vi no dang ban)

OPEN MODEL (constant-arrival-rate, ramping-arrival-rate):
  Arrival rate ----> VU pool ----> Requests
  Arrival rate quyet dinh throughput (doc lap voi backend)
  Neu backend cham -> can nhieu VU hon de giu rate
  Neu VU pool can -> dropped_iterations (slot khong co worker)
  CO dropped_iterations de bao contract breach
```

### Vi sao engagement wave CAN open model?

```text
Tinh huong that:
  18:00 - 20:00: Evening peak, nguoi dung mo app o nha
  Traffic tang dan tu 4/s len 36/s trong 20 phut
  Sau do giam dan xuong 8/s khi nguoi dung bat dau xem video/tat app

Neu dung closed model (ramping-vus):
  Config: startVUs=18, stages: 15s->50, 20s->150, 15s->33, 5s->0
  -> VUs tang dan, nhung ARRIVAL RATE LA KHONG BIET TRUOC
  -> Co the 150 VUs tao ra 36/s, co the khong
  -> Phu thuoc vao response time cua backend
  -> Neu backend nhanh -> 150 VUs co the tao ra 500/s (qua nhieu)
  -> Neu backend cham -> 150 VUs co the chi tao ra 10/s (qua it)
  -> KHONG THE DAM BAO arrival curve

Neu dung open model (ramping-arrival-rate):
  Config: startRate=4, stages: 15s->12, 20s->36, 15s->8, 5s->0
  -> ARRIVAL RATE DUOC DAM BAO CHINH XAC THEO CONFIG
  -> Neu backend nhanh -> VU pool du thua (VU idle)
  -> Neu backend cham -> VU pool bi ap luc (co the drop)
  -> dropped_iterations bao dong khi capacity khong du
  -> DAM BAO duoc engagement wave contract
```

### Loi co ban nhat khi chon executor cho engagement wave

```text
SAI LAM: Dung ramping-vus de test engagement wave

Tinh huong: Backend feed bi cham (cache miss do Redis restart)

ramping-vus voi stages VU tu 18->50->150->33:
  Backend cham -> VU loop cham -> throughput GIAM
  VU tang len 150 nhung throughput khong tang (vi VU doi response)
  Test bao "pass" vi khong co error, khong co drop
  NHUNG: Trong production, engagement wave that la 36/s tu CDN
  -> Backend cham -> queue day -> timeout -> 502
  -> User thay feed trong -> exit app

SUA DUNG: Dung ramping-arrival-rate

ramping-arrival-rate voi stages rate tu 4->12->36->8:
  Rate duoc giu co dinh theo config (36/s o peak)
  Backend cham -> VU pool bi ap luc
  Neu khong du capacity -> dropped_iterations tang
  Test FAIL -> phat hien duoc contract breach!
```

---

## 4. Config mapping

### Bang tham so

| Tham so | Default | Y nghia | Co the override? |
| --- | ---: | --- | --- |
| `RAR_06_START_RATE` | 4 | Rate ban dau cua test (arrivals/s) | Co, qua env |
| `RAR_06_NORMAL_RATE` | 12 | Rate normal feed traffic | Co, qua env |
| `RAR_06_FEED_RATE` | 36 | Rate peak feed traffic | Co, qua env |
| `RAR_06_RECOVERY_RATE` | 8 | Rate recovery sau peak | Co, qua env |
| `RAR_06_DURATION_SCALE` | 1 | He so nhan stage duration | Co, qua env |
| `RAR_06_PREALLOCATED_VUS` | 18 | VU pool khoi tao san (warm) | Co, qua env |
| `RAR_06_MAX_VUS` | 60 | VU pool ceiling (safety cap) | Co, qua env |
| `RAR_06_MAX_DROPPED` | 5 | Drop budget cho phep | Co, qua env |
| `RAR_06_USER_POOL` | 1000 | User identity pool size | Co, qua env |

### Stage math chi tiet

Cong thuc tinh toan scheduled slots cho ramping-arrival-rate:

```text
Voi moi stage, rate thay doi tuyen tinh tu rate_start den rate_end.

Formula: slots = duration × (rate_start + rate_end) / 2

Day la cong thuc dien tich hinh thang (trapezoid area):
  Area = height × (base1 + base2) / 2
       = duration × (rate_start + rate_end) / 2
```

Ap dung vao rar-06:

```text
STAGE 1: normal feed
  Duration = 15s
  Rate: 4/s -> 12/s
  Slots = 15 × (4 + 12) / 2 = 15 × 8 = 120 arrivals

STAGE 2: feed peak
  Duration = 20s
  Rate: 12/s -> 36/s
  Slots = 20 × (12 + 36) / 2 = 20 × 24 = 480 arrivals

STAGE 3: recovery
  Duration = 15s
  Rate: 36/s -> 8/s
  Slots = 15 × (36 + 8) / 2 = 15 × 22 = 330 arrivals

STAGE 4: drain
  Duration = 5s
  Rate: 8/s -> 0/s
  Slots = 5 × (8 + 0) / 2 = 5 × 4 = 20 arrivals

TOTAL = 120 + 480 + 330 + 20 = 950 scheduled slots
```

### Bang stage math

| Stage | Duration | Rate start | Rate end | Midpoint | Slots | % total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 normal feed | 15s | 4/s | 12/s | 8.0/s | 120 | 12.6% |
| 2 feed peak | 20s | 12/s | 36/s | 24.0/s | 480 | 50.5% |
| 3 recovery | 15s | 36/s | 8/s | 22.0/s | 330 | 34.7% |
| 4 drain | 5s | 8/s | 0/s | 4.0/s | 20 | 2.1% |
| **Total** | **55s** | | | **17.3/s avg** | **950** | **100%** |

### Reconciliation voi du lieu that

```text
Computed slots: 950
Observed iterations (Run #105): 949
Difference: 1 slot (0.1%)

1 slot khac biet la hoan toan binh thuong:
  - Stage transitions co micro-timing variance
  - K6 schedule slots lien tuc, boundary rounding
  - Validate qua dropped/interrupted + thresholds,
    KHONG validate qua brittle exact equality
```

### Ly do preAllocatedVUs = 18

```text
Vi sao lai la 18, khong phai 2 hay 50?

Little's Law cho biet chi can < 1 VU de xu ly peak 36/s
voi event p95 = 4ms.

Nhung preAllocatedVUs dat la 18 vi:
  1. Margin of safety: Neu cache miss, event duration co the tang
     gap 10-100x -> can nhieu VU hon
  2. Warm start: VU pool da duoc khoi tao, khong mat thoi gian spawn
     khi rate tang dan
  3. 18 = 36/2: half cua peak rate, mot heuristic don gian
  4. Trong thuc te, 18 VUs du thua rat nhieu -- chi can 1 VU
```

### Ly do maxVUs = 60

```text
60 la ceiling bao ve:
  - Neu backend cache bi xoa toan bo -> event duration tang tu 4ms
    len 100ms -> can 36 × 0.1 = 3.6 VU van chua toi 60
  - 60 la con so du cao, nhung neu co su co nghiem trong hon
    (vd DB query cham 1s) -> can 36 VU -> van trong ceiling
  - Safety factor = 60/0.14 ≈ 428x so voi yeu cau co ban
```

### Ly do maxDropped = 5

```text
maxDropped = 5 tren tong 950 slots = 0.53% drop budget.
Muc tieu thuc te la 0 drop (va da dat duoc).
Nhung 5 la margin nho cho cac boundary transitions.
```

---

## 5. Identity model deep-dive

### Loai identity: Anonymous User

rar-06 su dung **anonymous user identity model**. Day la diem khac biet quan
trong so voi cac case khac trong series.

```text
USER IDENTITY MODEL:

rar-01 (campaign):   landing-user-{n}    -- semi-anonymous
rar-02 (login):      auth-user-{n}       -- authenticated (bearer token)
rar-03 (webhook):    rar-user-{n}        -- system identity
rar-04 (checkout):   cart-user-{n}       -- authenticated user voi cart
rar-05 (report):     rar-user-{n}        -- async job submitter
rar-06 (feed):       rar-user-{n}        -- ANONYMOUS (homefeed visitor)
rar-07 (spike mix):  rar-user-{n}        -- mixed identities
```

### Vi sao feed lai la anonymous?

```text
Trong he thong that:
  - User mo app -> homefeed load TRUOC KHI login
  - Homefeed duoc ca nhan hoa qua device fingerprint, khong phai user account
  - Recommendations co the dung collaborative filtering
    (dua tren thoi quen cua user tuong tu, khong can account)

Trong k6 script:
  - userId = `rar-user-{n}` (n = iteration % userPool + 1)
  - User ID duoc gui qua header X-User-ID
  - Khong co Authorization header hay session token
  - userPool = 1000 user xoay vong
```

### Cach identity duoc tao

```javascript
// Tu common.js: userContext()
function userContext(seed, userPool) {
  const iteration = exec.scenario.iterationInTest;
  const pool = Math.max(1, userPool);
  const userNumber = (iteration % pool) + 1;
  return {
    seed,
    vuId: exec.vu.idInTest,
    iter: iteration,
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `rar-user-${userNumber}`,
    requestKey: `${seed}-${iteration}-${exec.vu.idInTest}`,
    abVariant: iteration % 2 === 0 ? 'b' : 'a',
  };
}
```

### Y nghia cua userPool = 1000

```text
Voi userPool = 1000 va 950 iterations:
  - Moi user xuat hien trung binh 950/1000 = 0.95 lan
  - Gan nhu moi request tu mot user KHAC nhau
  - Mo phong tot luong anonymous browse tu CDN
  - Khong co cache warming per-user (vi user da dang)

Neu userPool = 10:
  - Moi user xuat hien trung binh 95 lan
  - Backend cache per-user co the lam sai lech ket qua
  - Khong mo phong duoc luong anonymous that
```

### abVariant va A/B testing

```text
abVariant: iteration % 2 === 0 ? 'b' : 'a'

Day la co che A/B testing ngam:
  - 50% user thay UI variant A
  - 50% user thay UI variant B
  - Backend co the tra ve response khac nhau dua tren variant
  - Duoc gui qua header hoac query param

Trong test nay, abVariant duoc tao nhung KHONG gui len server.
No co san trong context de su dung cho cac variant setup khac.
```

### ProductId rotation

```javascript
const productId = (ctx.iter % 50) + 1;
```

```text
50 product IDs duoc xoay vong:
  - productId = 1..50
  - Recommendations lay theo productId cu the
  - Mo phong nguoi dung xem recommendations cho cac san pham khac nhau
  - Khong phai la random -- deterministic rotation de ket qua on dinh
    giua cac lan chay
```

---

## 6. Open model deep-dive -- Little's Law Star

Day la **phan quan trong nhat** cua case nay va cung la **bai hoc cot loi**
cua toan bo series ramping-arrival-rate.

### Little's Law ap dung vao k6

```text
LITTLE'S LAW (kinh dien):
  L = λ × W

  Trong do:
    L = average number of items in the system (VUs)
    λ = arrival rate (arrivals/s)
    W = average time an item spends in the system (event duration)

Ap dung vao k6 open model:
  L = so VU can thiet de giu arrival rate λ
      (khi event duration trung binh la W)

  required_vus ≈ peak_arrival_rate × avg_event_duration
```

### Ap dung vao rar-06

```text
THONG SO THUC TE (Run #105):
  peak_arrival_rate = 36 arrivals/s
  event_p95 = 4 ms = 0.004 seconds
  event_avg = 3.28 ms = 0.00328 seconds

TINH TOAN:
  required_vus (avg) = 36 × 0.00328 = 0.118 VU
  required_vus (p95) = 36 × 0.004   = 0.144 VU

KET QUA:
  Can < 1 VU de xu ly toan bo 36 arrivals/s!
  Active VU observed max = 1 (dashboard xac nhan)
```

### SO SANH VOI TUNG CASE TRONG SERIES

Day la bang so sanh quan trong nhat cua toan bo series:

| Case | Peak (arr/s) | Event p95 (ms) | Event avg (ms) | Required VUs (avg) | Required VUs (p95) | Active VU observed | preAlloc VUs | Drop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rar-01 campaign | 28 | 5 | 4.04 | 0.11 | 0.14 | 1 | 18 | 0 |
| rar-02 login | 24 | 23 | 20.39 | 0.49 | 0.55 | 1 | 16 | 0 |
| rar-03 webhook | 20 | 6 | 5.61 | 0.11 | 0.12 | 0 | 16 | 0 |
| rar-04 checkout | 12 | 112 | 89.27 | 1.07 | 1.34 | 1 | 25 | 0 |
| rar-05 report | 8 | 9010 | 4700 | **37.6** | **72.1** | **45** | 25 | **20** |
| **rar-06 feed** | **36** | **4** | **3.28** | **0.118** | **0.144** | **1** | **18** | **0** |
| rar-07 mix | 32 | 86 | 72.16 | 2.31 | 2.75 | 6 | 30 | 0 |

### Phan tich bang so sanh

```text
PHAT HIEN CHINH:

1. rar-06 co peak CAO NHAT (36/s) nhung required VUs THAP NHAT (0.14)
   -> Peak rate KHONG quyet dinh VU demand. Event duration MOI quyet dinh.

2. rar-05 co peak THAP NHAT (8/s) nhung required VUs CAO NHAT (72.1)
   -> Peak thap 4.5x rar-06 nhung VU demand gap 500x
   -> Ly do: event duration rar-05 gap 2250x rar-06
   -> 500/4.5 ≈ 111x tac dong tu event duration

3. rar-04 co peak 12/s (thap nhat nhi) nhung required VUs = 1.34
   -> Cao hon rar-06 gap 9.5x mac du peak chi bang 1/3
   -> Ly do: event duration 112ms (multicall checkout flow)

4. rar-01, rar-02, rar-03 deu can < 1 VU
   -> Event duration duoi 25ms -> VU chi can xu ly 1 event 1 luc

5. rar-07 can 2.3 VUs o avg, 2.75 o p95
   -> Ly do: mixed workload co mot so branch cham (checkout 30ms,
      report 1ms+gzip), lam tang event duration trung binh
```

### Little's Law sensitivity analysis

Mot trong nhung dieu quan trong nhat de hieu la **do nhay cam** cua VU demand
voi event duration:

```text
Voi peak rate co dinh = 36/s:

 Event duration | Required VUs | Scenario
 -------------- | ------------ | --------
 1 ms           | 0.036        | Pure in-memory cache hit
 4 ms           | 0.144        | CURRENT: cache hit voi 3 DB rows
 10 ms          | 0.36         | Cache hit + network latency tang
 50 ms          | 1.8          | Partial cache miss (Redis hit)
 100 ms         | 3.6          | Cache miss (DB query)
 500 ms         | 18           | Slow DB query (lock contention)
 1000 ms        | 36           | DB timeout / cold start
 5000 ms        | 180          | SERIOUS degradation (exceeds maxVUs=60!)

Voi maxVUs = 60:
  - Co the chiu duoc event duration den ~1667ms (60/36)
  - Sau nguong nay -> dropped_iterations bat dau tang
```

### Tai sao event duration rar-06 lai thap den vay?

```text
CAU TRUC REQUEST:
  GET /api/sim/products/homefeed?personalized=1&cpu_ms=1&db_rows=3&json_items=12&gzip_kb=1

Backend simulation parameters:
  cpu_ms = 1       -> CPU work chi 1ms
  db_rows = 3      -> DB query tra ve 3 rows (nho)
  json_items = 12  -> Response JSON co 12 items
  gzip_kb = 1      -> Compressed response ~1KB

Total simulated work:
  CPU: 1ms
  DB:  ~1-2ms (3 rows, indexed query)
  Serialization: ~1ms
  Network transfer: ~0.2ms (1KB over localhost)

TOTAL: ~3-4ms -> matches observed p95 = 4ms
```

### Little's Law voi multi-call events

Can phan biet ro: event duration la toan bo thoi gian tu luc
`rampingArrivalEventsTotal.add(1)` den luc `rampingArrivalEventDurationMs.add(...)`.

```text
rar-04: 3 HTTP calls trong 1 event
  cart add + checkout create + confirm
  Event p95 = 112ms, HTTP p95 = 54.85ms (trung binh moi call)
  112ms / 3 calls ≈ 37ms per call average
  VU demand = 12 × 0.112 = 1.34 VUs

rar-05: 1 hoac 2 HTTP calls trong 1 event + SLEEP
  async: create job + sleep(0.14s) + status poll
  dashboard: 1 call
  Event p95 = 9010ms (doi async job ready + polling)
  Sleep 140ms giu VU idle -> khong the xu ly arrival khac
  VU demand = 8 × 9.01 = 72.1 VUs (!)

rar-06: 1 HTTP call trong 1 event
  Chi 1 GET request
  Event p95 = 4ms = HTTP p95 = 3.89ms (gan bang nhau)
  Khong co sleep, khong co multi-step
  VU demand = 36 × 0.004 = 0.144 VUs
```

### Bai hoc rut ra

```text
BA BAI HOC COT LOI TU LITTLE'S LAW TRONG SERIES NAY:

1. PEAK RATE KHONG PHAI LA YEU TO QUAN TRONG NHAT
   - rar-06: peak 36/s -> chi can 1 VU
   - rar-05: peak 8/s -> can 72 VUs
   - Dieu quan trong la EVENT DURATION, khong phai peak rate

2. SLEEP() LA SAT THU CUA VU CAPACITY
   - rar-05: 140ms sleep -> VU bi giu idle -> drop hang loat
   - rar-06: 0ms sleep -> VU free ngay lap tuc -> zero drop
   - Trong open model, moi ms VU idle la mot slot co the bi drop

3. MULTI-CALL FLOW LAM TANG VU DEMAND
   - rar-04: 3 calls/event -> event duration 112ms -> VU=1.34
   - rar-06: 1 call/event -> event duration 4ms -> VU=0.14
   - Gap 10x event duration -> gap 10x VU demand
```

---

## 7. Service/API flow

### Tong quan flow

```text
     START
       |
       v
  [weightedPick]
  70% /    \ 30%
  /             \
 v               v
homefeed    recommendations
  |               |
  v               v
GET /homefeed  GET /:id/recommendations
  |               |
  v               v
 [finishEvent]  [finishEvent]
  |               |
  +-------+-------+
          |
          v
        END
```

### Branch 1: Homefeed (70%)

```text
OPERATION: feed_wave_homefeed
METHOD: GET
ENDPOINT: /api/sim/products/homefeed

QUERY PARAMETERS:
  personalized=1   -- Enable personalized feed
  cpu_ms=1         -- CPU work simulation: 1ms
  db_rows=3        -- DB fetch: 3 rows
  json_items=12    -- Response JSON co 12 items
  gzip_kb=1        -- Compressed response ~1KB

TAGS:
  caseId: "rar-06-cache-feed-wave"
  service: "products-service"
  operation: "feed_wave_homefeed"
  endpoint: "GET /api/sim/products/homefeed"
  userId: "rar-user-{n}"

HEADERS:
  X-Test-Suite: "ramping-arrival-rate"
  X-Load-Profile: "ramping-arrival-rate-practice"
  X-User-ID: "rar-user-{n}"

EXPECTED STATUS: 200
```

### Branch 2: Recommendations (30%)

```text
OPERATION: feed_wave_recommendations
METHOD: GET
ENDPOINT: /api/sim/products/:id/recommendations

QUERY PARAMETERS:
  algorithm=collaborative  -- Collaborative filtering algorithm
  cpu_ms=2                 -- CPU work simulation: 2ms
  db_rows=2                -- DB fetch: 2 rows
  limit=6                  -- Tra ve toi da 6 recommendations

PATH PARAMETER:
  :id = productId (1..50, xoay vong theo iteration)

TAGS:
  caseId: "rar-06-cache-feed-wave"
  service: "products-service"
  operation: "feed_wave_recommendations"
  endpoint: "GET /api/sim/products/:id/recommendations"
  userId: "rar-user-{n}"

HEADERS:
  X-Test-Suite: "ramping-arrival-rate"
  X-Load-Profile: "ramping-arrival-rate-practice"
  X-User-ID: "rar-user-{n}"

EXPECTED STATUS: 200
```

### Tai sao lai la 70/30 split?

```text
Trong he thong that:
  - 70% nguoi dung NHIN homefeed va scroll (khong bam vao item)
  - 30% nguoi dung BAM vao 1 item -> xem chi tiet -> recommendations
    xuat hien o cuoi trang

He so weightedPick:
  weight = 70 cho homefeed
  weight = 30 cho recommendations
  Total weight = 100
  pick = iteration % 100

  Neu pick < 70 -> homefeed (70% co hoi)
  Neu pick >= 70 -> recommendations (30% co hoi)
```

### Chi phi so voi cac case khac

| Case | Branches | Calls/event | Services | Avg event duration | Complexity |
| --- | ---: | ---: | --- | ---: | --- |
| rar-01 | 3 (55/30/15) | 1 | 1 | 4 ms | Low |
| rar-02 | 3 (60/25/15) | 1 | 1 | 20 ms | Low |
| rar-03 | 1 (100%) | 1 | 1 | 5 ms | Very Low |
| rar-04 | 1 path, 3 calls | 3 | 2 | 89 ms | High |
| rar-05 | 2 (60/40) | 1-2 | 1 | 4700 ms | High (async + sleep) |
| **rar-06** | **2 (70/30)** | **1** | **1** | **3 ms** | **Low (simple + fast)** |
| rar-07 | 6 (35/20/18/12/10/5) | 1 | 5 | 72 ms | Very High |

rar-06 la case co **do phuc tap thap** + **event duration thap** + **peak rate
cao**. Chinh su ket hop nay tao nen bai hoc ve Little's Law.

---

## 8. Metrics & tags

### Metrics rieng cua ramping-arrival-rate

```text
4 CUSTOM METRICS DUOC DINH NGHIA TRONG common.js:

1. ramping_arrival_events_total (Counter)
   - Tag: case_id, service, operation, user_id
   - Mo ta: Tong so event da duoc bat dau
   - Duoc goi trong finishEvent()
   - Gia tri = so iteration completed
   - Day la TOTAL events, khong phai success events

2. ramping_arrival_events_failed (Counter)
   - Tag: case_id, service, operation, user_id
   - Mo ta: Tong so event bi fail (check khong pass)
   - Duoc goi trong finishEvent() khi ok=false
   - Neu > 0 -> co event gap van de

3. ramping_arrival_api_calls_total (Counter)
   - Tag: case_id, service, operation, endpoint, user_id, name
   - Mo ta: Tong so HTTP request da gui
   - Duoc goi trong requestJson()
   - Voi rar-06: 1 call/event -> api_calls = iterations = 949

4. ramping_arrival_event_duration_ms (Trend)
   - Tag: case_id, service, operation, user_id
   - Mo ta: Thoi gian hoan thanh event (ms)
   - Do tu luc startedAt den luc finishEvent()
   - Bao gom HTTP time + JS processing + any wait/sleep
   - Voi rar-06: avg=3.28ms, p95=4ms
```

### Cac metrics tich hop cua k6

```text
1. iterations (Counter)
   - Tag: scenario, group
   - Tong iteration da hoan thanh (tuong duong events completed)
   - rar-06: 949

2. http_reqs (Counter)
   - Tag: expected_response, method, name, proto, scenario, status, tls_version, url
   - Tong HTTP requests da gui
   - rar-06: 949 (= iterations, vi 1 call/event)

3. dropped_iterations (Counter)
   - Tag: scenario
   - So iteration khong duoc bat dau vi thieu VU
   - rar-06: 0

4. vus (Gauge)
   - So VU active tai thoi diem sample
   - rar-06: min=0, max=1

5. vus_max (Gauge)
   - So VU toi da duoc k6 spawn
   - rar-06: 18 (= preAllocatedVUs)

6. checks (Rate)
   - Ty le check pass
   - rar-06: 100%

7. http_req_failed (Rate)
   - Ty le HTTP request bi failed
   - rar-06: 0%
```

### Tags co ban

```text
TAGS DUOC GAN VAO MOI EVENT:

Tren URL-level (HTTP tags):
  - case_id: "rar-06-cache-feed-wave"
  - service: "products-service"
  - operation: "feed_wave_homefeed" hoac "feed_wave_recommendations"
  - endpoint: "GET /api/sim/products/homefeed" hoac ".../:id/recommendations"
  - user_id: "rar-user-{n}"
  - name: operation name (dung cho dashboard chart grouping)

Tren scenario-level:
  - executor_family: "ramping_arrival_rate"
  - workload_shape: "ramping_ingress_rate"
  - case_id: "rar-06-cache-feed-wave"
  - business_case: "personalized_feed_ramping_ingress"
```

### Cach query metrics tu dashboard

```text
EVENT-LEVEL:
  sum(ramping_arrival_events_total{case_id="rar-06-cache-feed-wave"})
  -> Tong so events = 949

  sum(ramping_arrival_events_failed{case_id="rar-06-cache-feed-wave"})
  -> Tong events failed = 0

  histogram_quantile(0.95,
    rate(ramping_arrival_event_duration_ms_bucket{
      case_id="rar-06-cache-feed-wave"}[5m]))
  -> Event p95 (dashboard tinh tu Trend metric)

REQUEST-LEVEL:
  sum(ramping_arrival_api_calls_total{case_id="rar-06-cache-feed-wave"})
  -> Tong API calls = 949

  sum(rate(ramping_arrival_api_calls_total{
    case_id="rar-06-cache-feed-wave"}[5m]))
  -> API calls per second

BREAKDOWN BY OPERATION:
  sum(ramping_arrival_api_calls_total{
    case_id="rar-06-cache-feed-wave",
    operation="feed_wave_homefeed"})
  -> 679 homefeed calls

  sum(ramping_arrival_api_calls_total{
    case_id="rar-06-cache-feed-wave",
    operation="feed_wave_recommendations"})
  -> 270 recommendations calls
```

---

## 9. Pass criteria

### Thresholds

```javascript
thresholds: {
  checks:                ['rate>0.98'],     // 98% checks must pass
  http_req_failed:       ['rate<0.02'],     // <2% HTTP failures
  dropped_iterations:    [`count<=5`],      // max 5 dropped
  ramping_arrival_events_failed: ['count<20'], // <20 failed events
}
```

### Y nghia cua moi threshold

```text
1. checks > 0.98
   - Dam bao HTTP status tra ve dung (200 cho ca 2 branches)
   - Neu recommendations branch tra ve 404/500 ->
     checks_rate se giam
   - Voi rar-06: checks = 949/949 = 1.0 (100%)

2. http_req_failed < 0.02
   - Dam bao HTTP requests khong bi failed (connection, timeout)
   - Khac voi checks: http_req_failed la HTTP layer error
     (connection refused, DNS fail, timeout)
   - Voi rar-06: 0/949 = 0%

3. dropped_iterations <= 5
   - DAM BAO INGRESS CONTRACT
   - Day la threshold QUAN TRONG NHAT trong open model
   - Neu dropped > 5 -> VU pool khong du capacity
   - Voi rar-06: 0 (thuc te du thua capacity)

4. ramping_arrival_events_failed < 20
   - Dam bao event-level failure thap
   - Event failed = check() tra ve false hoac exception trong event
   - Voi rar-06: 0
```

### Tai sao dropped_iterations la threshold quan trong nhat?

```text
Trong open model:
  dropped_iterations = slot duoc schedule nhung KHONG CO VU nao san sang

Day la tin hieu TRUC TIEP cua contract breach:
  - Backend cham -> event duration tang -> VU bi giu lau hon
  - VU pool can -> slot moi den nhung khong co worker
  - -> dropped_iterations
  - -> k6 KHONG THE giu arrival rate nhu da config

So sanh voi cac threshold khac:
  checks, http_req_failed, events_failed -> HTTP/application health
  dropped_iterations -> INFRASTRUCTURE CAPACITY

Tat ca HTTP test co the pass (checks=100%, http_req_failed=0%)
nhung dropped_iterations > threshold -> VAN FAIL.
Xem rar-05 de thay dieu nay trong thuc te.
```

### Pass/fail decision matrix

```text
                  | dropped=0 | dropped<=5 | dropped>5  |
------------------|-----------|------------|------------|
checks=100%       | PASS      | PASS       | FAIL       |
checks=98-100%    | PASS      | PASS       | FAIL       |
checks<98%        | FAIL      | FAIL       | FAIL       |
http_req_failed>2%| FAIL      | FAIL       | FAIL       |
events_failed>=20 | FAIL      | FAIL       | FAIL       |
```

---

## 10. Cach chay + output 5 buoc

### Buoc 1: Kiem tra moi truong (pre-flight)

```powershell
# Kiem tra k6 version
k6 version
# Expected: k6.exe v2.0.0 (hoac cao hon)

# Kiem tra metrics server
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
Invoke-RestMethod -Uri "http://localhost:18080/v1/me" -Headers @{
    Authorization = "Bearer student-token-1234567890"
}
# Expected: HTTP 200

# Kiem tra load target
Invoke-RestMethod -Uri "http://localhost:80/health"
# Expected: HTTP 200

# Kiem tra script inspect
k6 inspect "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js"
# Expected: executor=ramping-arrival-rate
```

### Buoc 2: Chay test co ban (default config)

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js"
```

Expected output:

```text
     script: .../rar-06-cache-feed-wave.js
     output: cloud (http://localhost:18080)

     /\      |‾‾| /‾‾/   /‾‾/
/\  /  \     |  |/  /   /  /
/  \/    \    |     (   /   ‾‾\
/          \   |  |\  \ |  (‾)  |
/ __________ \  |__| \__\ \_____/ .io

     execution: local
        output: cloud (http://localhost:18080)
     ...

     checks........................: 100% ✓ 949
     http_req_failed..............: 0.00% ✓ 0
     dropped_iterations...........: 0     ✓ 0
     ramping_arrival_events_failed: 0     ✓ 0

     running (55.0s), 00/18 VUs, 949 complete, 0 interrupted
```

### Buoc 3: Kiem tra summary metrics

```text
KIEM TRA CAC METRICS QUAN TRONG:

1. iterations = 949 (≈ 950 scheduled)
2. dropped_iterations = 0
3. http_reqs = 949 (= iterations)
4. checks_rate = 1.0 (100%)
5. http_req_failed_rate = 0
6. ramping_arrival_events_failed_rate = 0
7. vus_max = 18 (preAllocatedVUs)
8. Active VU max = 1 (dashboard)

CONG THUC RECONCILIATION:
  scheduled_slots ≈ iterations + dropped + interrupted
  950 ≈ 949 + 0 + 0 = 949
  Delta = 1 slot -> boundary timing variance -> PASS
```

### Buoc 4: Kiem tra dashboard charts

```text
MO TRINH DUYET:
  http://localhost:18080

KIEM TRA 3 CHART CHINH:

1. Execution Timeline:
   - Iterations chart: points=54, sum=949, min=2, max=36
   - http_reqs: points=949, sum=949, min=1, max=1
   - Truncation: false cho ca 2

2. Active VUs:
   - VUs: min=0, max=1
   - vus_max: 18 (tong so VU duoc khoi tao)

3. Response Times:
   - Event p95 = 4ms
   - HTTP p95 = 3.89ms
   - Homefeed vs Recommendations breakdown
```

### Buoc 5: Kiem tra executor tab

```text
DASHBOARD -> EXECUTOR TAB:

  case_id: "rar-06-cache-feed-wave"
  business_case: "personalized_feed_ramping_ingress"
  executor: "ramping-arrival-rate"
  executor_family: "ramping_arrival_rate"
  workload_shape: "ramping_ingress_rate"

Neu cac tags nay khop -> script va dashboard da duoc cau hinh dung.
```

### Cach chay voi custom parameters

```powershell
# Test voi custom peak rate
$env:RAR_06_FEED_RATE = "50"
k6 run "...\rar-06-cache-feed-wave.js"
Remove-Item Env:RAR_06_FEED_RATE

# Test voi duration gap doi
$env:RAR_06_DURATION_SCALE = "2"
k6 run "...\rar-06-cache-feed-wave.js"
Remove-Item Env:RAR_06_DURATION_SCALE

# Test voi user pool lon hon
$env:RAR_06_USER_POOL = "10000"
k6 run "...\rar-06-cache-feed-wave.js"
Remove-Item Env:RAR_06_USER_POOL

# Test voi VU ceiling thap
$env:RAR_06_PREALLOCATED_VUS = "2"
$env:RAR_06_MAX_VUS = "5"
k6 run "...\rar-06-cache-feed-wave.js"
Remove-Item Env:RAR_06_PREALLOCATED_VUS, Env:RAR_06_MAX_VUS
```

---

## 11. Dashboard 3-chart reading guide

### Chart 1: Execution Timeline (iterations and http_reqs)

```text
CHART MO TA:
  - Truc X: Thoi gian (0 -> 55s)
  - Truc Y: So iterations / http_reqs moi bucket (sample interval)
  - Moi diem la mot sample (khoang 1s)

CACH DOC:

   iterations/s
      ^
   36 |                          ***
      |                        **    **
   30 |                       *        *
      |                      *          *
   24 |                     *            *
      |                    *              *
   18 |                   *                *
      |                  *                  *
   12 |           *******                    *----*
      |          *                               *
    6 |        *                                   *----*
      |   ****                                           ****
    0 +----+----+----+----+----+----+----+----+----+----+---->
      0    5   10   15   20   25   30   35   40   45   50   55

DIEM CAN KIEM TRA:

1. Hinh dang curve:
   - Doc theo hinh thang: 4->12 (stage 1), 12->36 (stage 2),
     36->8 (stage 3), 8->0 (stage 4)
   - Curve phai TUONG TU duong cong trong config
   - rar-06: curve matches perfectly

2. So diem (points):
   - iterations chart: 54 points (1 sample/s × 55s ≈ 55, observed 54)
   - http_reqs chart: 949 points (= so request, vi http_reqs la counter
     khong phai sample)

3. Tong (sum):
   - iterations sum = 949 ≈ 950 target
   - Khong duoc dung pointCount de tinh tong

4. Truncation:
   - truncated=false -> tat ca diem deu duoc tra ve
   - Neu truncated=true -> so diem qua lon, dashboard da cat bot

5. Min/Max:
   - min iterations/bucket = 2 (drain phase)
   - max iterations/bucket = 36 (peak phase)
   - Day la toc do iterations trong 1 bucket, khong phai config rate
```

### Chart 2: Active VUs

```text
CHART MO TA:
  - Truc X: Thoi gian (0 -> 55s)
  - Truc Y: So VU active tai thoi diem sample
  - Moi diem la mot sample (khoang 1s)

CACH DOC RAR-06:

   Active VUs
      ^
    2 |
      |
    1 |   ***   ***   ***   ***   ***   ***
      | **   **   **   **   **   **   **   **
    0 +----+----+----+----+----+----+----+---->
      0   10   20   30   40   50

   -> Active VU dao dong giua 0 va 1
   -> KHONG BAO GIO vuot qua 1
   -> Day la MINH CHUNG TRUC QUAN cho Little's Law

SO SANH VOI CAC CASE KHAC:

   rar-01: VU = 0-1 (event 5ms)
   rar-02: VU = 0-1 (event 23ms)
   rar-03: VU = 0 (event 6ms, gan nhu invisible)
   rar-04: VU = 0-1 (event 89ms, VU busy giua samples)
   rar-05: VU = 0-45 (event 9010ms, VU pressure RO RANG)
   rar-06: VU = 0-1 (event 4ms)
   rar-07: VU = 0-6 (event 72ms mixed)

DIEM CAN KIEM TRA:

1. Active VU max:
   - rar-06: max=1, thap nhat series cung voi cac case nhanh khac
   - So sanh voi preAllocatedVUs=18: chi 1/18 VUs duoc dung cung luc
   - Con 17 VUs idle -> du thua capacity

2. VU min = 0:
   - Mot so bucket khong co VU active
   - Events hoan thanh qua nhanh (4ms) giua cac sample (1s)
   - VU co the da xu ly 250 events giua 2 sample ma chart khong thay

3. vus_max trong summary:
   - = 18 (= preAllocatedVUs)
   - Day la so VU toi da duoc spawn, khong phai active cung luc
   - KHONG doc nham: vus_max=18 KHONG co nghia la 18 VU chay dong thoi
```

### Chart 3: Response Times (event duration and HTTP duration)

```text
CHART MO TA:
  - Histogram hoac percentile chart cua event/HTTP duration
  - Phan bo response time theo thoi gian

CACH DOC RAR-06:

   Event Duration (ms)
      ^
    8 |                                    *
      |
    6 |
      |
    4 |                         *    *    *
      |          *    *    *    *    *    *    *    *
    2 |    *    *    *    *    *    *    *    *    *    *
      | *    *    *    *    *    *    *    *    *    *    *
    0 +----+----+----+----+----+----+----+----+----+----+---->
      0    5   10   15   20   25   30   35   40   45   50   55

   -> Event duration ON DINH o 2-5ms trong suot test
   -> Khong co spike, khong co degradation
   -> HTTP p95 = 3.89ms, event p95 = 4ms

BREAKDOWN THEO OPERATION:

   Homefeed (70%, 679 requests):
     - Response nho (gzip_kb=1, json_items=12)
     - cpu_ms=1, db_rows=3
     - HTTP p95 ~ 3-4ms

   Recommendations (30%, 270 requests):
     - Response nho (limit=6)
     - cpu_ms=2 (gap 2x homefeed), db_rows=2
     - HTTP p95 ~ 4-5ms (nhe nhuong hon homefeed)

   Khong co su khac biet lon giua 2 branches vi ca 2 deu la simple GET
   voi backend simulation nhe.

DIEM CAN KIEM TRA:

1. Event p95 vs HTTP p95:
   - Event p95 = 4ms, HTTP p95 = 3.89ms
   - Delta = 0.11ms -> JS processing time gan nhu bang 0
   - Xac nhan: 1 call/event, khong co sleep, khong co multi-step

2. Tail latency (p99, max):
   - p99 = 5ms, max = 8ms
   - Rat chat, khong co long tail
   - Xac nhan backend cache on dinh

3. Phan bo deu dan:
   - Khong co su khac biet giua normal phase va peak phase
   - Response time KHONG phu thuoc vao arrival rate
   - Dau hieu cua backend khong bi saturation
```

---

## 12. 4 output -> decision scenarios

### Scenario 1: Perfect cache hit (PASS -- default case)

```text
OUTPUT:
  iterations = 949 (≈ 950 target)
  dropped_iterations = 0
  checks = 100%
  http_req_failed = 0%
  events_failed = 0
  event p95 = 4ms
  active VU max = 1

INTERPRETATION:
  - Backend/cache hoan toan khoe manh
  - 36/s peak duoc xu ly de dang voi < 1 VU
  - Feed path da duoc toi uu tot
  - Ingress contract met 100%

DECISION:
  PASS. Feed path san sang cho production engagement wave.
  Co the xem xet tang peak rate len 50/s hoac cao hon de
  tim gioi han that su cua he thong (xem Section 14 -- Variations).
```

### Scenario 2: Recommendations latency dominates

```text
OUTPUT:
  iterations = 940
  dropped_iterations = 10 (> maxDropped=5 -> FAIL)
  checks = 98%
  http_req_failed = 0%
  overall event p95 = 25ms (tang so voi default 4ms)

  Breakdown:
    homefeed p95 = 4ms (van nhanh)
    recommendations p95 = 80ms (CHAM HON GAP 20x!)

  Active VU max = 3 (tang so voi default 1)

INTERPRETATION:
  - Homefeed van nhanh -> cache cho personalized feed tot
  - Recommendations CHAM -> collaborative filtering algorithm
    co the dang query DB hoac re-compute matrix
  - Tai sao recommendations cham?:
    + algorithm=collaborative -> tim similar users -> can scan
      nhieu rows (DB pressure)
    + cpu_ms=2 cho recommendations vs cpu_ms=1 cho homefeed
      -> da co dau hieu recommendations nang hon
    + Neu backend that su query DB (khong cache) -> 80ms la
      dien hinh (index scan + join + sort)

DECISION:
  FAIL (dropped > maxDropped). Can dieu tra recommendations path:
  1. Kiem tra Redis cache hit rate cho collaborative filter queries
  2. Xem xet pre-compute recommendations (offline batch job)
  3. Tang cpu_ms parameter de mo phong nang hon
  4. Neu recommendations cham toan bo -> phan tach scenario rieng
     de recommendations khong anh huong homefeed
```

### Scenario 3: dropped_iterations o peak voi latency thap

```text
OUTPUT:
  iterations = 940
  dropped_iterations = 10 (> maxDropped=5 -> FAIL)
  checks = 100%
  http_req_failed = 0%
  event p95 = 4ms (van nhanh!)
  active VU max = 1

INTERPRETATION:
  Rat la! Latency van thap nhung dropped_iterations > 0?
  -> VU pool khong du capacity, NHUNG khong phai do event cham
  -> Nguyen nhan co the:
     1. preAllocatedVUs qua thap: chi 1 hoac 2 VUs duoc spawn,
        khi can spawn them -> delay -> drop
     2. gracePeriod hoac spawn rate: k6 spawn VU moi cham,
        trong khi arrival rate tang nhanh tu 12 len 36
     3. System resource contention: CPU/memory tren may test
        khong du de spawn VU kip thoi

  Thu nghiem: Tang preAllocatedVUs tu 18 len 30
    -> Neu drop giam -> la preAllocatedVUs issue
    -> Neu drop KHONG giam -> la system resource issue

DECISION:
  FAIL (dropped > maxDropped). Can dieu tra:
  1. Tang preAllocatedVUs -> rerun
  2. Kiem tra CPU/memory tren may chay k6
  3. Xem xet gracefulStop hoac gracePeriod
  4. Neu van drop -> xem xet tang maxDropped budget
```

### Scenario 4: What if gzip_kb = 50 (heavy response)?

```text
SCENARIO: Cache bi miss -> backend tra ve response KHONG compressed
         hoac response JSON lon hon du kien rat nhieu.

THAY DOI: gzip_kb: 1 -> 50 (response 50KB thay vi 1KB)

TAC DONG THEO LITTLE'S LAW:

  Event duration (estimate):
    Hien tai:  4ms (gzip_kb=1)
    Moi:       ~50ms (gzip_kb=50, network transfer + serialization)
    Tang:      12.5x

  Required VUs:
    Hien tai:  36 × 0.004 = 0.14 VU
    Moi:      36 × 0.05  = 1.8 VU
    Tang:      12.5x

  Van trong kha nang cua 18 VU pool -> khong drop!

  NHUNG neu CPU cung bi anh huong:
    gzip_kb=50 -> cpu_ms co the tang tu 1ms len 5ms
    -> Event duration: 50ms + 5ms + DB = ~56ms
    -> Required VUs: 36 × 0.056 = 2.0 VU
    -> Van an toan voi 18 VU pool

  GIOI HAN: Khi nao thi drop?
    De dat drop voi 18 VUs:
      18 = 36 × W -> W = 0.5s = 500ms
    Vay event duration can > 500ms de bat dau drop
    -> gzip_kb can tang len ~500+ hoac cpu_ms can len 500ms
    -> Hoac ket hop: CPU + DB + network = 500ms

DECISION:
  Voi gzip_kb=50, test van pass. Day la diem manh cua feed path:
  ngay ca khi response nang gap 50x, VU pool 18 van du.
  Chi khi event duration > 500ms (tang 125x) moi co drop.
```

---

## 13. Nghich ly / misconceptions

Day la phan tong ket cac hieu lam pho bien khi doc du lieu cua case nay.

### Nghich ly lon nhat: Peak cao nhat, VU thap nhat

```text
PARADOX CUA rar-06:

  Trong 7 case ramping-arrival-rate:
    rar-06 co peak rate CAO NHAT (36 arrivals/s)
    Nhung active VU max THAP NHAT (chi 1)
    Va required VUs cung THAP NHAT (0.14)

  Trong khi do:
    rar-05 co peak rate THAP NHAT (8 arrivals/s)
    Nhung active VU max CAO NHAT (45)
    Va required VUs cung CAO NHAT (72.1)

  Cau hoi: Tai sao?

  Cau tra loi: EVENT DURATION.

  rar-06:
    Event p95 = 0.004s (4 millisecond)
    36 events/s × 0.004s/event = 0.144 VU

  rar-05:
    Event p95 = 9.01s (9010 millisecond)
    8 events/s × 9.01s/event = 72.1 VU

  Event duration rar-05 gap 2252x rar-06
  -> VU demand rar-05 gap 500x rar-06

  LITTLE'S LAW GIAI THICH TAT CA.
```

### Misconception 1: "Peak rate 36/s nghe rat scary"

```text
SAI: "36/s la con so lon, phai can nhieu VU, nhieu server"

THUC TE: 36/s voi event 4ms thi chi can 1 VU.
  - 36 events/s, moi event 4ms -> tong thoi gian xu ly = 144ms/s
  - 1 VU co 1000ms/s -> 1 VU chi su dung 14.4% thoi gian
  - Con du 85.6% thoi gian idle

  Dieu dang so KHONG PHAI LA peak rate.
  Dieu dang so LA EVENT DURATION.
  rar-05 chi 8/s nhung event 9s -> can 45 VUs, drop 20 slots.
```

### Misconception 2: "Dung ramping-vus de test engagement wave"

```text
SAI: "Chi can configure ramping-vus stages matching expected traffic"

THUC TE:
  ramping-vus tang SO VU -> throughput PHU THUOC vao response time
  -> Khong dam bao arrival rate co dinh
  -> Khong co dropped_iterations de bao contract breach
  -> Neu backend cham -> VU nhung khong tao du arrival rate
  -> Neu backend nhanh -> VU tao qua nhieu arrival rate (overload)

  Chi ramping-arrival-rate moi DAM BAO arrival curve doc lap voi backend.
```

### Misconception 3: "vus_max = preAllocatedVUs = 18 nghia la 18 VU chay dong thoi"

```text
SAI: "Summary show vus_max=18, vay 18 VU da chay dong thoi"

THUC TE:
  vus_max trong summary = so VU toi da duoc spawn (pool size)
  Active VU chart max = 1 (chi co 1 VU thuc su active cung luc)
  17 VU con lai duoc spawn nhung idle (cho event)

  Tuong tu nhu: Co 18 nhan vien san sang,
  nhung chi 1 nguoi lam viec tai moi thoi diem
  vi cong viec qua nhanh (4ms).
```

### Misconception 4: "0 VU active = khong co VU nao lam viec"

```text
SAI: "Dashboard chart show active VU = 0 o mot so bucket,
      vay khong co VU nao chay"

THUC TE:
  Active VU = 0 nghia la TAI THOI DIEM SAMPLE, khong co VU
  nao dang trong trang thai "busy".

  Nhung GIUA 2 sample (1s interval):
    Event hoan thanh trong 4ms -> VU nhan event, xu ly 4ms,
    xong -> idle -> cho event moi

  Trong 1 giay giua 2 sample:
    VU co the da xu ly 250 events (1000ms / 4ms)
    Nhung dashboard chi sample 1 lan/giay
    -> Tai thoi diem sample, VU idle -> chart show 0

  Day la ly do chart active VUs show 0 hoac 1
  cho cac case read path nhanh (rar-01, rar-03, rar-06).
```

### Misconception 5: "MaxDropped=5 la qua chat, nen tang len"

```text
SAI: "5/950 = 0.5% drop budget la qua chat. Trong production,
      CDN se retry nen khong sao"

THUC TE:
  1. maxDropped=5 la budget, khong phai target.
     Target la 0 drop (va da dat duoc).
  2. Trong test performance, dropped_iterations la tin hieu
     SOM NHAT cua capacity issue. Neu drop > 0 -> he thong
     dang gan gioi han.
  3. Khong nen "binh thuong hoa" dropped_iterations.
     Neu thay drop -> TIM ROOT CAUSE, khong phai TANG BUDGET.
  4. rar-05 co drop=20 -> tang VU pool giai quyet root cause,
     khong phai tang maxDropped.

  maxDropped nen duoc giu o muc chat che de bao dong som.
```

---

## 14. Checklist

```text
[ ] Script inspect pass: executor=ramping-arrival-rate,
    executor_family=ramping_arrival_rate,
    workload_shape=ramping_ingress_rate

[ ] Environment pre-flight pass:
    [ ] k6 version OK
    [ ] Load target health OK (http://localhost:80/health)
    [ ] Metrics server OK (http://localhost:18080/v1/capabilities)

[ ] Default run hoan thanh khong crash/error
[ ] Exit code = 0
[ ] summary_pushed = true
[ ] finish_status = 200

[ ] Thresholds pass:
    [ ] checks_rate > 0.98
    [ ] http_req_failed_rate < 0.02
    [ ] dropped_iterations <= 5
    [ ] ramping_arrival_events_failed < 20

[ ] Stage math reconcile:
    [ ] iterations ≈ scheduled_slots (within ±2)
    [ ] 120 + 480 + 330 + 20 = 950 target

[ ] Request breakdown:
    [ ] homefeed ~ 66-73% (target 70%)
    [ ] recommendations ~ 27-33% (target 30%)
    [ ] All GET / 200

[ ] Event vs HTTP reconciliation:
    [ ] api_calls = iterations = http_reqs (= 949)
    [ ] event_duration ≈ http_duration (delta < 1ms)

[ ] Little's Law validation:
    [ ] required_vus = peak_rate × event_avg ≈ 0.12
    [ ] Active VU max <= 2

[ ] Dashboard verification:
    [ ] Execution timeline matches trapezoid curve
    [ ] Active VU chart confirms < 2 VUs
    [ ] Response time chart on dinh, khong spike
    [ ] Executor tab tags match: case_id, business_case
```

---

## 15. 4-5 variations

### Variation 1: Higher peak -- tim gioi han that su

```text
MUC TIEU: Tim arrival rate toi da ma feed path co the xu ly
         voi event 4ms va 18 VUs.

CONFIG:
  $env:RAR_06_FEED_RATE = "50"  # Tang peak tu 36 len 50

DU KIEN:
  required_vus = 50 × 0.004 = 0.2 VU -> van < 1 VU
  Scheduled slots: stage 1: 120, stage 2: 20×(12+50)/2=620,
                   stage 3: 15×(50+8)/2=435, stage 4: 20
                   Total = 1195
  Du kien: 0 drop, active VU max = 1

THU NGHIEM TIEP:
  $env:RAR_06_FEED_RATE = "100"

DU KIEN:
  required_vus = 100 × 0.004 = 0.4 VU -> van < 1 VU!
  Scheduled slots: 120 + 20×(12+100)/2=1120 + 15×(100+8)/2=810 + 20 = 2070
  Du kien: 0 drop, active VU max = 1

  DEN LUC NAO MOI DROP?
  required_vus = 18 -> arrival_rate = 18/0.004 = 4500 arrivals/s!
  -> Feed path co the xu ly 4500/s voi event 4ms va 18 VUs
  -> Day la scale RAT LON cho 1 read path da duoc cache toi uu

BAI HOC: Voi read path cache-optimized, gioi han khong nam o VU
         pool size ma nam o backend saturation (DB connection,
         network bandwidth, CPU).
```

### Variation 2: Heavier response (cache miss simulation)

```text
MUC TIEU: Mo phong cache miss -> response JSON lon hon.

THAY DOI: Sua script de dung gzip_kb=20 thay vi gzip_kb=1
  (tuong duong response 20KB khong compressed)

Hoac dung env var:
  Query param gzip_kb=20 trong URL

DU KIEN:
  Event duration: ~30ms (tang tu 4ms)
    - Network transfer 20KB: ~15ms (localhost)
    - Serialization: ~10ms
    - CPU + DB: ~5ms
  required_vus = 36 × 0.030 = 1.08 VU (tang tu 0.14)
  Van < 18 VU pool -> 0 drop
  Active VU max tang tu 1 len 2-3

NEU gzip_kb = 100:
  Event duration: ~100ms
  required_vus = 36 × 0.1 = 3.6 VU
  Van < 18 VU pool -> 0 drop

NEU gzip_kb = 500:
  Event duration: ~500ms
  required_vus = 36 × 0.5 = 18 VU
  Can dung TOAN BO VU pool
  Active VU max = 18
  Co the bat dau drop neu co spike duration

BAI HOC: gzip_kb tang -> event duration tang -> VU demand tang.
         Nhung VU pool 18 du lon de chiu duoc ngay ca response
         nang gap 100x.
```

### Variation 3: Cache cold start + DB pressure

```text
MUC TIEU: Mo phong cache bi xoa (Redis restart) -> moi request
         deu hit DB.

THAY DOI: Sua query param db_rows tu 3 len 20, cpu_ms tu 1 len 10

DU KIEN:
  Event duration: ~50ms
    - CPU: 10ms
    - DB 20 rows: ~30ms (index scan + fetch)
    - Serialization + network: ~10ms
  required_vus = 36 × 0.050 = 1.8 VU
  Van < 18 VU pool -> 0 drop

NEU DB bi lock (db_rows=100, cpu_ms=50):
  Event duration: ~300ms
  required_vus = 36 × 0.3 = 10.8 VU
  Van < 18 VU pool -> 0 drop

NEU DB timeout (event duration > 500ms):
  required_vus > 18 -> bat dau drop
  -> 18 = 36 × W -> W = 0.5s
  -> Event duration > 500ms -> drop

BAI HOC: Ngay ca khi cache cold start + DB pressure, VU pool 18
         van du. Chi khi event duration > 500ms moi drop.
```

### Variation 4: Smoke test (minimal duration)

```text
MUC TIEU: Chay nhanh de verify script khong bi loi truoc khi
         chay full test.

CONFIG:
  $env:RAR_06_DURATION_SCALE = "0.1"  # Scale 10%

DU KIEN:
  Stage durations: 1.5s, 2s, 1.5s, 0.5s (thay vi 15s, 20s, 15s, 5s)
  Scheduled slots: 12 + 48 + 33 + 2 = 95
  Thoi gian chay: ~5.5s
  Van du de verify script chay dung, khong co loi syntax,
  threshold pass.

SU DUNG: CI/CD pipeline, pre-commit hook, verify sau khi sua script.
```

### Variation 5: Personalized vs Non-personalized A/B test

```text
MUC TIEU: So sanh performance giua personalized feed (personalized=1)
         va non-personalized feed (personalized=0).

THAY DOI: Chay 2 lan rieng biet voi personalized=1 va personalized=0.
  So sanh event duration giua 2 lan chay.

DU KIEN:
  personalized=1 (default):
    - cpu_ms=1, db_rows=3
    - Event p95 = 4ms

  personalized=0 (non-personalized):
    - Bo qua personalized query -> cpu_ms co the thap hon
    - db_rows co the it hon (generic feed, khong can user-specific)
    - Event p95 co the < 4ms (nhanh hon)

  Neu personalized cham hon dang ke (> 2x):
    -> Can toi uu personalized query (cache per-user, pre-compute)
    -> Hoac gioi han so luong user duoc personalized (top-N active)
```

---

## 16. Anti-patterns

### Anti-pattern 1: Over-provisioning VUs cho fast read path

```text
SAI: "36/s la peak cao -> can nhieu VUs. Dat preAllocatedVUs=100."

THUC TE: Little's Law cho biet chi can < 1 VU.
  Dat preAllocatedVUs=100 la PHI PHAM 99% capacity.
  VU la tai nguyen ton kem (memory, CPU, connection pool).
  Over-provisioning VU khong giup test chay "nhanh hon"
    (arrival rate da co dinh).
  Over-provisioning VU chi lam KHO doc ket qua hon
    (vus_max=100 nhung thuc te chi dung 1).

BEST PRACTICE:
  Tinh required_vus = peak_rate × event_p95
  Dat preAllocatedVUs = required_vus × 2 (margin)
  Dat maxVUs = required_vus × 10 (safety)
  Neu drop -> tang preAllocatedVUs, KHONG tang maxVUs
```

### Anti-pattern 2: Confusing peak rate voi VU requirement

```text
SAI: "rar-05 peak 8/s, rar-06 peak 36/s -> rar-06 phai can
      nhieu VU gap 4.5x rar-05."

THUC TE: rar-06 can IT HON rar-05 gap ~500x.
  VU requirement = λ × W (Little's Law).
  λ rar-06 gap 4.5x rar-05 (36 vs 8).
  Nhung W rar-05 gap 2252x rar-06 (9010ms vs 4ms).
  4.5 × 1/2252 = 0.002 -> rar-06 can 0.2% VU cua rar-05.

  Luon tinh CA λ VA W truoc khi quyet dinh VU pool size.
```

### Anti-pattern 3: Bo qua event duration metric

```text
SAI: "Chi can xem http_req_duration la du."

THUC TE: Event duration = HTTP time + JS processing + sleep/wait.
  Trong rar-06: delta gan nhu 0 (event=4ms, http=3.89ms).
  Nhung trong rar-05: event=9010ms, http=8510ms.
  Delta = 500ms (JS processing + sleep).
  Neu chi xem http_req_duration -> bo qua 500ms VU idle time.

  Event duration quan trong hon http_req_duration
  de tinh VU demand (Little's Law).
```

### Anti-pattern 4: Khong kiem tra breakdown theo operation

```text
SAI: "Event p95 overall = 4ms -> tat ca deu tot."

THUC TE: 4ms la CONG GOM cua 2 branches (homefeed 70%,
  recommendations 30%). Neu homefeed 2ms va recommendations 50ms:
    p95 overall = ~3.5ms (vi p95 bi anh huong boi 95th percentile
    cua toan bo distribution, trong do homefeed chiem 70%).

  NHUNG recommendations van cham (50ms) va co the tao VU pressure
  neu arrival rate du lon.

  Luon breakdown theo operation de tim root cause.
```

### Anti-pattern 5: Tang maxDropped thay vi giai quyet root cause

```text
SAI: "Dropped=5, maxDropped=5 -> treo leo. Tang maxDropped=50
      -> test pass."

THUC TE: Tang maxDropped la CHE GIAU van de, khong giai quyet.
  Neu dropped_iterations > 0 -> he thong dang thieu capacity.
  Giai phap dung:
    1. Tang preAllocatedVUs hoac maxVUs
    2. Giam event duration (optimize sleep, multi-call)
    3. Tach scenario rieng cho slow operations
    4. Chap nhan drop budget co ly do (business decision,
       khong phai cheat)
```

---

## 17. Real validation data

### Run data from validation session (2026-06-21)

```text
Run ID: #105
Script: rar-06-cache-feed-wave.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Summary metrics

| Metric | Value | Expected | Match |
| --- | ---: | ---: | --- |
| `iterations` | 949 | ~950 | ✅ within ±1 |
| `checks_rate` | 1 | > 0.98 | ✅ |
| `checks_passes/fails` | 949 / 0 | | ✅ |
| `http_req_failed_rate` | 0 | < 0.02 | ✅ |
| `dropped_iterations` | 0 | <= 5 | ✅ |
| `ramping_arrival_events_failed_rate` | 0 | | ✅ |
| `http_reqs` | 949 | = iterations | ✅ |
| `vus_max` | 1 | | Reference |
| `event_duration avg/med/p95/p99/max` | 3.28 / 3 / 5 / 5 / 8 ms | | Reference |
| `http_req_duration avg/med/p95/p99/max` | 3.16 / 3.09 / 4.35 / 5.29 / 8.20 ms | | Reference |

### Request breakdown

```text
feed_wave_homefeed GET 200 count=679 (71.5%)   target=70% ✅
feed_wave_recommendations GET 200 count=270 (28.5%) target=30% ✅
```

### Dashboard series check

```text
iterations: points=54, sum=949, min=2, max=36, truncated=false
http_reqs: points=949, sum=949, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus: points=53, min=0, max=1, truncated=false
```

### Stage math reconciliation

| Stage | Duration | Rate range | Area formula | Slots | Observed | Match |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| 1 normal feed | 15s | 4->12/s | 15×(4+12)/2 | 120 | | |
| 2 feed peak | 20s | 12->36/s | 20×(12+36)/2 | 480 | | |
| 3 recovery | 15s | 36->8/s | 15×(36+8)/2 | 330 | | |
| 4 drain | 5s | 8->0/s | 5×(8+0)/2 | 20 | | |
| **Total** | **55s** | | | **950** | **949** | ✅ ±1 |

### Verdict

```text
PASS — default ramping-arrival-rate case giu duoc arrival curve:
checks sach, HTTP failed 0%, dropped_iterations=0.
Peak 36/s (cao nhat series) nhung active VU max=1 (thap nhat series).
Little's Law confirmed: required_vus = 36 × 0.004 = 0.144 → 1 VU.
```

---

## Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Validation & chart analysis: `./08_validation-and-chart-analysis.md` (rar-06 section)
- Source script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-06-cache-feed-wave.js`
- Common utilities: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
- Gold standard doc: `../constant-arrival-rate/01_storefront-rps-contract.md`
- Little's Law reference: `L = λ × W` (John Little, 1961)
- Adjacent case (for contrast): `./05_report-job-ingress-ramp.md` (low peak, high VU, dropped)
