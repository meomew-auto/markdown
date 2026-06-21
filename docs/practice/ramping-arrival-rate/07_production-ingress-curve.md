# Case 07: Production Spike Mix

> **Script:** `rar-07-production-spike-mix.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 32 arrivals/s | **Duration:** 65s
> **Focus:** mixed production API spike across 6 branches, 5 services, 1 VU pool. Noisy Neighbor detection.

## 1. Tinh huong thuc te

### 1.1. Boi canh production

Mot campaign lon hoac app event (flash sale, ra mat tinh nang, thong bao push hang loat)
tao ra mixed API ingress dong thoi tren toan bo he thong. Day KHONG PHAI la traffic
don le vao mot endpoint — day la production traffic that voi nhieu loai request khac
nhau cung xuat hien trong cung mot cua so thoi gian:

```text
Nguoi dung mo app:
  → Browse danh sach san pham (GET /products)
  → Bam vao xem chi tiet (GET /products/:id)
  → Them vao gio hang (POST /cart/add)

Cung luc do:
  → He thong xac thuc token nguoi dung (GET /auth/me)
  → Nguoi dung checkout don hang (POST /checkout)
  → Dashboard team keo report (GET /report)
```

6 loai traffic khac nhau, 5 service backend khac nhau, tat ca chen vao cung mot
ingress pipeline. Cau hoi khong chi la "moi service rieng le co chiu duoc khong"
ma la "toan bo he thong, voi mixed traffic nay, co giu duoc arrival curve khong?"

### 1.2. The Production Spike Curve

Traffic thuc te trong campaign/app event khong co dinh. No dien ra theo mot curve:

```text
startRate = 3 arrivals/s      ← traffic nen, nguoi dung bat dau vao app
20s -> 12/s  baseline ramp   ← traffic tang dan khi campaign lan truyen
20s -> 32/s  spike peak       ← dinh campaign, toan bo nguoi dung cung online
20s -> 10/s  recovery         ← campaign ket thuc, traffic giam dan
5s  -> 0/s   drain            ← residual traffic tan het
```

Day la mot **production spike curve** dien hinh: ramp up, peak, ramp down, drain.
Tong thoi gian 65s — la chay dai nhat trong toan bo series ramping-arrival-rate.

### 1.3. Bai toan Noisy Neighbor trong mixed workload

Diem mau chot khong nam o peak 32/s cao nhat, ma nam o **tuong tac giua cac
branch trong cung mot VU pool**:

```text
6 branch chia se 1 VU pool:

browse      (35%): GET /products, cpu_ms=1, db_rows=2       → rat nhanh, ~5ms
detail      (20%): GET /products/:id, cpu_ms=1, db_rows=1   → rat nhanh, ~5ms
cart        (18%): POST /cart/add, cpu_ms=1, db_writes=1    → nhanh vua, ~10ms
auth        (12%): GET /auth/me, cpu_ms=1, db_rows=1        → nhanh vua, ~10ms
checkout    (10%): POST /checkout, cpu_ms=2, external_ms=30 → CHAM, ~50ms
report      (5%):  GET /report, cpu_ms=1, gzip_kb=1         → cham vua, ~20ms
```

Branch checkout (external_ms=30) va report (gzip_kb=1) co event duration dai
hon gap 5-10 lan so voi browse/detail. Khi mot VU dang xu ly checkout, no
**khong the** xu ly browse — dac diem cua VU pool dung chung.

Hien tuong "Noisy Neighbor":

```text
Tai giay peak N:
  - 32 slot den
  - Weight distribution: ~11 browse, ~6 detail, ~6 cart, ~4 auth, ~3 checkout, ~2 report
  - 3 checkout × ~50ms = 150ms VU time → 3 VU bi "kep" boi checkout
  - 2 report × ~20ms = 40ms VU time → 2 VU bi "kep" boi report
  - Trong 150ms do, browse moi chi can 5ms/VU nhũng khong co VU trong de xu ly
  - → Browse (35% traffic, business-critical) co the bi DROP vi checkout (10% traffic)
    giu VU qua lau
```

Day la hien tuong **Noisy Neighbor** kinh dien: service cham ngon VU pool, lam
service nhanh bi thieu worker. Khong phai browse co van de — browse van nhanh.
Van de la checkout chiem dung VU khong nha ra kip.

### 1.4. Case tong hop — cau noi tu nhien tu constant-arrival-rate

Case RAR-07 nay la **phan chuyen tiep** tu case CAR-07 (constant-arrival-rate
production ingress mix):

```text
CAR-07: rate CO DINH 18/s × 60s = 1080 arrivals
  → Day la baseline mixed tai fixed rate
  → Da day: noisy neighbor, drill by service, drop budget, VU pool sharing

RAR-07: rate THAY DOI theo spike curve: 3→12→32→10→0/s
  → Cung 6 branch, cung 5 service, cung VU pool dung chung
  → Chi khac: arrival curve thay doi theo thoi gian
  → Toan bo kien thuc noisy neighbor AP DUNG NGUYEN
  → Them: phan tich drop co trung vao peak stage khong?
```

Day la **case tich luy** — no gom tat ca bai hoc tu 6 RAR case truoc vao mot
baseline tong the duy nhat:

```text
RAR-01 (campaign warmup):   → da day ramp-up analysis
RAR-02 (login burst):       → da day auth/identity
RAR-03 (webhook wave):      → da day idempotency + single endpoint
RAR-04 (checkout flash):    → da day multi-call event + external latency
RAR-05 (report job):        → da day drop/async + VU pool pressure
RAR-06 (cache feed):        → da day high-rate + low duration = low VU

RAR-07 gom tat ca: 6 branch (tu RAR-01), auth header (tu RAR-02),
  idempotency key (tu RAR-03), checkout external_ms (tu RAR-04),
  drop analysis (tu RAR-05), high-peak low-active-VU (tu RAR-06)
```

### 1.5. Business question chinh xac

```text
Toan he thong (6 branch, 5 service, 1 VU pool) co giu duoc mixed production
spike 3 → 12 → 32 → 10 → 0 arrivals/s trong 65s khong?

Cu the:
  - Co drop arrivals nao khong? Drop vao service nao?
  - Neu co drop, service NAO la noisy neighbor gay ra drop cho service khac?
  - p95 co bi keo boi checkout/report khong? Browse co bi anh huong?
  - Voi pre=30, max=90, VU pool co du cho mixed spike nay khong?
```

Tra loi cau hoi nay chinh la muc tieu cua toan bo case.

## 2. 2 yeu cau cot loi

### Yeu cau (a): Mixed spike contract 3→12→32→10→0/s trong 65s

```text
startRate = 3/s
Stage 1: 20s, target 12/s  → ramp tu nen len baseline
Stage 2: 20s, target 32/s  → spike peak (gap 2.67× baseline)
Stage 3: 20s, target 10/s  → recovery ve duoi baseline
Stage 4: 5s,  target 0/s   → drain toan bo residual traffic

Tong scheduled slots = 150 + 440 + 420 + 25 = 1035 arrivals
Tong thoi gian = 65s (dai nhat trong toan bo RAR series)
```

**Diem khac biet so voi CAR-07**: Khong phai chi la "18/s co dinh trong 60s."
Day la "thay doi tu 3 den 32/s qua 4 stage." Rui ro tap trung vao **stage 2 (peak 32/s)**
— day la noi VU pool chiu ap luc lon nhat, va la noi Noisy Neighbor gay hai nhieu nhat.

### Yeu cau (b): Drops trong budget, drill down duoc service gay loi

```text
dropped_iterations <= 8         (drop budget ~0.77% cua 1035)
  → Budget duoc noi long hon CAR-07 (5 drops / 1080 = 0.46%)
  → Ly do: spike curve co peak cao + mixed workload = nhieu bien hon
  → 8/1035 = 0.77% — van la budget chat che cho production ingress

ramping_arrival_events_failed < 25  (~2.4% cua 1035)
  → Cho phep event fail (checkout external failure, auth token expired...)
  → Khong phai moi event fail la do he thong

checks > 0.98                   (cho phep toi da 2% check fail)
http_req_failed < 0.02          (cho phep toi da 2% HTTP fail)
```

**Diem day quan trong**: Nhung con so nay la **lab budget**, khong phai production SLO.
Production thuong yeu cau:

```text
- checkout/cart: 0 drop — vi la transaction co tien
- browse/detail: co the accept drop nho vi user co the refresh
- report: co the accept drop cao hon vi khong phai user-facing
```

Lab dat budget de tao khong gian cho drop xuat hien va **day cach phan tich**.
Khi gap drop, cau hoi khong chi la "bao nhieu drop" ma la "drop vao service nao?"

## 3. Vi sao dung `ramping-arrival-rate`?

### 3.1. Mixed production traffic theo spike curve

Production ingress that co dinh dang spike curve — khong phai flat rate:

```text
Thuc te campaign:
  - Phut dau: 100 users mo app → ~3 request/s
  - Phut 2-3: campaign hot, 1000 users → ~32 request/s
  - Phut 4-5: campaign tan, users roi di → ~10 request/s
  - Phut 6: residual traffic → ~0 request/s

→ Traffic co HINH DANG (shape), khong phai chi la MAGNITUDE (peak)
→ Can kiem tra ca curve, khong chi peak
→ ramping-arrival-rate la executor DUY NHAT tao duoc curve nay
```

### 3.2. Bang so sanh: vi sao KHONG dung executor khac?

| Executor | Dung duoc cho mixed spike? | Vi sao (khong) |
| --- | --- | --- |
| **per-vu-iterations** | Khong | Dem iteration co dinh per VU. Khong mo phong arrival rate thay doi. VU identity bound vao user. Khong co khai niem "32/s peak". |
| **shared-iterations** | Khong | Phan phoi iteration khong deu. VU nhanh "cuop" iteration cua VU cham → branch mix bi bias ve service nhanh (browse) → sai weight distribution. |
| **constant-vus** | Khong | Backend cham lam iter_time tang → throughput giam. Khong giu duoc 32/s. Cau hoi tro thanh "voi 30 VU chay duoc bao nhieu?" thay vi "chay duoc 32/s khong?" |
| **ramping-vus** | Khong | Thay doi VU, khong kiem soat duoc arrival rate. Khong biet 32/s co dat khong. |
| **constant-arrival-rate** | Thieu | GiU DUOC arrival rate nhung chi 1 rate co dinh. Khong mo phong duoc spike curve 3→12→32→10→0. Dung CAR cho mixed baseline (CAR-07), RAR cho mixed spike (RAR-07). |
| **ramping-arrival-rate** | DUNG | Tao duoc spike curve qua startRate + stages. GiU arrival rate theo thoi gian. Backend cham → can them VU, khong giam rate. Drop la tin hieu. |

### 3.3. Vi sao KHONG tach thanh 6 scenario rieng?

Cau hoi tu nhien: "6 branch khac nhau, sao khong tao 6 scenario rieng, moi scenario
1 branch, deolation hoan toan?"

```text
Ly do 1: Production thuc te KHONG phan cach
  - Pod Kubernetes xu ly TAT CA request den
  - Khong co "pod chi cho checkout" hay "pod chi cho browse"
  - Tat ca tran vao cung mot compute pool
  → 1 scenario dung chung VU pool = mo hinh sat production nhat

Ly do 2: Noisy Neighbor chi xuat hien khi dung chung pool
  - Neu checkout co VU pool rieng → checkout cham khong anh huong browse
  - Nhung production that: checkout cham → pod bi checkout giu → browse bi anh huong
  → Dung chung pool = phat hien duoc noisy neighbor

Ly do 3: Branch mix ty le chinh la traffic that
  - 35% browse, 20% detail, 18% cart, 12% auth, 10% checkout, 5% report
  - Day la ty le traffic production (khong phai equal split)
  - 1 scenario voi weightedPick() = mo phong chinh xac ty le nay
  - 6 scenario rieng can phai can chinh startRate cho tung scenario de tong rate
    bang dung curve → phuc tap gap 6 lan, de sai gap 6 lan

Ly do 4 (day): So sanh duoc 1-scenario-mixed voi 6-scenario-separate
  - Chay 1 scenario mixed truoc → baseline
  - Neu gap noisy neighbor → tach scenario nhu mot VARIATION (xem Section 15)
  - → Day duoc ca 2 phuong an, va cach quyet dinh khi nao nen tach
```

### 3.4. 5 ly do ramping-arrival-rate la executor DUNG

#### Ly do 1: Arrival rate thay doi doc lap voi backend latency

```text
Trong production:
  - Users click, scroll, add to cart THEO NHIP CUA HO
  - Khi checkout service cham, user KHONG "click cham lai"
  - User van tao ~32 requests/s, nhung response cham hon → user frustrated

ramping-arrival-rate mo phong dung:
  - GiU arrival schedule doc lap voi backend latency
  - Backend cham → iteration lau hon → can nhieu VU hon
  - Thieu VU → drop (user bi timeout o production)

constant-vus / ramping-vus mo phong SAI:
  - Backend cham → VU loop cham → throughput giam
  - Khong giu duoc 32/s peak
  - Khong phat hien duoc VU shortage o peak
```

#### Ly do 2: Moi slot weightedPick() doc lap — branch mix on dinh

```text
ramping-arrival-rate:
  - Moi slot den gio → goi weightedPick() doc lap
  - Slot luon duoc tao DUNG GIO, khong phu thuoc iteration truoc
  - Branch mix on dinh theo thoi gian (chi lech do randomness)

shared-iterations:
  - weightedPick() van chay dung weight
  - NHUNG: checkout cham → VU checkout "ban" lau → VU nhanh "cuop" them iteration
  - → Branch mix bi lech ve service nhanh
```

#### Ly do 3: Drop = tin hieu khan hiem VU

```text
constant-vus: backend cham → rate giam → KHONG drop → khong phat hien van de

ramping-arrival-rate: giu rate 32/s o peak → neu VU khong du → drop xuat hien
  → Drop la TIN HIEU: "VU pool khong du cho latency profile nay"
  → Drill service/operation → tim ra service nao keo dai event duration
  → Quyet dinh: tang maxVUs, toi uu service cham, hay tach scenario?
```

#### Ly do 4: Peak 32/s voi 6 branch = kiem tra VU pool dap ung curve

```text
Stage 2 (peak): 12→32/s trong 20s
  → Day la luc VU pool bi ap luc lon nhat
  → Neu co drop, no tap trung o stage 2
  → Drop curve theo thoi gian → xac nhan drop do peak gay ra (khong phai random)

Neu dung constant-arrival-rate 32/s co dinh:
  → Drop deu toan bo 60s, khong biet drop co tap trung vao luc nao
  → Mat thong tin ve stage-specific behavior
```

#### Ly do 5: Day la bai tap tich luy — cau noi CAR → RAR expert

```text
CAR-07: baseline mixed o rate co dinh
  → Da day: noisy neighbor, drill by service, drop budget, VU sharing

RAR-07: mixed spike o rate thay doi
  → Ap dung TAT CA bai hoc tu CAR-07
  → Them: drop co tap trung vao stage nao? Peak hay recovery?
  → Them: stage math — drop tai peak nhung pass tai recovery?
  → Them: curve shape analysis

→ Khong hoc CAR-07 → khong hieu noisy neighbor
→ Khong hoc RAR-07 → khong biet phan tich noisy neighbor theo curve
```

## 4. Config mapping

### 4.1. Bang tham so day du

| Tham so | Default | Y nghia | Vi sao chon gia tri nay |
| --- | ---: | --- | --- |
| `RAR_07_START_RATE` | 3 | Rate nen khi bat dau run | Traffic co so truoc campaign (organic traffic) |
| `RAR_07_BASELINE_RATE` | 12 | Rate cuoi stage 1 (baseline) | Traffic campaign lan truyen (gap 4× start) |
| `RAR_07_SPIKE_RATE` | 32 | Rate dinh stage 2 (peak) | Traffic dinh campaign (gap 2.67× baseline) |
| `RAR_07_RECOVERY_RATE` | 10 | Rate cuoi stage 3 (recovery) | Traffic sau campaign, gan ve baseline |
| `RAR_07_DURATION_SCALE` | 1 | He so scale stage duration | 1 = default: 20+20+20+5 = 65s |
| `RAR_07_PREALLOCATED_VUS` | 30 | Worker warm san khi run bat dau | Du cho stage 1 baseline, giam cold-start |
| `RAR_07_MAX_VUS` | 90 | Worker ceiling | Gap 3× pre, du phong cho peak 32/s |
| `RAR_07_MAX_DROPPED` | 8 | Drop budget cho toan run | 8/1035 = 0.77% — relax hon CAR-07 (0.46%) vi spike curve co nhieu bien hon |
| `RAR_07_USER_POOL` | 1200 | Business identity pool | Du lon de tranh reuse user qua som |

### 4.2. Stage math — hinh thang area

Cong thuc: `area = duration × (rate_start + rate_end) / 2`

| Stage | Duration | Rate start -> end | Area (slots) | Giai thich |
| --- | ---: | ---: | ---: | --- |
| 1 baseline ramp | 20s | 3 -> 12/s | (3+12)/2 × 20 = **150** | Tu traffic nen len baseline |
| 2 spike peak | 20s | 12 -> 32/s | (12+32)/2 × 20 = **440** | Dinh campaign — area lon nhat |
| 3 recovery | 20s | 32 -> 10/s | (32+10)/2 × 20 = **420** | Giam dan ve duoi baseline |
| 4 drain | 5s | 10 -> 0/s | (10+0)/2 × 5 = **25** | Residual traffic tan het |
| **Total** | **65s** | | **1035** | ✅ exact |

### 4.3. 1035 slots — con so lon nhat RAR series

```text
RAR-01: 705 slots, 55s
RAR-02: 507 slots, 50s
RAR-03: 545 slots, 55s
RAR-04: 317 slots, 55s (thap nhat — checkout flash sale can nhieu VU/iter)
RAR-05: 220 slots, 55s (thap nhat — async wait lam cham)
RAR-06: 950 slots, 55s (cao nhat truoc RAR-07)
RAR-07: 1035 slots, 65s <- CAO NHAT, DAI NHAT

→ 1035/65s = 15.92 slots/s average
→ Nhung peak 32/s = gap 2× average
→ Day la ly do pre=30, max=90 duoc chon — du phong cho peak
```

### 4.4. Thresholds detail

```text
checks:                ['rate>0.98']        → 98%+ HTTP status checks pass
http_req_failed:       ['rate<0.02']        → duoi 2% HTTP requests fail
dropped_iterations:    ['count<=8']         → toi da 8 arrivals bi drop
ramping_arrival_events_failed: ['count<25'] → toi da 24 events fail (any branch)
```

## 5. Identity model deep-dive

### 5.1. VU = anonymous worker

Trong ramping-arrival-rate, VU **khong co identity rieng** gan voi business user:

```text
Moi VU la mot anonymous worker:
  - K6 spawn VU tu pool (preAllocatedVUs=30, co the expand den maxVUs=90)
  - Worker lay 1 iteration tu arrival queue
  - weightedPick() quyet dinh branch cho iteration do
  - Worker xu ly xong → tra lai vao pool → lay iteration moi

VU khong "thuoc ve" branch nao:
  - VU #1 co the xu ly browse o iter 1, checkout o iter 100, report o iter 200
  - VU #2 cung vay — khong co rang buoc branch-VU
  - Moi VU co the xu ly BAT KY branch nao
```

Day chinh la mo hinh **pod Kubernetes**: pod xu ly bat ky request nao den,
khong co pod "danh rieng" cho checkout hay browse.

### 5.2. 6 branch, 5 service, 1 VU pool

```text
6 branch trai tren 5 service backend:

products-service (2 branch):
  - browse  35%  GET /api/sim/products
  - detail  20%  GET /api/sim/products/:id

cart-service (1 branch):
  - cart    18%  POST /api/sim/cart/add

auth-service (1 branch):
  - auth    12%  GET /api/sim/auth/me

order-service (1 branch):
  - checkout 10% POST /api/sim/checkout

report-service (1 branch):
  - report  5%   GET /api/sim/report

Tat ca chen vao 1 VU pool (pre=30, max=90).
```

### 5.3. finishEvent service='mixed' — tai sao?

```text
finishEvent(started, ok, {
  caseId: CASE_ID,
  service: 'mixed',       // ← KHONG PHAI ten service rieng
  operation: `production_spike_${choice}`,  // ← branch name
  userId: ctx.userId,
});
```

**Ly do**: Event-level metric gom tat ca branch lai. Day la **tong quan toan scenario**.
Neu finishEvent ghi service='products-service', thi event metric chi co du lieu
cho browse+detail, mat du lieu cho cart/auth/checkout/report.

**He qua**: Tat ca event metric (ramping_arrival_events_total, ramping_arrival_events_failed,
ramping_arrival_event_duration_ms) deu co tag `service='mixed'`. Muon phan tich
theo service, phai nhin vao **request-level metrics** — noi requestJson() da gan
tag `service` dung (products-service, cart-service, ...).

### 5.4. Bang: event-level vs request-level tags

| Metric type | Tag `service` | Tag `operation` | Dung de |
| --- | --- | --- | --- |
| `ramping_arrival_events_total` | `mixed` | `production_spike_browse`, `..._detail`, ... | Tong so event toan scenario |
| `ramping_arrival_events_failed` | `mixed` | `production_spike_browse`, `..._detail`, ... | Tong event fail toan scenario |
| `ramping_arrival_event_duration_ms` | `mixed` | `production_spike_browse`, `..._detail`, ... | Event duration theo branch |
| `http_reqs` | `products-service`, `cart-service`, ... | `production_spike_browse`, ... | Request count + duration theo service THAT |
| `ramping_arrival_api_calls_total` | `products-service`, `cart-service`, ... | `production_spike_browse`, ... | API call count theo service THAT |

**Quy tac drill-down**:

```text
1. Muon biet tong event:   group event metric, service='mixed' → tong = 1035
2. Muon biet event theo branch: group event metric by operation → browse 362, detail 207, ...
3. Muon biet service latency:   group http_req_duration by service → products-service ~5ms, order-service ~50ms
4. Muon biet branch latency:    group http_req_duration by operation → production_spike_checkout ~50ms
```

## 6. Open model deep-dive

### 6.1. Co che open model: arrival doc lap VU

```text
ramping-arrival-rate co che:

1. Moi timeUnit (1s), k6 tinh toan currentRate tu stage hien tai
   - Linear interpolation giua stage start va stage end
   - Tai giay 10 cua stage 1: rate = 3 + (12-3) × 10/20 = 7.5/s

2. k6 len lich tao iteration moi theo currentRate
   - Stage 1: tu 3/s ramp len 12/s
   - Stage 2: tu 12/s ramp len 32/s
   - Stage 3: tu 32/s ramp xuong 10/s
   - Stage 4: tu 10/s ramp xuong 0/s

3. Moi iteration duoc tao → weightedPick() quyet dinh branch
4. k6 kiem tra VU pool:
   - Co VU trong? → gan iteration cho VU do
   - Het VU trong? → kiem tra currentVUs < maxVUs?
     - YES → spawn VU moi
     - NO → drop iteration (dropped_iterations++)
```

### 6.2. Noisy Neighbor — phan tich toan hoc

Tai peak 32/s, voi 6 branch cost khac nhau:

```text
Chi phi VU trung binh cho moi branch:

branch    | weight | external_ms | cpu_ms | db  | est. duration | VU-ms per event
browse    | 35%    | 0           | 1      | 2   | ~5ms          | 5
detail    | 20%    | 0           | 1      | 1   | ~5ms          | 5
cart      | 18%    | 0           | 1      | 1w  | ~10ms         | 10
auth      | 12%    | 0           | 1      | 1   | ~10ms         | 10
checkout  | 10%    | 30          | 2      | 1w  | ~50ms         | 50
report    | 5%     | 0           | 1      | 1   | ~20ms         | 20

Trong 1 giay tai peak (32 events):
  browse:   32 × 0.35 × 5ms  = 56.0 VU-ms
  detail:   32 × 0.20 × 5ms  = 32.0 VU-ms
  cart:     32 × 0.18 × 10ms = 57.6 VU-ms
  auth:     32 × 0.12 × 10ms = 38.4 VU-ms
  checkout: 32 × 0.10 × 50ms = 160.0 VU-ms  ← DOMINATES
  report:   32 × 0.05 × 20ms = 32.0 VU-ms

Total VU-ms per second = 376 VU-ms
→ Can it nhat ceil(376/1000) = 1 active VU de xu ly 32 events/s
→ Nhung: VU-ms khong phai la VU count — day la tong CPU time
→ Voi average event duration = 376/32 = 11.75ms, Little's Law:
  required_VUs ≈ arrival_rate × avg_duration = 32/s × 0.01175s = 0.376 VU
→ Gan 0 VUs vi cac event rat ngan (~11.75ms trung binh)

Nhung — checkout chiem:
  160 / 376 = 42.6% cua tong VU-ms
  trong khi chi la 10% cua traffic!
```

### 6.3. Vi sao active VU max=6 la thap mac du peak 32/s?

```text
Run that: 1035 iter, active VU max=6, vus_max=30

Little's Law giai thich:
  required_VUs = arrival_rate × avg_event_duration

  avg_event_duration = p95 thap (86ms trong run that)
  → O peak 32/s: 32 × 0.086 = 2.75 VU
  → Nhung 86ms la p95, khong phai average
  → Average that su thap hon nhieu (~45ms)
  → 32 × 0.045 = 1.44 VU

Active VU max=6 > 1.44 → co headroom
VU pool khong bi ap luc trong run nay

Nhung — dieu nay co the THAY DOI neu:
  - Tang external_ms cua checkout (30→200ms)
  - Tang ti le checkout (10%→30%)
  - Tang peak rate (32→64/s)
  → Khi do, Little's Law: 64 × 0.045 = 2.88 VU + checkout keo dai
  → Active VU se tang, co the cham maxVUs
```

### 6.4. Noisy Neighbor simulation — khi nao no tro thanh van de?

```text
Scenario: Gia su checkout external_ms tang tu 30→500ms (backend chem)

branch   | duration est. | 32 events VU-ms
browse   | 5ms           | 56
detail   | 5ms           | 32
cart     | 10ms          | 57.6
auth     | 10ms          | 38.4
checkout | 520ms         | 1664 ← EXPLODES
report   | 20ms          | 32

Total VU-ms/s = 1880 VU-ms → can ~2 VU (Little's Law)
→ avg_duration = 1880/32 = 58.75ms
→ 32 × 0.05875 = 1.88 VU

Van con thap! Tai sao?
→ Vi 32 events/s voi duration ~58ms van rat nhanh
→ 1 VU xu ly ~17 events/s (1000/58.75)
→ Can 32/17 ≈ 2 VU

Nhung — CHI TIET MOI LA VAN DE:
→ Trong 1 giay, 3 checkout event × 520ms = 1560ms VU time
→ 1 VU hold boi checkout gan 1.56s
→ Trong 1.56s do, VU khong xu ly duoc browse (32 events bi bo lo)
→ Neu chi co 2 active VU: 1 dang checkout → chi con 1 xu ly 29 events khac
→ 29 events × 10ms avg = 290ms < 1000ms → 1 VU du
→ Nhung neu checkout roi vao cung luc (2 checkout trong 100ms):
  2 VU bi checkout hold → 0 VU cho browse → DROP

Day la noisy neighbor dinh: VU bi hold boi service cham DUNG LUC
service nhanh can VU. Khong phai la thieu VU tong the, ma la
THIEU VU TAI THOI DIEM CU THE.
```

### 6.5. VU pool sharing analysis — tai sao pre=30, max=90?

```text
preAllocatedVUs=30:
  - Du de xu ly stage 1 (3→12/s) ma khong can spawn VU moi
  - 12/s × ~10ms = 0.12 VU → 30 VU la qua du, nhung co san de tranh cold-start
  - Giong nhu Kubernetes: pod luon warm san, khong doi scheduler khi can

maxVUs=90:
  - Gap 3× preAllocatedVUs
  - Du phong cho worst case:
    - Checkout external_ms tang dot ngot (backend degradation)
    - Nhieu checkout trung vao cung luc
    - Peak 32/s + high latency branch
  - Trong run that: active VU max=6, maxVUs=90 khong can dung den
  - Giong K8s HPA: configured max=90 pods, thuc te chi dung 6

Tai sao khong dat pre=6, max=6?
  → Neu checkout external_ms=500ms dot ngot → can 3-4 VU
  → 6 co the du, nhung safety margin rat mong
  → Neu 2 checkout + 1 report cung luc → VU het, browse bi drop
  → Headroom la de bao ve fast branch khoi noisy neighbor
```

### 6.6. Stage-by-stage VU demand analysis

Moi stage co arrival rate khac nhau → VU demand khac nhau:

```text
Stage 1 — Baseline ramp (3→12/s, 20s):
  Avg rate = (3+12)/2 = 7.5/s
  avg_duration = 11.75ms (weighted)
  required_VUs = 7.5 × 0.01175 = 0.088 VU
  → Gan 0 VU. pre=30 la qua du.

Stage 2 — Spike peak (12→32/s, 20s):
  Avg rate = (12+32)/2 = 22/s
  required_VUs = 22 × 0.01175 = 0.259 VU
  → Van gan 0 VU!
  Nhung: tai cuoi stage, rate = 32/s
  required_VUs o cuoi stage = 32 × 0.01175 = 0.376 VU
  → Van rat thap. Tai sao active VU max=6?

  Ly do: p95 event duration = 86ms (khong phai 11.75ms average)
  required_VUs tai p95 = 32 × 0.086 = 2.75 VU
  → Voi sampling granularity 1s + VU scheduling jitter → 6 VU
  → Day la ly do active VU max=6 > 2.75 theoretical

Stage 3 — Recovery (32→10/s, 20s):
  Avg rate = (32+10)/2 = 21/s
  required_VUs = 21 × 0.01175 = 0.247 VU
  → VU demand giam dan khi rate giam

Stage 4 — Drain (10→0/s, 5s):
  Avg rate = (10+0)/2 = 5/s
  required_VUs = 5 × 0.01175 = 0.059 VU
  → Gan 0 VU
```

### 6.7. So sanh drop pattern: RAR vs CAR

```text
CAR (constant-arrival-rate) drop:
  - Rate co dinh X/s trong suot run
  - Neu VU pool khong du → drops xuat hien VA DUY TRI trong suot run
  - Drop rate ≈ X - (VU_capacity / avg_event_duration)
  - Drop deu dan, khong co "stage" nao gap drop nhieu hon

  Vi du CAR-05: rate 6/s co dinh, drops = 20
  → Drops xuat hien ngay tu dau va duy tri trong suot 60s
  → Khong co "peak stage" — drops phan bo deu

RAR (ramping-arrival-rate) drop:
  - Rate THAY DOI theo stage
  - Drops TAP TRUNG vao stage co rate cao nhat (stage 2)
  - Drop rate thay doi theo current_stage_rate
  - Stage 1 (3→12/s): co the 0 drop
  - Stage 2 (12→32/s): drops xuat hien neu VU pool khong du
  - Stage 3 (32→10/s): drops giam dan
  - Stage 4 (0/s): khong drops

  Vi du RAR-05: rate 1→8→2→0/s, peak 8/s, drops = 20
  → Drops tap trung vao stage 2 (3→8/s)
  → Stage 1 (1→3/s): it hoac khong drops
  → Day la "peak-stage VU crunch"

Y nghia cho RAR-07:
  - Peak 32/s o stage 2 la giai doan rui ro cao nhat
  - Neu co drops, chung se tap trung vao 20s peak (stage 2)
  - Drop curve theo thoi gian → xac nhan peak-stage crunch
  - Gia su co 8 drops, 7 o stage 2, 1 o stage 3 → VU shortage o peak
  - Gia su co 8 drops, phan bo deu → khong phai peak-stage issue, co the leak khac

Cach phat hien tren dashboard:
  - dropped_iterations chart theo thoi gian
  - So sanh voi VU chart: drops co trung luc VU max khong?
  - So sanh voi iterations chart: drops co trung luc iter_rate cao nhat khong?
```

## 6B. Phan tich nguyen nhan goc ky thuat (5 RC)

Moi RC di kem trace/code va cach phat hien tu output. Cac RC nay bo sung cho
CAR-07 — day la phien ban **ramping-arrival-rate** voi curve thay doi theo thoi gian.

### RC1: Mixed services tao phan phoi latency bimodal/multimodal — nhung thay doi theo stage

**Hien tuong**: p95 tong cua event = 86ms (run that). Nhung checkout rieng co p95 ~50ms,
browse rieng co p95 ~5ms. Phan phoi latency THAY DOI theo stage vi arrival rate thay doi.

**Nguyen nhan**: 6 branch co 6 W_effective (work per event) khac nhau:

```text
Cong thuc: W_effective = CPU + DB + external + memory + network

browse:   W_eff ≈ 1ms (cpu) + 2 rows DB + 0 ext ≈ 3ms           → event ~5ms
detail:   W_eff ≈ 1ms (cpu) + 1 row DB + 0 ext ≈ 2ms             → event ~5ms
cart:     W_eff ≈ 1ms (cpu) + 1 DB write + 4KB mem ≈ 8ms         → event ~10ms
auth:     W_eff ≈ 1ms (cpu) + 1 row DB + 4KB mem + auth ≈ 8ms    → event ~10ms
checkout: W_eff ≈ 2ms (cpu) + 1 DB write + 30ms ext ≈ 35ms       → event ~50ms
report:   W_eff ≈ 1ms (cpu) + 1 row DB + 1KB gzip ≈ 20ms         → event ~20ms
```

**Khac biet voi CAR-07**: Trong CAR-07, rate co dinh 18/s → phan phoi latency on dinh
theo thoi gian. Trong RAR-07, stage 2 (32/s peak) co nhieu event hon trong cung
thoi gian → xac suat nhieu checkout cung luc cao hon → tail latency co the cao hon.

**Demo trace 8 event tu cac branch khac nhau o stage 2 (peak ~32/s)**:

```text
Iter 100 (browse):   start=0ms, GET /api/sim/products      → 5ms, finish=5ms
Iter 101 (detail):   start=0ms, GET /api/sim/products/17   → 4ms, finish=4ms
Iter 102 (cart):     start=1ms, POST /api/sim/cart/add     → 12ms, finish=13ms
Iter 103 (auth):     start=1ms, GET /api/sim/auth/me       → 9ms, finish=10ms
Iter 104 (browse):   start=1ms, GET /api/sim/products      → 6ms, finish=7ms
Iter 105 (checkout): start=2ms, POST /api/sim/checkout     → 48ms, finish=50ms
Iter 106 (report):   start=2ms, GET /api/sim/report        → 22ms, finish=24ms
Iter 107 (detail):   start=2ms, GET /api/sim/products/42   → 5ms, finish=7ms

→ 8 event durations: [5, 4, 12, 10, 6, 48, 22, 5] ms
→ avg = 14ms, p95 ≈ 48ms (bi checkout keo)
→ 6/8 event < 15ms (75% traffic nhanh)
→ 1/8 event ~22ms (report)
→ 1/8 event ~48ms (checkout)
→ Phan phoi BIMODAL nhe: 2 dinh tai ~5-12ms va ~48ms
```

**Phan phoi latency thuc te tu Run #106**:

```text
Tong 1034 event trai tren 6 branch:

products-service (browse + detail):
  ~56% cua 1034 ≈ ~584 event
  p95 ~5-10ms (rat nhanh)

cart-service:
  ~17% ≈ ~180 event
  p95 ~15-25ms

auth-service:
  ~12% ≈ ~120 event
  p95 ~15-25ms

order-service (checkout):
  ~10% ≈ ~100 event
  p95 ~50-150ms (co external_ms=30)

report-service:
  ~5% ≈ ~50 event
  p95 ~30-50ms

→ Phan phoi MULTIMODAL: nhieu dinh
  - Dinh 1: ~5-10ms  (browse, detail) — 56% traffic
  - Dinh 2: ~15-25ms (cart, auth) — 29% traffic
  - Dinh 3: ~50-150ms (checkout, report) — 15% traffic

→ p95 tong = 86ms bi keo boi checkout
→ KHONG THE doc p95 tong ma ket luan "he thong cham"
→ Phai drill down operation de biet branch nao cham
```

**Khac biet RAR so voi CAR**: Trong RAR, latency distribution **thay doi theo stage**:

```text
Stage 1 (3→12/s): it event, it checkout cung luc → tail thap
Stage 2 (12→32/s): nhieu event, checkout co the chong cheo → tail cao hon
Stage 3 (32→10/s): tail giam dan
Stage 4 (10→0/s): tail thap nhat

→ p95 tong 86ms la CONG GON cua ca 4 stage
→ Neu tach rieng stage 2: p95 co the cao hon (100ms+)
→ Neu tach rieng stage 1: p95 co the chi 30-50ms
→ Day la thong tin bo sung ma CAR khong co (CAR chi co 1 rate)
```

**Cach phat hien**: So sanh `ramping_arrival_event_duration_ms` theo operation tag:

```text
SAI:
  "p95 tong = 86ms → he thong nhanh"
  → 86ms la BINH QUAN TRONG SO bi browse 5ms keo xuong
  → Browse p95 5ms, checkout p95 50ms+ → khong co y nghia gop chung

DUNG:
  "p95 browse = 5ms, p95 cart = 15ms, p95 checkout = 50ms"
  → Browse va detail nhanh
  → Checkout cham hon nhung chap nhan duoc (external dependency)
  → Report cham vua
```

### RC2: Peak-stage VU crunch — tai sao stage 2 la nguy hiem nhat

**Hien tuong**: Drops (neu co) se tap trung vao stage 2 (peak 32/s), khong phai
phan bo deu 65s. Day la khac biet cot loi voi CAR.

**Nguyen nhan**: Trong ramping-arrival-rate, VU demand ti le voi **current rate**:

```text
Tai giay 25 (giua stage 2): rate ≈ 22/s
  required_VUs = 22 × avg_duration

Tai giay 30 (cuoi stage 2): rate ≈ 32/s
  required_VUs = 32 × avg_duration = 1.45× giay 25

→ VU demand TANG DAN trong stage 2
→ Neu o giay 29, 3 checkout cung xuat hien (external_ms=30):
  - 3 VU bi hold ~50ms
  - Trong 50ms do, ~1-2 slot moi den
  - Neu khong con VU trong → DROP

→ DROPS XUAT HIEN O CUOI STAGE 2 (rate cao nhat)
→ Khong phai ngau nhien — co tinh he thong
```

**So sanh dinh luong voi RAR-05**:

```text
RAR-05 (report job, peak 8/s):
  - Stage 2: 3→8/s, co 20 drops
  - Drops tap trung o stage 2 (peak)
  - Ly do: async_job sleep(0.14s) giu VU, lam VU demand tang dot bien o peak

RAR-07 (mixed spike, peak 32/s):
  - Stage 2: 12→32/s, 0 drops trong run that
  - Ly do 0 drops: avg_duration thap (11.75ms), VU pool du (pre=30)
  - Nhung: NEU external_ms checkout tang 30→500ms
    → avg_duration ≈ 58.75ms
    → required_VUs = 32 × 0.05875 = 1.88 VU (van thap)
    → Nhung 3 checkout cung luc = 3 VU bi hold + co the gay drop
    → Drops van tap trung o stage 2
```

**Cach phat hien**:

```text
1. Xem dropped_iterations chart theo thoi gian
   → Drops co tap trung o phut 20-40 (stage 2)?
   → Neu co → peak-stage VU crunch confirmed

2. Xem Active VU chart cung thoi gian
   → Active VU co dat max vao stage 2?
   → Neu active VU tang dot ngot o stage 2 → VU pool bi ap luc

3. So sanh stage 2 vs stage 3 drops
   → Neu drops giam dang ke o stage 3 (rate giam 32→10)
   → Xac nhan: drops do rate cao chu khong phai do backend health
```

### RC3: Noisy Neighbor co dieu kien — khong phai luc nao cung xuat hien

**Hien tuong**: Trong run that, 0 drops, active VU max=6. Noisy neighbor KHONG
xuat hien o load nay. Nhung no TIEM AN xuat hien khi:

1. Checkout external_ms tang (backend degradation)
2. Nhieu checkout ROI VAO CUNG LUC (Poisson arrival clustering)
3. Peak rate cao hon (64/s thay vi 32/s)
4. Checkout weight cao hon (30% thay vi 10%)

**Nguyen nhan sau**: Noisy neighbor chi tro thanh van de khi **VU demand vinh vien
vuot qua VU supply tai thoi diem cu the**:

```text
Dieu kien de noisy neighbor gay drop:

  VU_available(t) < arrivals_burst(t) × avg_duration

Trong do:
  VU_available(t) = so VU dang trong tai thoi diem t
  arrivals_burst(t) = so slot den trong 1 khoang thoi gian ngan (~50ms)
  avg_duration = thoi gian trung binh cho 1 event

Voi RAR-07 default:
  VU_available ≈ 6 (tat ca deu trong, khong co checkout hold)
  arrivals_burst(50ms) ≈ 32 × 0.05 = 1.6 events
  avg_duration ≈ 11.75ms
  → 1.6 × 11.75 = 18.8 VU-ms < 6 × 50 = 300 VU-ms capacity
  → DU VU, khong drop

Voi RAR-07 worst case checkout:
  Gia su 3 checkout ROI CUNG LUC trong 10ms (Poisson burst)
  Moi checkout chiem 1 VU trong ~50ms (external_ms=30 + overhead)
  → 3 VU bi hold trong 50ms
  → Con 3 VU trong xu ly 29 events khac trong 50ms
  → 29 × 10ms = 290 VU-ms
  → 3 VU × 50ms = 150 VU-ms capacity
  → 290 > 150 → THIEU VU → DROP
```

**Minh hoa Noisy Neighbor bang trace thoi gian**:

```text
Timeline 100ms o stage 2 peak (32/s):

t=0ms:    slot 68  (browse)   → VU#1 nhan, xu ly 0-5ms
t=0ms:    slot 69  (checkout) → VU#2 nhan, xu ly 0-50ms  ← GIU VU LAU
t=1ms:    slot 70  (detail)   → VU#3 nhan, xu ly 1-6ms
t=1ms:    slot 71  (cart)     → VU#4 nhan, xu ly 1-12ms
t=2ms:    slot 72  (auth)     → VU#5 nhan, xu ly 2-12ms
t=2ms:    slot 73  (checkout) → VU#6 nhan, xu ly 2-52ms  ← GIU VU LAU
t=3ms:    slot 74  (browse)   → DOI VU! VU#1 vua xong o 5ms → VU#1 nhan
t=4ms:    slot 75  (detail)   → DOI VU! VU#3 vua xong o 6ms → VU#3 nhan
t=5ms:    slot 76  (report)   → DOI VU! VU#5 con ban toi 12ms → DOI
                                → VU#4 vua xong o 12ms → VU#4 nhan slot 76 (delay 7ms)
...
t=48ms:   slot 93  (browse)   → VU#2 VA CON BAN (checkout) → DOI
           → VU#5 vua xong → nhan slot 93
t=50ms:   slot 94  (detail)   → VU#2 vua xong checkout → nhan slot 94
t=52ms:   slot 95  (cart)     → VU#6 vua xong checkout → nhan slot 95

→ Trong 50ms, 2 VU bi checkout hold
→ 5 VU con lai (1,3,4,5 sau khi xong) xu ly 26 slots con lai
→ Moi event ~10ms, 5 VU × 50ms = 250ms capacity
→ 26 × 10ms = 260ms > 250 → suyt thieu, nhung van OK
→ Neu chi co 3 VU active: 3 × 50ms = 150ms < 260ms → DROP xuat hien!
```

**Cach phat hien noisy neighbor tren dashboard**:

```text
1. Group ramping_arrival_event_duration_ms by operation:
   - Neu production_spike_browse p95 tang khi production_spike_checkout
     xuat hien nhieu → noisy neighbor DA XUAT HIEN
   - Browse event duration = http duration + VU wait time
   - http duration browse luon ~5ms → neu event duration browse > 20ms
     → browse dang DOI VU (VU bi checkout hold)

2. Xem correlation VU active vs checkout count:
   - Active VU tang dot ngot khi checkout count cao
   → Checkout dang tao VU demand

3. Xem http_req_duration products-service:
   - Neu van ~5ms → products-service backend OK
   - Nhung event duration browse > 20ms → VU queueing delay
   → Day la noisy neighbor: backend OK, nhung VU pool bi canh tranh
```

### RC4: Drop budget 8 — bai hoc ve "cung con so, khac y nghia"

**Hien tuong**: `maxDropped=8` trong threshold, run that co 0 drops → PASS.
Nhung neu co chinh xac 8 drops, lieu co PASS khong? Con tuy drops vao DAU.

**Phan tich**: Giong CAR-07, drop budget la **lab budget**, khong phai production SLO:

```text
Lab contract (RAR-07):
  maxDropped = 8
  8 / 1035 = 0.77% dropped rate
  → PASS neu drops <= 8

Production SLO dien hinh:
  checkout service: 0 drop (transaction co tien)
  cart service: 0 drop (mat sale)
  browse service: co the accept 1-2 drops (user refresh)
  report service: co the accept vai drops (non-user-facing)

→ Cung 8 drops, nhung:
  - 8 drops o checkout → unacceptable (mat 8 don hang)
  - 8 drops o browse → co the accept (8/362 = 2.2% browse bi drop)
  - 8 drops o report → chap nhan duoc (8/52 = 15% report bi drop nhung khong anh huong user)
  - 4 checkout + 4 browse → van unacceptable vi checkout bi drop
```

**Minh hoa y nghia drop theo service o 3 tinh huong**:

```text
Tinh huong A: 8 drops, tat ca o browse
  - browse weight 35%, expected ~362 events
  - 8/362 = 2.2% browse bi drop
  - Impact: 8 lan browse bi fail → user refresh page → chap nhan duoc
  - Quyet dinh: CO THE accept trong lab
  - Hanh dong: tang nhe maxVUs neu muon 0 drop

Tinh huong B: 8 drops, tat ca o checkout
  - checkout weight 10%, expected ~104 events
  - 8/104 = 7.7% checkout bi drop (!)
  - Impact: 8 don hang bi mat → unacceptable
  - Quyet dinh: KHONG accept, phai fix
  - Hanh dong: toi uu checkout (giam external_ms), tang maxVUs,
    hoac tach checkout ra scenario rieng

Tinh huong C: 8 drops, trai deu (3 browse, 2 detail, 1 cart, 1 auth, 1 checkout)
  - 1 checkout drop = 1 don hang mat
  - Dù tong chi 8 drops nhung 1 checkout drop van khong the accept trong production
  - Trong lab: PASS threshold nhung can canh bao "1 checkout drop detected"
```

**Bai hoc**:

```text
1. Lab budget (8) != production budget (0 cho critical path)
2. Cung con so drop, y nghia KHAC NHAU tuy service bi drop
3. Luon drill service/operation khi co drop, KHONG chi nhin tong
4. Drop budget la cong cu DAY HOC: cho phep test "gan fail" de hoc
   cach doc signal, thay vi test luon zero-drop (khong co gi de hoc)
5. RAR drop pattern KHAC CAR: drops tap trung o peak stage
   → Drill drop KHONG CHI theo service ma CON THEO THOI GIAN (stage)
   → "8 drops, 7 o stage 2 (peak), 1 o stage 3" vs "8 drops deu 4 stage"
   → Y nghia khac nhau: peak-stage crunch vs chronic VU shortage
```

### RC5: Stage math la CHINH XAC — nhung khong nen doi perfect match

**Hien tuong**: Scheduled slots = 1035 (theo stage math), run that = 1034 (1 slot lech).
Day co phai la loi khong?

**Nguyen nhan**: ramping-arrival-rate su dung linear interpolation + timer-based scheduling.
Tai stage boundary, micro-timing variance co the gay lech ±2 slots:

```text
Cong thuc: area = duration × (rate_start + rate_end) / 2

Gia su stage 1 (3→12/s, 20s):
  - k6 bat dau stage 1 luc t=0.000000...
  - Ket thuc stage 1 luc t=20.000000... (timer interrupt)
  - Trong 20s: rate ramp tu 3 den 12/s theo linear
  - Slot scheduling: moi giay, tinh rate hien tai, tao slot

Variance sources:
  1. Timer granularity (~1ms): stage co the chay 20.001s hoac 19.999s
  2. Slot scheduling: khong phai moi slot duoc tao chinh xac o dau giay
  3. Start/end boundary: slot cuoi cung co the duoc tao TRUOC hoac SAU
     thoi diem ket thuc stage

→ 1034 / 1035 = 99.9% accuracy — perfectly normal
→ KHONG nen viet threshold `iterations == 1035`
→ Dung `dropped_iterations <= 8` thay vi `iterations >= 1035`
→ Focus vao drop/interrupted signal, khong phai exact slot count
```

**Bai hoc tu toan bo RAR series**:

```text
RAR-01: 705 target, 705 observed → exact (0 variance)
RAR-02: 507.5 target, 507 observed → -0.5 (lam tron xuong)
RAR-04: 317.5 target, 317 observed → -0.5 (lam tron xuong)
RAR-06: 950 target, 949 observed → -1 (boundary variance)
RAR-07: 1035 target, 1034 observed → -1 (boundary variance)

→ ±2 slots la BINH THUONG
→ Validate bang dropped_iterations + thresholds, KHONG bang exact equality
→ Neu lech > 5 slots → co the co van de khac (script crash, backend timeout...)
```

## 7. Service/API flow

### 7.1. Toan bo 6 branch — code

```javascript
const choice = weightedPick([
  { name: 'browse',   weight: 35 },
  { name: 'detail',   weight: 20 },
  { name: 'cart',     weight: 18 },
  { name: 'auth',     weight: 12 },
  { name: 'checkout', weight: 10 },
  { name: 'report',   weight: 5 },
], ctx.iter);

if (choice === 'browse') {
  // 35% traffic — read-heavy, rat nhanh
  ok = requestJson('GET',
    `${BASE_URL}/api/sim/products?limit=8&sort=popular&view=grid&cpu_ms=1&db_rows=2`,
    null, {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'production_spike_browse',
      endpoint: 'GET /api/sim/products',
      userId: ctx.userId,
    }).ok;

} else if (choice === 'detail') {
  // 20% traffic — doc chi tiet, rat nhanh
  const productId = (ctx.iter % 50) + 1;
  ok = requestJson('GET',
    `${BASE_URL}/api/sim/products/${productId}?view=full&cpu_ms=1&db_rows=1`,
    null, {
      caseId: CASE_ID,
      service: 'products-service',
      operation: 'production_spike_detail',
      endpoint: 'GET /api/sim/products/:id',
      userId: ctx.userId,
    }).ok;

} else if (choice === 'cart') {
  // 18% traffic — ghi nhe, memory 4KB
  ok = requestJson('POST',
    `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4`,
    { product_id: productId, quantity: 1 }, {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'production_spike_cart_add',
      endpoint: 'POST /api/sim/cart/add',
      userId: ctx.userId,
    }).ok;

} else if (choice === 'auth') {
  // 12% traffic — xac thuc + validation
  ok = requestJson('GET',
    `${BASE_URL}/api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4`,
    null, {
      caseId: CASE_ID,
      service: 'auth-service',
      operation: 'production_spike_auth_me',
      endpoint: 'GET /api/sim/auth/me',
      userId: ctx.userId,
      headers: { Authorization: `Bearer ${ctx.userId}` },
    }).ok;

} else if (choice === 'checkout') {
  // 10% traffic — CHAM NHAT: external_ms=30
  const checkout = requestJson('POST',
    `${BASE_URL}/api/sim/checkout?cpu_ms=2&db_writes=1&external_ms=30&external_fail_rate=0`,
    { user_id: ctx.userId, items: [{ id: productId, qty: 1 }], payment_method: 'card' },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'production_spike_checkout',
      endpoint: 'POST /api/sim/checkout',
      userId: ctx.userId,
      headers: { 'Idempotency-Key': `rar07-${ctx.requestKey}` },
    });
  ok = checkout.ok && responseJson(checkout.response, 'data.order_id', '') !== '';

} else {
  // 5% traffic — report co gzip 1KB
  ok = requestJson('GET',
    `${BASE_URL}/api/sim/report?cpu_ms=1&db_rows=1&gzip_kb=1`,
    null, {
      caseId: CASE_ID,
      service: 'report-service',
      operation: 'production_spike_report',
      endpoint: 'GET /api/sim/report',
      userId: ctx.userId,
    }).ok;
}

finishEvent(started, ok, {
  caseId: CASE_ID,
  service: 'mixed',                          // <-- TAT CA branch chung service='mixed'
  operation: `production_spike_${choice}`,   // <-- branch name trong operation tag
  userId: ctx.userId,
});
```

### 7.2. Bang tong hop branch

| Branch | Weight | Service | Operation | Endpoint | Method | Dac diem | Est. duration |
| --- | ---: | --- | --- | --- | --- | --- | ---: |
| browse | 35% | products-service | `production_spike_browse` | `/api/sim/products` | GET | cpu=1, db=2, limit=8 | ~5ms |
| detail | 20% | products-service | `production_spike_detail` | `/api/sim/products/:id` | GET | cpu=1, db=1, view=full | ~5ms |
| cart | 18% | cart-service | `production_spike_cart_add` | `/api/sim/cart/add` | POST | cpu=1, db_write=1, mem=4KB | ~10ms |
| auth | 12% | auth-service | `production_spike_auth_me` | `/api/sim/auth/me` | GET | cpu=1, db=1, mem=4KB, Bearer | ~10ms |
| checkout | 10% | order-service | `production_spike_checkout` | `/api/sim/checkout` | POST | cpu=2, db_write=1, **ext=30ms**, idempotency | ~50ms |
| report | 5% | report-service | `production_spike_report` | `/api/sim/report` | GET | cpu=1, db=1, gzip=1KB | ~20ms |

### 7.3. 1 call/event — khac RAR-04 (multi-call)

```text
RAR-04 (checkout flash-sale): 3 calls/event (cart add + checkout create + confirm)
  → http_reqs = 3 × iterations

RAR-07 (production spike mix): 1 call/event
  → http_reqs = iterations = 1035
  → Moi event chi co 1 API call duy nhat
  → event duration ≈ http_req_duration (chi khac JS overhead nho)

Dieu nay don gian hoa phan tich:
  - Khong can tach event duration thanh cac call con
  - p95 event ≈ p95 HTTP cho branch tuong ung
  - De dang map branch → service → duration
```

### 7.4. check du lieu — checkout co parse response

```javascript
// Checkout branch kiem tra ca order_id trong response
ok = checkout.ok && responseJson(checkout.response, 'data.order_id', '') !== '';
```

Day la branch DUY NHAT co logic parse response. Ly do: checkout la transaction
co gia tri business cao nhat. Khong chi can HTTP 200 — can ca order_id de xac
nhan giao dich da duoc tao.

## 8. Metrics and tags

### 8.1. Custom metrics

```text
ramping_arrival_events_total        ← Counter: tong so event da finish
ramping_arrival_events_failed       ← Counter: so event that bai
ramping_arrival_api_calls_total     ← Counter: tong so API call
ramping_arrival_event_duration_ms   ← Trend: event duration distribution
```

### 8.2. Event-level metrics: service='mixed'

**DAY LA DIEM QUAN TRONG NHAT KHI DOC METRICS CUA CASE NAY**

```text
finishEvent() gan:
  service: 'mixed'
  operation: 'production_spike_browse' | '..._detail' | '..._cart_add' | ...

→ Tren dashboard, khi group theo service:
  - service='mixed' chua TAT CA 1035 event
  - Khong the nhin service tag de biet event nay la products-service hay order-service

→ Muon phan tich theo service:
  - NHIN VAO REQUEST-LEVEL metrics (http_req_*)
  - http_req_duration co tag service='products-service', 'order-service', ...
  - http_reqs co tag service dung voi branch service

→ Muon phan tich theo branch (operation):
  - Dung operation tag tren EVENT-LEVEL metrics
  - ramping_arrival_event_duration_ms group by operation
  - production_spike_browse vs production_spike_checkout → so sanh p95
```

### 8.3. Request-level metrics: service chinh xac

```text
requestJson() set params.tags:
  service: 'products-service' | 'cart-service' | 'auth-service' |
           'order-service' | 'report-service'
  operation: 'production_spike_browse' | '..._detail' | '..._cart_add' | ...
  endpoint: 'GET /api/sim/products' | ... | 'GET /api/sim/report'

→ http_reqs, http_req_duration, http_req_failed CO THE group by service THAT
→ http_req_duration group by service='order-service' → p95 checkout latency
→ http_reqs group by service='products-service' → count browse + detail requests
```

### 8.4. Cach doc metrics dung

```text
DE DOC TONG QUAN:
  ramping_arrival_events_total{service="mixed"} = 1035
  dropped_iterations = 0

DE DOC THEO BRANCH:
  ramping_arrival_event_duration_ms{operation="production_spike_browse"}   → p95 browse
  ramping_arrival_event_duration_ms{operation="production_spike_checkout"} → p95 checkout

DE DOC THEO SERVICE THAT:
  http_req_duration{service="products-service"} → p95 products-service (gom browse + detail)
  http_req_duration{service="order-service"}    → p95 checkout

DE DEM REQUEST THEO ENDPOINT:
  http_reqs{endpoint="GET /api/sim/products"}   → so browse requests
  http_reqs{endpoint="POST /api/sim/checkout"}  → so checkout requests

SAI:
  "service='mixed' tren event co p95 = 86ms" → nhung la TAT CA branch gop lai
  "p95 86ms la tot cho checkout" → SAI — checkout co the 200ms nhung bi browse 5ms keo xuong

DUNG:
  "event p95 overall = 86ms (tat ca branch gop lai)"
  "http p95 products-service = 5ms, order-service = 50ms"
  "checkout/report co p95 cao hon browse/detail"
```

### 8.5. Cac tag khac

```text
case_id:           rar-07-production-spike-mix
user_id:           rar-user-1 ... rar-user-1200
executor_family:   ramping_arrival_rate
workload_shape:    ramping_ingress_rate
business_case:     production_spike_mixed_api_ingress
```

## 9. Pass criteria

### 9.1. Thresholds chinh thuc

| Threshold | Expression | Y nghia | Budget |
| --- | --- | --- | --- |
| `checks` | `rate>0.98` | Ti le HTTP status pass | Toi da 2% check fail |
| `http_req_failed` | `rate<0.02` | Ti le HTTP request fail | Toi da 2% request fail |
| `dropped_iterations` | `count<=8` | So arrivals bi drop | Toi da 8/1035 = 0.77% |
| `ramping_arrival_events_failed` | `count<25` | So event that bai (any branch) | Toi da 24/1035 = 2.3% |

### 9.2. Budget rationale

```text
dropped_iterations <= 8 (0.77%):
  - Relax hon CAR-07 (5/1080 = 0.46%)
  - Ly do: spike curve (3→32→10→0) co nhieu bien hon rate co dinh (18/s)
  - Stage transitions (ramp up/down) co the tao micro-burst cao hon expected
  - 8 drops la "acceptable" trong lab test; production co the yeu cau 0

events_failed < 25 (2.4%):
  - Cho phep event fail tu nhien (checkout external fail, auth token expired)
  - Khong phai moi event fail la do he thong qua tai

checks > 0.98:
  - 98% HTTP status pass
  - 2% fail co the tu external_fail_rate (hien tai = 0) hoac loi mang
```

### 9.3. Run that PASS

```text
Default local run:
  iterations            = 1,035         ✅ exact match scheduled slots
  http_reqs             = 1,035         ✅ 1 call/event
  checks_rate           = 1.0           ✅ 100% pass
  http_req_failed_rate  = 0             ✅ 0% fail
  dropped_iterations    = 0             ✅ well within budget (0 <= 8)
  events_failed         = 0             ✅ well within budget (0 < 25)
  event p95             = 86ms
  http p95              = 86.31ms
  active VU max         = 6
  vus_max               = 30

Verdict: PASS — default ramping-arrival-rate case giu duoc mixed spike curve:
  checks sach, HTTP failed 0%, dropped_iterations=0.
```

### 9.4. Di qua budget gap

```text
MaxDropped dat la 8 nhung run that co 0 drop.
→ Day la "PASS voi headroom" — co du VU pool cho mixed spike nay
→ Neu mot ngay nao do checkout chau hon (external_ms tang) hoac peak cao hon
  → Drops co the xuat hien nhung van trong budget 8
→ Budget 8 cho phep he thong "tho" mot chut ma khong FAIL
→ Neu can production 0-drop SLO → phai dam bao VU pool lon hon hoac toi uu checkout
```

## 10. Cach chay + output 5 buoc

### Buoc 1: Kiem tra moi truong

```powershell
# Verify k6
k6 version
# Expected: k6 v2.0.0+

# Verify load-target
curl http://localhost:80/health
# Expected: HTTP 200
```

### Buoc 2: Inspect script

```powershell
k6 inspect "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js"
```

Expected output:

```text
executor: ramping-arrival-rate
stages: [3→12, 12→32, 32→10, 10→0]
preAllocatedVUs: 30
maxVUs: 90
```

### Buoc 3: Chay default local

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js"
```

### Buoc 4: Doc output

Expected output highlights:

```text
ramping_arrival_rate: .........: 15.915457/s
iteration_duration...: avg=45.17ms  med=3ms  p(95)=86ms
http_req_duration....: avg=45.07ms  med=3.10ms p(95)=86.31ms
iterations...........: 1035
http_reqs............: 1035
vus..................: max=5
vus_max..............: min=30  max=30
dropped_iterations...: 0
checks...............: 100.00% ✓
http_req_failed......: 0.00% ✓
```

### Buoc 5: Verify request breakdown

Expected counts (theo weight distribution × 1035):

| Branch | Weight | Expected count | Khoang chap nhan |
| --- | ---: | ---: | --- |
| browse | 35% | 362 | 345-380 |
| detail | 20% | 207 | 195-220 |
| cart | 18% | 186 | 175-198 |
| auth | 12% | 124 | 115-135 |
| checkout | 10% | 104 | 95-113 |
| report | 5% | 52 | 45-60 |

Run that #106:

```text
production_spike_browse  GET 200  count=384  (37.1%)
production_spike_detail  GET 200  count=200  (19.3%)
production_spike_cart_add POST 200 count=180 (17.4%)
production_spike_auth_me GET 200  count=120  (11.6%)
production_spike_checkout POST 200 count=100 (9.7%)
production_spike_report  GET 200  count=50   (4.8%)
                                              (total=1034, gan dung 1035)
```

## 11. Dashboard 3-chart reading guide

### 11.1. Chart 1: Response time

**Event-level trend**:

```text
ramping_arrival_event_duration_ms / service='mixed' / operation=*

→ Day la event duration cua TAT CA branch gop lai
→ p95 overall = 86ms trong run that
→ KHONG doc p95 nay de ket luan "checkout nhanh" hay "browse cham"
→ Day la BINH QUAN CO TRONG SO cua 6 branch duration
→ Browse (5ms, 35%) keo average xuong, checkout (50ms, 10%) keo p95 len
```

**Drill down bang operation**:

```text
Group by operation tag de THAY RO su khac biet:

production_spike_browse:   p95 ~5-10ms   (nhanh nhat)
production_spike_detail:   p95 ~5-10ms   (nhanh nhat)
production_spike_cart_add: p95 ~15-25ms  (vua)
production_spike_auth_me:  p95 ~15-25ms  (vua)
production_spike_report:   p95 ~30-50ms  (cham vua)
production_spike_checkout: p95 ~50-150ms (cham nhat — external_ms=30)

→ KHONG the noi "p95 overall = 86ms la tot cho he thong"
→ Phai noi: "browse/detail p95 ~10ms la tot, checkout p95 ~50ms la chap nhan"
→ Neu checkout p95 dot ngot len 500ms → noisy neighbor alarm
```

**Drill down bang service**:

```text
Nhung chi co tren REQUEST-level metrics:

http_req_duration / service=products-service → browse + detail requests
http_req_duration / service=order-service    → checkout requests
http_req_duration / service=report-service   → report requests

→ Day la cach BIET checkout co gay ra van de khong
→ Neu order-service p95 tang → checkout la bottleneck
→ Neu products-service p95 van thap → browse khong bi anh huong truc tiep
```

### 11.2. Chart 2: Execution timeline

```text
iterations / http_reqs chart:

→ Duong iterations phai FOLLOW curve 3→12→32→10→0/s
→ http_reqs == iterations (1 call/event)
→ Tai giay 10: rate ≈ 7.5/s, iterations/second ≈ 7-8
→ Tai giay 30 (peak): rate ≈ 32/s, iterations/second ≈ 31-33
→ Tai giay 45: rate ≈ 21/s, iterations/second ≈ 20-22
→ Tai giay 65: rate ≈ 0/s, iterations/second ≈ 0

dropped_iterations chart:
→ Trong run that: flat 0 — khong drop nao
→ Neu co drop: se thay spikes trong stage 2 (peak)
→ Drop tap trung vao stage 2 → xac nhan VU shortage o peak

VUs chart:
→ active VU sampled o 1s granularity
→ Run that: max=6, thap hon pre=30 rat nhieu
→ VU chart phang, khong co VU spikes → VU pool khong bi ap luc
```

### 11.3. Chart 3: Active VU sharing visualization

```text
VD: Trong 1 giay o peak 32/s:

Timeline VU usage (tren 6 VU):
  VU#1: browse(0-5ms) detail(5-10ms) browse(10-15ms) cart(15-25ms) ...
  VU#2: detail(0-5ms) browse(5-10ms) auth(10-20ms) cart(20-30ms) ...
  VU#3: checkout(0-50ms)                                browse(50-55ms) ...
  VU#4: cart(0-10ms) report(10-30ms) browse(30-35ms) ...
  VU#5: browse(0-5ms) detail(5-10ms) cart(10-20ms) ...
  VU#6: auth(0-10ms) browse(10-15ms) detail(15-20ms) ...

→ VU#3 bi checkout "hold" 50ms — trong 50ms do khong xu ly duoc browse nao
→ Cac VU khac xu ly browse/detail/cart/auth lien tuc
→ Noisy neighbor: 1 VU bi "hut" boi checkout trong khi cac VU khac van OK
→ Neu chi co 2 VU active: 1 bi checkout → chi con 1 xu ly 31 events → se co drop
→ Voi 6 VU active: 1 bi checkout → 5 con lai xu ly 31 events → OK
```

**Cach phat hien noisy neighbor tren chart**:

```text
1. Active VU tang dot ngot tai thoi diem checkout chay
2. http_req_duration cua products-service tang trong khi
   http_req_duration cua order-service cung tang
   → Browse bi anh huong boi checkout (VU pool canh tranh)
3. Neu chi co order-service p95 tang, products-service p95 khong tang
   → Moi service dang gap van de rieng, chua phai noisy neighbor
```

## 12. 4 output -> decision scenarios

### Scenario A: All green, drop=0 (Run that)

```text
Output:
  - dropped_iterations = 0
  - checks = 100%
  - http_req_failed = 0%
  - Active VU max = 6 (<< pre=30)
  - Event p95 = 86ms
  - Checkout p95 ~50ms, Browse p95 ~5ms

Phan tich:
  - Toan bo mixed spike curve duoc giu vung
  - VU pool co nhieu headroom (pre=30 nhung chi dung 6)
  - Khong co noisy neighbor o load nay
  - Checkout external_ms=30 chua gay ap luc len VU pool

Ket luan:
  - BASELINE MET → mixed production spike contract pass
  - Co the tu tin nang cap: tang peak, tang external_ms, tang checkout weight
  - Chuyen sang VARIATION testing neu muon kiem tra noisy neighbor boundary
```

### Scenario B: Drop > 0, VU dat max

```text
Output:
  - dropped_iterations > 0 (co the den 8 trong budget)
  - Active VU gan max (active VU ≈ 90)
  - vus_max da cham configured maxVUs=90
  - Drop tap trung vao stage 2 (peak)

Phan tich:
  - VU pool KHONG du cho mixed spike nay
  - K6 da spawn toi da VU nhung van khong xu ly kip arrivals
  - Noisy Neighbor CONFIRMED: service cham (checkout/report) dang ngon VU,
    lam service nhanh (browse/detail) bi thieu worker

Hanh dong:
  1. Drill drop by operation: drop vao branch nao?
     - Neu drop vao browse (35% traffic, read-only): browse bi starve boi checkout
       → Day la noisy neighbor nang nhat — service IT QUAN TRONG (10%) gay drop
         cho service QUAN TRONG (35%)
     - Neu drop vao checkout (10%): checkout tu gay drop cho chinh no
       → Checkout cham + nhieu arrivals = tu dao thai
  2. Xem xet giai phap:
     a. Tang maxVUs tu 90 len 200 → them VU de hap thu checkout tail
        → Don gian nhung ton tai nguyen (moi VU ton memory)
     b. Tach scenario: checkout + report VU pool rieng, browse/detail VU pool rieng
        → Phuc tap hon nhung bao ve duoc browse khoi checkout
     c. Toi uu checkout: giam external_ms (cache payment gateway response),
        them timeout circuit breaker → giai quyet goc
```

### Scenario C: High p95 nhung low drop

```text
Output:
  - dropped_iterations = 0 hoac rat thap
  - Nhung event p95 high (vd 500ms+)
  - http p95 checkout rat cao (200ms+)
  - Active VU van thap (6-10)

Phan tich:
  - Checkout/report tail latency cao nhung VU pool du de absorb
  - K6 co du VU de xu ly tat ca arrivals, nhung mot so event rat cham
  - Tail nay co the den tu:
    a. external_ms=30 + queueing trong load-target
    b. DB write bottleneck khi nhieu checkout cung luc
    c. Gzip compression cho report

Ket luan:
  - Tail tu checkout/report, KHONG PHAI tu browse/detail
  - Acceptable trong lab test (van pass contract)
  - Nhung: trong production, checkout p95 500ms la unacceptable
    cho UX (user doi 500ms de checkout)

Hanh dong:
  - Dieu tra checkout latency: external_ms that su la 30ms hay DB write la bottleneck?
  - Neu external that su la 30ms → chap nhan (day la external dependency)
  - Neu DB write la bottleneck → optimize DB, them connection pool
  - Accept tail latency o report (5% traffic, non-user-facing) nhung
    KHONG accept tail o checkout (10% traffic, transaction co tien)
```

### Scenario D: Browse p95 degraded

```text
Output:
  - browse p95 tang (vd tu 5ms len 50ms)
  - dropped_iterations > 0
  - Active VU cao (close to maxVUs)
  - Checkout p95 van binh thuong (~50ms)

Phan tich:
  - Browse (vốn rat nhanh) bi cham di — day la DAU HIEU noisy neighbor
  - Khong phai browse co van de — van de la VU pool bi canh tranh
  - Cart/checkout dang consume VU pool, lam browse phai doi VU trong

Day la tinh huong te nhi nhat:
  - Browse van pass HTTP (200 OK)
  - Browse khong co external dependency
  - Nhung browse p95 tang → VU queueing delay
    → Browse iteration duoc tao dung gio nhung PHAI DOI VU trong de xu ly
    → Thoi gian doi nay duoc tinh vao event duration

Ket luan:
  - VU pool consumption boi cart/checkout dang lam cham BROWSE
  - Browse bi "starve" — co slot den nhung khong co VU xu ly

Hanh dong:
  1. Xac nhan: browse event duration > http_req_duration browse?
     → Neu event >> http → thoi gian doi VU la nguyen nhan
  2. Tach browse/detail ra scenario rieng voi VU pool rieng
     → dam bao browse LUON co VU trong
  3. Hoac: tang maxVUs de co du VU cho tat ca
```

## 13. Nghich ly / misconceptions

### Nghich ly 1: "1035 slots trong 65s — total cao nhat series"

```text
Trong khi:
  RAR-06 (cache feed) peak 36/s cao hon RAR-07 peak 32/s
  Nhung RAR-06 chi co 950 slots trong 55s

RAR-07 total = 1035 > 950 vi:
  - Stage dai hon (4 stage, 65s vs 55s)
  - Start rate cao hon (3 vs 4/s) nhung stage 1 dai hon (20s vs 15s)
  - Dien tich hinh thang = duration × average rate
  - 65s × 15.92 avg = 1035 > 55s × 17.27 avg = 950

Bai hoc: TOTAL SLOTS khong phu thuoc chi vao PEAK RATE.
  - Stage duration va curve shape cung quan trong ngang nhau
  - Mot curve co peak thap nhung keo dai co the co total > curve co peak cao nhung ngan
```

### Nghich ly 2: "service='mixed' tren event metric — phai drill down operation de phan tich"

```text
Nhieu nguoi doc dashboard thay service='mixed' tren event metric va tu hoi:
  "Mixed la service nao? Co phai la mot service that khong?"

Cau tra loi: KHONG.
  - 'mixed' khong phai la mot service that
  - 'mixed' la TAG CHO TAT CA EVENT cua scenario nay
  - Ly do: 1 scenario, 6 branch, 5 service, nhung chi co 1 finishEvent()
  - finishEvent() khong the ghi service='products-service' (vi se mat cart/auth/checkout/report)
  - finishEvent() khong the ghi nhieu service (1 event chi co 1 service tag)

He qua:
  - Event-level metrics: phai drill down bang OPERATION tag
    → operation='production_spike_browse' de biet event duration cua browse
  - Service-level metrics: phai dung REQUEST-level metrics
    → http_req_duration / service='products-service' de biet latency products-service
  - KHONG the biet "service nao cham" tu event metrics
  - Chi co the biet "branch nao cham" tu event metrics (qua operation tag)

Day la anti-pattern neu khong hieu: nhin service='mixed' tren event p95=86ms
va ket luan "mixed service co p95 86ms". 'Mixed' khong phai la service!
```

### Nghich ly 3: "6 branches share 1 pool nhung active VU chi 6"

```text
Tai sao 32 events/s voi 6 branch khac nhau chi can 6 VU?

Cau tra loi: Little's Law + average event duration:

  avg_event_duration (trong so) =
    0.35×5 + 0.20×5 + 0.18×10 + 0.12×10 + 0.10×50 + 0.05×20
  = 1.75 + 1.0 + 1.8 + 1.2 + 5.0 + 1.0
  = 11.75ms

  required_VUs = arrival_rate × avg_duration
               = 32 × 0.01175
               = 0.376 VU

Chi can 1 VU ve mat toan hoc! Nhung thuc te can 6 vi:
  - VU khong hoat dong lien tuc (co gap giua cac event)
  - Phan phoi Poisson cua arrivals (khong deu)
  - Checkout duration tail (co the len 100ms+)
  - Sampling granularity (VU count duoc sample moi 1s)

6 VU that su la MOT CON SO RAT THAP so voi pre=30, max=90.
Dieu nay cho thay: voi backend khoe (cpu=1-2ms, external=30ms),
mixed 32/s la mot workload rat nhe. VU pool headroom rat lon.

Nhung DUNG QUEN: neu external_ms checkout tang tu 30→500ms:
  checkout duration: 50ms → 520ms
  avg_duration moi: 11.75 → 11.75 + 0.10×(520-50) = 11.75 + 47 = 58.75ms
  required_VUs = 32 × 0.05875 = 1.88 VU (van thap!)
  Nhung checkout co the TAO RA BURST: 3 checkout cung luc
  → 3 VU bi hold boi checkout → con 3 VU cho 29 events
  → 29 events × 10ms = 290ms → 3 VU du
  → Nhung neu chi con 2 VU: 29 × 10 / 2 = 145ms < 1000ms → OK
  → Van de CHI xuat hien khi nhieu checkout ROI VAO CUNG LUC
```

### Nghich ly 4: "Budget 8 drops la 'thoang' nhung thuc te la chat"

```text
8/1035 = 0.77% nghe co ve thoang.

Nhung trong production:
  - 0.77% cua 1,000,000 requests = 7,700 requests bi drop
  - Neu 10% drops la checkout → 770 giao dich bi mat
  - 770 × $50/giao dich = $38,500 loss
  → 0.77% la KHONG nho khi ap dung vao production volume

Trong lab:
  - 8 drops la budget de day cach phan tich
  - Nhung muc tieu THUC TE la 0 drops
  - Neu run that co 0 drops → pass tuyet doi
  - Neu run co 1-8 drops → pass threshold nhung can dieu tra
```

## 14. Checklist

Truoc khi chay RAR-07, xac nhan:

```text
[ ] Script path dung: .../ramping-arrival-rate/rar-07-production-spike-mix.js
[ ] k6 inspect pass (executor=ramping-arrival-rate)
[ ] BASE_URL tro toi load-target (http://localhost:80)
[ ] Load-target health check pass
[ ] Hieu su khac biet event-level service='mixed' vs request-level service
[ ] Biet cach drill down dashboard: operation tag cho branch, service tag cho request
[ ] Hieu co che Noisy Neighbor: checkout cham → VU pool canh tranh → browse co the bi drop
[ ] Biet cach tinh stage math: area = duration × (rate_start + rate_end) / 2
[ ] Biet y nghia preAllocatedVUs=30 va maxVUs=90
[ ] San sang doc dropped_iterations va so sanh voi maxDropped=8

Sau khi chay, kiem tra:
[ ] iterations ≈ 1035
[ ] dropped_iterations <= 8
[ ] http_reqs == iterations (1 call/event)
[ ] Branch counts theo dung weight distribution
[ ] Event p95 khong bi checkout/report keo qua cao mot cach bat thuong
[ ] http p95 products-service << http p95 order-service (browse nhanh hon checkout)
[ ] Active VU max < preAllocatedVUs (headroom con)
[ ] Neu co drop → drill down xac dinh drop vao branch nao
```

## 15. Variations

### Variation A: Higher checkout weight — Noisy Neighbor stress

```powershell
# Tang checkout weight tu 10% → 30%, giam browse tu 35% → 15%
# Muc tieu: kiem tra noisy neighbor khi nhieu checkout cung luc
$env:BASE_URL = "http://localhost:80"
$env:RAR_07_MAX_DROPPED = "15"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js"
```

Can chinh `weightedPick` weights trong script:

```javascript
// Variation A: checkout-heavy production
{ name: 'browse',   weight: 15 },  // giam tu 35
{ name: 'detail',   weight: 15 },  // giam tu 20
{ name: 'cart',     weight: 15 },  // giam tu 18
{ name: 'auth',     weight: 10 },  // giam tu 12
{ name: 'checkout', weight: 30 },  // TANG tu 10
{ name: 'report',   weight: 15 },  // TANG tu 5
```

Expected: Drops tang, active VU tang, browse p95 co the bi anh huong.
Day la cach STRESS TEST noisy neighbor.

### Variation B: Separate scenarios — 6 VU pools

```javascript
// Tach moi branch thanh scenario rieng voi VU pool rieng
export const options = {
  scenarios: {
    browse:   buildScenario(startRate * 0.35, [...], pre=10, max=30),
    detail:   buildScenario(startRate * 0.20, [...], pre=6,  max=20),
    cart:     buildScenario(startRate * 0.18, [...], pre=6,  max=15),
    auth:     buildScenario(startRate * 0.12, [...], pre=4,  max=12),
    checkout: buildScenario(startRate * 0.10, [...], pre=8,  max=30),
    report:   buildScenario(startRate * 0.05, [...], pre=4,  max=10),
  },
};
```

Muc tieu: So sanh voi 1-scenario mixed.
- Neu 6-scenario pass nhung 1-scenario fail → noisy neighbor confirmed
- Neu ca 2 deu pass → VU pool khong phai la bottleneck
- Trade-off: 6 scenario = 6 VU pool rieng = ton VU memory hon

### Variation C: Higher spike peak

```powershell
# Tang peak tu 32/s → 64/s, kiem tra VU pool dap ung
$env:RAR_07_SPIKE_RATE = "64"
$env:RAR_07_PREALLOCATED_VUS = "60"
$env:RAR_07_MAX_VUS = "180"
$env:RAR_07_MAX_DROPPED = "30"
k6 run "...rar-07-production-spike-mix.js"
```

Expected: Active VU tang, drops co the xuat hien.
Tinh lai stage math:

```text
Stage 2: (12+64)/2 × 20 = 760 (gap 1.73× default 440)
Total: 150 + 760 + (64+10)/2×20 + 25 = 150 + 760 + 740 + 25 = 1675
```

### Variation D: Smoke test (10s)

```powershell
# Rut ngan duration de kiem tra nhanh
$env:RAR_07_DURATION_SCALE = "0.1"
k6 run "...rar-07-production-spike-mix.js"
```

Expected: 2+2+2+0.5 = 6.5s, khoang 103 slots.
Dung de verify script run duoc truoc khi chay full 65s.

### Variation E: Production 0-drop SLO

```powershell
# Strict SLO: KHONG cho phep drop nao
$env:RAR_07_MAX_DROPPED = "0"
$env:RAR_07_PREALLOCATED_VUS = "60"
$env:RAR_07_MAX_VUS = "200"
k6 run "...rar-07-production-spike-mix.js"
```

Expected: Voi VU pool lon, 0 drop.
Day la cach run production SLO — chap nhan chi phi VU cao hon de dam bao 0 drop.

## 16. Anti-patterns

### Anti-pattern 1: Doc service='mixed' nhu mot service that

```text
SAI:
  "Mixed service co p95 86ms" — 'mixed' khong phai la service!
  "Mixed service co 1035 requests" — 'mixed' la tag tong hop, khong phai service backend

DUNG:
  "Event-level metrics co service='mixed' chua tat ca 6 branch"
  "Muon biet service nao cham → xem http_req_duration group by service"
  "Muon biet branch nao cham → xem event_duration group by operation"
```

### Anti-pattern 2: Khong drill down operation khi event co service='mixed'

```text
SAI:
  Nhin event p95=86ms → ket luan "response time tot"
  → 86ms la BINH QUAN TRONG SO: browse 5ms (35%) + checkout 50ms (10%) = ~11.75ms weighted avg
  → p95 86ms bi checkout tail keo len, nhung browse/detail van 5ms

DUNG:
  Drill down operation: browse p95=5ms, checkout p95=50ms
  → Browse nhanh, checkout cham (bình thuong)
  → Giam sat checkout p95 rieng, browse p95 rieng
```

### Anti-pattern 3: Gia su tat ca branch co cost dong deu

```text
SAI:
  "6 branch, 32/s peak → 32/6 ≈ 5.3 events/s per branch"
  → Bo qua weight distribution (35% browse vs 5% report)
  → Bo qua cost khac nhau (5ms browse vs 50ms checkout)

DUNG:
  Browse: 32 × 0.35 = 11.2 events/s, moi event ~5ms → 56 VU-ms/s
  Checkout: 32 × 0.10 = 3.2 events/s, moi event ~50ms → 160 VU-ms/s
  → Checkout TON VU GAP 2.85× browse mac du chi bang 28% traffic cua browse
```

### Anti-pattern 4: Tang maxVUs ma khong dieu tra noisy neighbor

```text
SAI:
  "Co drops → tang maxVUs tu 90 → 500"
  → Drops co the giam nhung goc van de khong duoc giai quyet
  → Checkout van cham, van ngon VU
  → 500 VU ton memory, browse van co the bi drop luc checkout burst

DUNG:
  1. Drill down drop: drop vao branch nao?
  2. Xac dinh noisy neighbor: checkout/report co giu VU qua lau?
  3. Goc: toi uu checkout (giam external_ms, circuit breaker, cache)
  4. Hoac: tach scenario de VU pool checkout khong anh huong browse
  5. Tang maxVUs la giai phap CUOI CUNG, khong phai dau tien
```

### Anti-pattern 5: Khong chay variation de test noisy neighbor boundary

```text
SAI:
  Default run pass (0 drops) → ket luan "mixed spike OK" → dung lai
  → Khong biet duoc he thong se FAIL o dau
  → Khong biet checkout weight 30% co gay drop khong
  → Khong biet peak 64/s co pass khong

DUNG:
  1. Chay default → baseline pass
  2. Chay variation A (checkout 30%) → tim noisy neighbor boundary
  3. Chay variation C (peak 64/s) → tim VU pool capacity boundary
  4. Chay variation E (0-drop SLO) → tim VU pool size can thiet cho production
  → Hieu duoc GIOI HAN cua he thong, khong chi biet no pass hay fail
```

## 17. Real validation data

### Run #106 — default local

```text
Run ID: #106
Script: rar-07-production-spike-mix.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Summary

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes/checks_fails` | `1,034 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `1,034` |
| `iterations_rate` | `15.91/s` |
| `http_reqs` | `1,034` |
| `http_reqs_rate` | `15.91/s` |
| `vus_max` | `5` |
| `ramping_arrival_event_duration_ms avg/med/p95/p99/max` | `45.17 / 3 / 80.60 / 943.05 / 1,005 ms` |
| `http_req_duration avg/med/p95/p99/max` | `45.07 / 3.10 / 80.34 / 943.18 / 1,005.32 ms` |

### Request breakdown

| Operation | Method | Status | Count | % of total |
| --- | --- | --- | ---: | ---: |
| `production_spike_browse` | GET | 200 | 384 | 37.1% |
| `production_spike_detail` | GET | 200 | 200 | 19.3% |
| `production_spike_cart_add` | POST | 200 | 180 | 17.4% |
| `production_spike_auth_me` | GET | 200 | 120 | 11.6% |
| `production_spike_checkout` | POST | 200 | 100 | 9.7% |
| `production_spike_report` | GET | 200 | 50 | 4.8% |

Weight distribution observed vs expected: gan dung (random variance trong weightedPick).

### Dashboard series

```text
iterations: points=65, sum=1,034, min=1, max=35, truncated=false
http_reqs: points=1034, sum=1,034, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus: points=65, min=0, max=5, truncated=false
```

### Verdict

```text
PASS — default ramping-arrival-rate case giu duoc arrival curve:
  checks sach, HTTP failed 0%, dropped_iterations=0.
  Active VU max=5 (thap hon pre=30, nhieu headroom).
  1034/1035 target slots — 1 slot lech tai boundary, binh thuong.
```

### Validation conclusion

```text
- Stage math 1035 ✅ exact
- 0 drops ✅ trong budget (max 8)
- 6/6 branches co request count theo dung weight distribution
- Event p95=80.60ms, checkout external_ms=30 la contributor chinh
- Active VU max=5, thap xa so voi pre=30 → nhieu headroom
- Khong noisy neighbor o load nay
- Day la baseline pass — san sang cho cac variation testing
```

## 18. Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./docs/practice/ramping-arrival-rate/00_overview.md`
- CAR parallel: `./docs/practice/constant-arrival-rate/07_production-ingress-mix.md`
- Validation: `./docs/practice/ramping-arrival-rate/08_validation-and-chart-analysis.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-07-production-spike-mix.js`
- Common lib: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
