# Case 01: Campaign Warmup Surge

> **Script:** `rar-01-campaign-warmup-surge.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Rate curve:** 2 -> 8 -> 28 -> 6 -> 0/s
> **Focus:** Products browse/detail + cart add trong campaign warmup -> surge -> recovery.

## 1. Tinh huong thuc te

### Campaign ingress: traffic khong phang

Marketing mo campaign. Traffic den tu ben ngoai he thong (CDN, mobile app,
web client) khong co dinh theo thoi gian ma bien doi theo **hinh dang curve**:

```text
Phase 1: Warmup (15s)  -- traffic bat dau tang tu 2/s len 8/s
         Nguoi dung dan nhan duoc thong bao campaign,
         mo app, browse san pham.

Phase 2: Surge  (20s)  -- traffic but pha len 28/s  <-- PEAK
         Launch window: flash sale bat dau, thong bao
         push, email campaign kich hoat dong loat.
         Day la moment quyet dinh.

Phase 3: Recovery (15s) -- traffic giam dan tu 28/s xuong 6/s
         Dot surge qua di, nguoi dung quay lai browse
         binh thuong.

Phase 4: Drain (5s)     -- traffic ve 0/s
         Campaign ket thuc, he thong tro ve idle.
```

### Ai tao ra traffic nay?

```text
CDN / API Gateway
    |
    +--> Products Service (landing page, product list)
    |
    +--> Products Service (product detail -- xem chi tiet)
    |
    +--> Cart Service    (cart add -- mua hang)
```

Khong phai "user login roi browse". Day la **ingress tu CDN**:
- Mobile app mo landing page -> `GET /products`
- User scroll, tap vao san pham -> `GET /products/:id`
- User add to cart -> `POST /cart/add`

Moi request den tu ben ngoai, doc lap voi backend dang nhanh hay cham.
No giong nhu **khach vao cua hang**: khach den theo lich campaign (push
notification, email blast, social media post), khong phai "toi thay cua
hang mo thi vao".

### Tai sao traffic ramp ma khong phang?

```text
Neu traffic phang (constant 28/s trong 55s):
  -> Khong mo phong duoc hanh vi thuc te
  -> Campaign that su co giai doan warmup (user dan nhan thong bao)
  -> Campaign that su co giai doan surge (launch window tap trung)
  -> Campaign that su co giai doan recovery (surge qua di)
  -> Test phang se PASS voi rate thap, FAIL voi rate cao -> khong
     co duoc buc tranh day du

Neu traffic ramp:
  -> Test stress o nhieu muc rate khac nhau
  -> Quan sat duoc he thong hanh vi the nao o TUNG GIAI DOAN
  -> Phat hien diem gay o rate nao (vd: warmup OK, surge drop)
  -> Giong nhu "staging test" cho campaign thuc te
```

### Hậu quả nếu ingress khong giu duoc curve

```text
Tinh huong thuc te: Campaign launch, CDN bat dau day traffic theo curve
da len lich:

  t=0s:   CDN gui 2 req/s -> backend OK
  t=10s:  CDN gui ~6 req/s -> backend OK
  t=15s:  CDN gui 8 req/s -> backend OK
  t=25s:  CDN gui ~18 req/s -> backend bat dau cham
  t=30s:  CDN gui ~24 req/s -> backend qua tai, timeout bat dau
  t=35s:  CDN gui 28 req/s -> backend 502, cart service chet
          -> user thay spinner quay mai -> tat app
          -> ~50% gio hang bi mat -> sale thieu hut
          -> marketing chi tien ads nhung conversion = 0
          -> analytics thieu data vi request drop o load balancer

Neu da test truoc voi ramping-arrival-rate:
  -> Phat hien ra la cart service khong chiu duoc 28/s
  -> Fix TRUOC campaign launch
  -> Deploy them pods, toi uu DB query, them cache layer
  -> Rerun -> pass -> deploy campaign -> ngu ngon
```

### Cau hoi kinh doanh

```text
"Products va cart service co giu duoc campaign ingress curve
 2 -> 8 -> 28 -> 6/s ma khong drop slot khong?"
```

Day khong phai la "back end co nhanh khong" hay "API co tra 200 khong".
Day la cau hoi **contract**: he thong co dap ung duoc luong ingress duoc
len lich theo campaign timeline khong?

## 2. 2 yeu cau cot loi

Case nay co **2 yeu cau cot loi** ma chi `ramping-arrival-rate` moi thoa man
duoc dong thoi.

### Yeu cau (a): GIU INGRESS CURVE THAY DOI THEO THOI GIAN

**Y nghia**: K6 phai bat dau iteration moi theo dung duong cong rate da dinh
truoc: 2/s -> 8/s -> 28/s -> 6/s -> 0/s. Khong duoc tu di chinh rate chi vi
backend dang nhanh hay cham.

**Vi du cu the**:

```text
Config: startRate=2, stages:
  { target: 8,  duration: 15s }   warmup
  { target: 28, duration: 20s }   surge / peak
  { target: 6,  duration: 15s }   recovery
  { target: 0,  duration: 5s  }   drain

Timeline 55 giay:
  t=0.00s:  slot #0 duoc schedule o rate ~2/s
  t=0.50s:  slot #1 duoc schedule
  t=1.00s:  slot #2
  ...
  t=15.0s:  slot #75  -- rate da dat 8/s
  t=15.05s: slot #76  -- rate dang tang len peak
  ...
  t=25.0s: slot ~#255 -- rate khoang 18/s (giua 8->28)
  t=30.0s: slot ~#425 -- rate khoang 23/s
  t=35.0s: slot #435 -- rate dat 28/s  <-- PEAK
  ...
  t=50.0s: slot #690 -- rate dang giam tu 28->6
  t=55.0s: slot #705 -- scenario ket thuc

Tong: 705 slots duoc schedule theo curve
```

**Diem quan trong**: Slot duoc schedule **theo duong cong**, khong dua vao
backend latency. Giong nhu:

```text
Tau dien chay theo lich trinh co san:
  - 6h-7h: 2 tau/gio   (warmup)
  - 7h-8h: 8->28 tau/gio (rush hour)
  - 8h-9h: 28->6 tau/gio (giam dan)
  Neu tau khong co lai xe -> chuyen do bi huy (= dropped_iterations)
  Nhung lich trinh khong thay doi du thieu lai xe
```

### Yeu cau (b): PHAT HIEN CONTRACT BREACH QUA dropped_iterations

**Y nghia**: Khi backend khong du capacity de xu ly arrivals o mot giai doan
nao do (dac biet la peak), test phai **bao loi ro rang** qua
`dropped_iterations`. Khong duoc "im lang pass" nhu closed model.

**Vi du cu the**:

```text
Tinh huong: Cart service bi DB lock o giay thu 28 (dang surge 24/s)

Voi ramping-vus (closed model):
  - VU loop cham hon -> throughput tu giam
  - Nhung VU tiep tuc nhung gi no dang lam
  - KHONG CO DROP -> test van PASS
  - KHONG phat hien duoc van de

Voi ramping-arrival-rate (open model):
  - Slot van den dung gio theo curve (28/s o peak)
  - Cart event cham (100ms thay vi 3ms) -> VU biem
  - Can nhieu VU hon de giu nhp -> VU pool can
  - Slot khong co worker -> dropped_iterations++
  - Test FAIL -> phat hien duoc contract breach
```

### Tai sao ca 2 yeu cau phai thoa man DONG THOI?

```text
BOX: 2 YEU CAU COT LOI
==============================================================
 (a) GIU INGRESS CURVE THEO DUNG CAMPAIGN TIMELINE
     startRate=2 -> 8 -> 28 -> 6 -> 0/s
     Slot duoc schedule theo duong cong, doc lap voi backend

 (b) PHAT HIEN CONTRACT BREACH QUA dropped_iterations
     Neu o bat ky giai doan nao, backend khong theo kip
     -> slot drop -> test FAIL

 Neu CHI co (a): rate curve dung nhung khong ai bao breach
 Neu CHI co (b): co bao loi nhung rate curve khong duoc dam bao
 Ca 2 cung co -> ramping-arrival-rate la executor DUY NHAT thoa man
==============================================================
```

## 3. Vi sao dung `ramping-arrival-rate`?

### So sanh 5 executor

Bang duoi day so sanh tat ca executor ma k6 cung cap, phan tich vi sao moi cai
**khong phu hop** cho case campaign ingress curve:

| Executor | Model | Cach hoat dong | Vi sao KHONG phu hop cho case nay? |
| --- | --- | --- | --- |
| **ramping-arrival-rate** | Open | Schedule iteration theo rate curve thay doi (startRate + stages). VU la anonymous worker pool. | **PHU HOP**: ingress curve duoc giu co dinh doc lap voi backend latency. Drop bao contract breach o tung stage. |
| constant-arrival-rate | Open | Schedule iteration theo rate CO DINH trong suot duration. | Chi giu duoc MOT rate co dinh (vd 20/s). Khong mo phong duoc curve warmup->surge->recovery. Dung cho RPS contract co dinh, khong dung cho campaign ramp. |
| ramping-vus | Closed | Tang/giam so VU theo stage. Throughput phu thuoc VU count va loop time. | VU count thay doi theo stage nhung throughput van phu thuoc latency. Backend cham -> throughput tu giam. KHONG giu duoc arrival curve. |
| constant-vus | Closed | Gi N VU chay lien tuc. Moi VU loop: gui request -> doi -> gui tiep. | Nhung throughput la OUTPUT, khong phai INPUT. Khong mo phong duoc arrival curve. Backend cham -> throughput tu giam -> che mat contract breach. |
| shared-iterations | Closed | Chia N iterations cho M VUs. VU nao xong truoc nhan iteration tiep. | Tong iteration co dinh nhung rate phu thuoc VU speed. Khong co schedule. Khong test duoc "curve 2->8->28->6/s". |
| per-vu-iterations | Closed | Moi VU chay dung K iterations. Khong chia se. | Count co dinh nhung rate khong kiem soat. Dung de regression test, khong phai ingress contract. |

### Phan tich sau: vi sao `ramping-vus` "im lang pass" la nguy hiem nhat?

Day la **anti-pattern nguy hiem nhat** ma team thuong mac phai:

```text
Config ramping-vus: start=0, stages: 15s->8, 20s->28, 15s->6

Case A: Backend khoe (response time avg = 3ms)
  VU count tang theo stage, nhung chi can 1 VU la du 28 req/s
  Test PASS -> contract curve dat

Case B: Backend yeu (response time avg = 100ms, do DB lock)
  Voi 28 VU o peak:
    Throughput = 28 / 0.100 = 280 req/s  -> van cao hon 28/s
    Test PASS (khong error, khong drop)
    NHUNG: 28 VU moi du 280 req/s neu backend 100ms.
           Neu backend cham hon nua -> throughput tu giam.
           Khong bao gio biet duoc "curve 28/s co giu duoc khong"
           vi khong co co che drop!

  => Test PASS nhung khong dam bao contract ingress curve!
  => Day la "false positive" cuc ky nguy hiem

Voi ramping-arrival-rate:
  Backend cham -> VU busy lau hon -> can them worker
  Neu VU pool du -> 0 drop -> PASS that su
  Neu VU pool thieu -> drop -> FAIL -> phat hien breach
```

### Neu dung sai executor thi...

```text
Sai: Dung ramping-vus cho campaign ingress test
  -> Van pass du backend cham
  -> Len production: CDN day traffic 28/s that -> backend 100ms
     -> can 3 VU (28 x 0.100 = 2.8), nhung production chi co 2 pod
     -> queue day -> 502 -> campaign sup
  -> Test khong phat hien duoc han che nay

Sai: Dung constant-arrival-rate rate=12/s (average)
  -> Rate co dinh 12/s trong 55s -> 660 slots
  -> PASS voi average, nhung khong test duoc peak 28/s
  -> Len production: 12/s average OK nhung peak 28/s sup
  -> Test che mat "peak khong chiu duoc" vi chi test average

Dung: ramping-arrival-rate voi curve 2->8->28->6/s
  -> Test dung hinh dang traffic campaign
  -> Phat hien duoc peak co chiu duoc khong
  -> Phat hien duoc chinh xac giai doan nao co van de
```

## 4. Config mapping

### Full env var table

Tat ca tham so deu co the override qua environment variables:

| Variable | Default | Y nghia |
| --- | ---: | --- |
| `RAR_01_START_RATE` | `2` | Arrival rate luc scenario bat dau (slot/s) |
| `RAR_01_WARM_RATE` | `8` | Rate cuoi warmup stage |
| `RAR_01_PEAK_RATE` | `28` | Rate peak campaign surge |
| `RAR_01_RECOVERY_RATE` | `6` | Rate recovery sau peak |
| `RAR_01_DURATION_SCALE` | `1` | He so scale duration (1=full, 0=smoke 1s/stage) |
| `RAR_01_PREALLOCATED_VUS` | `18` | Worker warm san truoc khi test bat dau |
| `RAR_01_MAX_VUS` | `60` | Tran worker toi da k6 duoc phep spawn |
| `RAR_01_MAX_DROPPED` | `5` | Drop budget (so slot duoc phep drop) |
| `RAR_01_USER_POOL` | `800` | Kich thuoc pool business user identity |

### Scenario config

```js
const TIME_UNIT = '1s';
const PREALLOCATED_VUS = envInt('RAR_01_PREALLOCATED_VUS', 18);
const MAX_VUS = envInt('RAR_01_MAX_VUS', 60);

export const options = {
  scenarios: {
    campaign_warmup_surge: buildRampingArrivalScenario(
      'campaignWarmupSurge', START_RATE,
      [
        { target: WARM_RATE,      duration: scaleSeconds(15, SCALE) },
        { target: PEAK_RATE,      duration: scaleSeconds(20, SCALE) },
        { target: RECOVERY_RATE,  duration: scaleSeconds(15, SCALE) },
        { target: 0,              duration: scaleSeconds(5, SCALE)  },
      ],
      TIME_UNIT, PREALLOCATED_VUS, MAX_VUS,
      {
        case_id: 'rar-01-campaign-warmup-surge',
        business_case: 'marketing_campaign_warmup_to_peak',
      }
    ),
  },
};
```

### Stage math -- duong cong arrival rate ve thanh scheduled slots

k6 su dung **linear interpolation** giua cac stage target de tinh toan
rate o tung thoi diem. Cong thuc:

```text
slots trong stage = duration_seconds x (rate_start + rate_end) / 2
```

Ap dung cho case 01:

| Stage | Duration | Rate start->end | Phep tinh | Slots |
| --- | ---: | ---: | --- | ---: |
| 1 warmup | 15s | 2 -> 8/s | (2 + 8)/2 x 15 = 5 x 15 | **75** |
| 2 surge | 20s | 8 -> 28/s | (8 + 28)/2 x 20 = 18 x 20 | **360** |
| 3 recovery | 15s | 28 -> 6/s | (28 + 6)/2 x 15 = 17 x 15 | **255** |
| 4 drain | 5s | 6 -> 0/s | (6 + 0)/2 x 5 = 3 x 5 | **15** |
| **Total** | **55s** | | | **705** |

Cach doc bang:

```text
- Stage 1 warmup (15s): rate tang tuyen tinh tu 2/s -> 8/s.
  Trung binh rate = 5/s x 15s = 75 slot.
  Day la luc "nguoi dung bat dau nhan duoc thong bao".

- Stage 2 surge (20s): rate tang tuyen tinh tu 8/s -> 28/s.
  Trung binh rate = 18/s x 20s = 360 slot.
  DAY LA GIAI DOAN QUAN TRONG NHAT.
  Peak 28/s xuat hien o cuoi stage (giay 30-35).

- Stage 3 recovery (15s): rate giam tuyen tinh tu 28/s -> 6/s.
  Trung binh rate = 17/s x 15s = 255 slot.
  Traffic giam dan sau peak.

- Stage 4 drain (5s): rate giam tu 6/s -> 0/s.
  Trung binh rate = 3/s x 5s = 15 slot.
  Scenario ket thuc "sach" khong slot treo.

- Tong = 75 + 360 + 255 + 15 = 705 slots.
```

**Validation tu run that**:

```text
Run ngay 2026-06-21, default env:
  iterations = 705
  dropped_iterations = 0
  705 + 0 = 705 -> khop chinh xac target 705 slots
```

### Vi sao preAllocatedVUs = 18?

```text
Day la "safe margin" cho ingress curve:

- Voi event duration trung binh ~4ms (p95 = 5ms):
  O peak 28/s: VU can = ceil(28 x 0.005) = 1 VU
  O warmup 8/s: VU can = ceil(8 x 0.004) = 1 VU

- Vay 18 preAllocatedVUs la "thua" so voi nhu cau thuc te?
  DUNG -- nhung day la BUFFER an toan:
  - Cold start: VU spawn, connection pool init
  - Latency spike: neu p95 tang dot ngot len 100ms
    -> VU can = ceil(28 x 0.100) = 3 VU -> van du
  - Neu backend that su cham (500ms/event):
    -> VU can = ceil(28 x 0.500) = 14 VU -> van trong preAllocated

- maxVUs = 60: tran cao gap 3.3 lan preAllocated
  -> Cho phep mo rong gap 3.3 lan neu backend xuong cap
  -> Neu 60 VU van khong du -> drop -> test FAIL -> biet duoc
     "campaign nay can nhieu hon 60 VU de giu curve"
```

## 5. Identity model deep-dive

Hieu sai identity model la nguyen nhan #1 dan den doc sai output. Phan nay giai
thich tung identity trong `ramping-arrival-rate`.

### Cac identity trong k6

| Identity | Y nghia | Ai gan? | Thay doi khi nao? |
| --- | --- | --- | --- |
| `__VU` | Virtual User - worker thread | k6 engine | Khoi tao 1 lan, ton tai den het test |
| `__ITER` | Iteration counter toan cuc | k6 engine | Tang moi lan BAT DAU iteration moi |
| `exec.scenario.iterationInTest` | Slot index cua iteration HIEN TAI trong toan bo test | k6 engine | Moi iteration co 1 gia tri rieng |
| `exec.vu.idInTest` | ID cua VU hien tai trong test | k6 engine | Co dinh cho moi VU |
| `exec.scenario.iterationInInstance` | Slot index trong instance HIEN TAI cua VU | k6 engine | Reset khi VU bi destroy va tao lai |
| `userContext.userId` | Business user identity | Script (common.js) | Tu `iterationInTest % USER_POOL` |
| `userContext.abVariant` | A/B test variant | Script (common.js) | Tu `iterationInTest % 2` |

### __VU la anonymous worker (khong phai business user)

Day la **sai lam co ban nhat** khi doc `ramping-arrival-rate`:

```text
SAI: "__VU la nguoi dung, 18 preAllocatedVUs = 18 user dang browse"
DUNG: "__VU la worker thread nhan slot tu scheduler.
        Moi VU co the phuc vu HANG TRAM user khac nhau."
```

### userContext() -- identity mapping trong case 01

Code tu `common.js`:

```js
export function userContext(seed = 'ramping-arrival', userPool = 1000) {
  const iteration = exec.scenario.iterationInTest;  // slot index TOAN CUC
  const pool = Math.max(1, userPool);
  const userNumber = (iteration % pool) + 1;        // user luan phien theo slot
  return {
    seed,
    vuId: exec.vu.idInTest,                         // CHI la worker id
    iter: iteration,                                 // slot index
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `rar-user-${userNumber}`,                // business user TU SLOT
    requestKey: `${seed}-${iteration}-${exec.vu.idInTest}`,
    abVariant: iteration % 2 === 0 ? 'b' : 'a',
  };
}
```

**He qua quan trong**:

```text
- userId = rar-user-N duoc gan tu iterationInTest % USER_POOL
  -> userId phu thuoc SLOT, khong phu thuoc VU
  -> VU #5 co the phuc vu user-1, user-100, user-500... tuy slot no nhan

- vuId CHI la worker id, khong co y nghia business
  -> Khong the noi "VU #3 la user so 3"
  -> Khong the noi "user-42 luon duoc VU #7 phuc vu"

- userPool = 800: identity pool co 800 user name
  -> 705 slot -> user chay tu rar-user-1 den rar-user-705
  -> Khong can user name that vi day la LOAD TEST
```

### Trace identity qua 10 slot dau tien

```text
Slot  | iterInTest | userId       | VU nhan  | Branch     | abVariant
------|------------|--------------|----------|------------|----------
#0    | 0          | rar-user-1   | VU #1    | landing    | b
#1    | 1          | rar-user-2   | VU #2    | landing    | a
#2    | 2          | rar-user-3   | VU #3    | landing    | b
#3    | 3          | rar-user-4   | VU #1    | cart_add   | a
#4    | 4          | rar-user-5   | VU #4    | landing    | b
#5    | 5          | rar-user-6   | VU #2    | detail     | a
#6    | 6          | rar-user-7   | VU #5    | landing    | b
#7    | 7          | rar-user-8   | VU #3    | landing    | a
#8    | 8          | rar-user-9   | VU #1    | landing    | b
#9    | 9          | rar-user-10  | VU #6    | detail     | a

Nhan xet:
  - VU #1 da xu ly slot #0, #3, #8 -> phuc vu user-1, user-4, user-9
  - userId tang tuan tu: user-1, user-2, ..., user-10
  - VU assignment: AI RANH THI NHAN, khong theo pattern co dinh
  - Branch: deterministic tu weightedPick(iterationInTest)
```

### VU "nhay" qua cac user -- minh hoa cho 1 VU

```text
Timeline cua VU #7 trong 55s (preAllocated, san sang luc t=0):

t=0.000s: VU #7 san sang
t=0.000s: slot #0 den -> VU #7... khong nhan (VU #1 nhan)
t=0.050s: slot #1 den -> VU #7 nhan -> chay event landing
           -> userId = rar-user-2 -> 3ms -> xong -> VU #7 idle
t=0.150s: slot #3 den -> VU #7 nhan -> chay event cart_add
           -> userId = rar-user-4 -> 3ms -> xong
t=0.350s: slot #7 den -> VU #7 nhan -> chay event landing
           -> userId = rar-user-8 -> 3ms -> xong
...
t=30.00s: slot #425 den -> VU #7 nhan -> chay event detail
           -> userId = rar-user-426 -> 3ms -> xong
...
t=54.95s: slot #704 den -> VU #7 nhan -> chay event landing
           -> userId = rar-user-705 -> 3ms -> xong

VU #7 da phuc vu khoang 705/18 ~ 39 user KHAC NHAU trong 55s.
Moi user duoc phuc vu trong 1 event (~3-5ms).
VU #7 khong "nho" user nao het.
```

### Vi sao userId = rar-user-N (khong phai ten that)?

```text
Day la LOAD TEST, khong phai functional test:

- Functional test: "User alice@example.com login, browse, checkout"
  -> Can identity that, session that, data that

- Load test: "Campaign traffic curve 2->8->28->6/s"
  -> Chi can identity de:
     a) Phan biet request trong log/server-side tracing
     b) Mo phong cache hit/miss pattern (user quay lai)
     c) Tranh rate limiting (neu server limit per-user)
  -> Khong can user "that"

- rar-user-N format:
  -> De doc, de loc, de trace trong log
  -> N chay tu 1 den 705 cho 705 slot
  -> Quay lai user-1 sau 800 slot (pool size) -- khong xay ra
     trong test 55s vi 705 < 800
```

## 6. Open model deep-dive

Day la phan quan trong nhat de hieu **tai sao** `ramping-arrival-rate` hoat dong
khac biet so voi closed model -- va tai sao **peak rate quyet dinh VU sizing**,
khong phai average rate.

### Open model vs Closed model: dinh nghia lai

```text
CLOSED MODEL (ramping-vus, constant-vus, shared-iterations, per-vu-iterations):
  - So luong VU co dinh (hoac thay doi theo stage)
  - Moi VU hoan thanh 1 viec -> bat dau viec tiep
  - Throughput = f(so VU, thoi gian moi viec) = OUTPUT
  - He thong tu "throttle" khi qua tai: VU cham -> throughput giam
  - Giong nhu: day chuyen san xuat voi N cong nhan

OPEN MODEL (ramping-arrival-rate, constant-arrival-rate):
  - Arrival rate tu ben ngoai co dinh (hoac thay doi theo curve)
  - VU chi la tai nguyen de xu ly arrivals
  - Throughput target = arrival rate = INPUT
  - He thong KHONG tu throttle: arrival van den, neu khong xu ly kip -> drop
  - Giong nhu: quay checkout voi khach den theo lich co dinh
```

### Rate curve -> scheduled slots -> VU requirement

Trong `ramping-arrival-rate`, VU demand khong co dinh trong suot test. No thay
doi theo **tung giai doan** cua curve:

```text
VU can thiet o moi giai doan = ceil(current_rate x W_effective)

Trong do:
  current_rate = rate o thoi diem do (thay doi theo stage)
  W_effective = thoi gian trung binh moi event

Rate VA W cung thay doi:
  - Rate: tang/giam theo stage (2 -> 28/s)
  - W: co the thay doi neu branch mix thay doi hoac backend latency thay doi
```

### Vi sao peak rate (28/s) quyet dinh VU sizing, KHONG PHAI average rate?

**Day la nguyen ly quan trong nhat cua ramping-arrival-rate:**

```text
Average rate cua case 01:
  total_slots / total_duration = 705 / 55 = 12.82/s

NEU dung average rate de tinh VU:
  VU can = ceil(12.82 x 0.005) = ceil(0.064) = 1 VU
  -> 1 VU la DU? KHONG!
  -> Vi o peak 28/s, 1 VU chi xu ly duoc 1/0.005 = 200 events/s
     -> Van du. Nhung neu W = 50ms:
     -> 1 VU chi xu ly duoc 20 events/s
     -> O peak 28/s: can ceil(28 x 0.050) = 2 VU
     -> O warmup 8/s: can ceil(8 x 0.050) = 1 VU
  -> Dung average rate che mat peak demand!

DUNG PEAK RATE de tinh VU:
  VU can o peak = ceil(28 x W_peak)

  Voi W = 4ms: ceil(28 x 0.004) = 1 VU -> de dang
  Voi W = 50ms: ceil(28 x 0.050) = 2 VU -> van de
  Voi W = 100ms: ceil(28 x 0.100) = 3 VU -> van de
  Voi W = 500ms: ceil(28 x 0.500) = 14 VU -> can nhieu worker
  Voi W = 2000ms: ceil(28 x 2.0) = 56 VU -> gan chạm maxVUs=60!
```

### Stage-by-stage VU demand calculation

Ap dung cho tung stage cua case 01, voi W = 5ms (p95 thuc te):

| Stage | Rate range | Rate max (cuoi stage) | VU can (W=5ms) | VU can (W=50ms) | VU can (W=500ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 warmup | 2 -> 8/s | 8 | ceil(8x0.005)=1 | ceil(8x0.05)=1 | ceil(8x0.5)=4 |
| 2 surge | 8 -> 28/s | **28** | ceil(28x0.005)=1 | ceil(28x0.05)=2 | ceil(28x0.5)=**14** |
| 3 recovery | 28 -> 6/s | 28 (dau stage) | 1 | 2 | 14 -> 3 |
| 4 drain | 6 -> 0/s | 6 | 1 | 1 | 3 -> 0 |

```text
Nhan xet quan trong:
  - Stage 2 (surge) la stage DINH VI VU pool size
  - VU can o stage 2 gap 3.5 lan stage 1 (voi W=500ms)
  - Neu preAllocatedVUs = 14 o W=500ms -> vua du o peak
    Nhung o W=4ms, 14 la thua rat nhieu
  - CONFIG AN TOAN: pre=18, max=60
    -> W=500ms: pre=18 > can=14 -> OK
    -> W=2000ms: can=56 < max=60 -> vua du, can than
    -> W=3000ms: can=84 > max=60 -> drop!
```

### Dieu gi xay ra khi VU pool khong du o tung stage?

```text
KHAC BIET QUAN TRONG voi constant-arrival-rate:
  Trong CAR, rate co dinh -> drop co dinh (neu pool khong du)
  Trong RAR, rate thay doi -> drop THAY DOI THEO STAGE

Stage 1 warmup (rate 2->8/s, W=500ms):
  VU can = 4
  preAllocated=18 -> DU -> 0 drop

Stage 2 surge (rate 8->28/s, W=500ms):
  VU can = 14 o cuoi stage
  preAllocated=18 -> DU -> 0 drop

Stage 2 surge (rate 8->28/s, W=2000ms):
  VU can = 56 o cuoi stage
  maxVUs=60 -> vua du -> 0 drop (neu spawn kip)
  Neu spawn khong kip -> drop xuat hien o CUOI stage 2

Stage 2 surge (rate 8->28/s, W=3000ms):
  VU can = 84 o cuoi stage
  maxVUs=60 -> thieu 24
  Drop bat dau khi activeVUs cham 60
  Drop RATE tang dan theo rate tang:
    - Luc rate = 20/s: can 60 VU -> cham tran -> bat dau drop
    - Luc rate = 28/s: can 84 > 60 -> drop 24/s
  -> DROP TAP TRUNG O CUOI STAGE 2 (peak)

Stage 3 recovery (rate 28->6/s, W=3000ms):
  VU can giam dan tu 84 -> 18
  maxVUs=60 -> van thieu o dau stage 3 (28/s -> can 84)
  Nhung rate giam dan -> can giam -> drop giam dan -> ve 0

=> Hinh dang drop: bat dau o cuoi stage 2, peak o dau stage 3,
   giam dan ve 0 o cuoi stage 3.
=> VI TRI DROP cho biet stage nao la bottleneck!
```

### Cong thuc toan hoc cho open model ramp

```text
Ky hieu:
  r(t) = rate o thoi diem t (linear interpolation giua stage targets)
  W = event duration trung binh
  M = so VU hien co

VU can o thoi diem t:
  required_vus(t) = ceil(r(t) x W)

Drop rate o thoi diem t:
  drop_rate(t) = max(0, r(t) - capacity(t))
               = max(0, r(t) - M / W)

Tong drop trong stage [t1, t2]:
  total_drop = integral_t1^t2 max(0, r(t) - M/W) dt

Voi linear ramp: r(t) = r1 + (r2 - r1) x (t - t1) / (t2 - t1):
  Neu M/W >= r2 (VU du cho peak): total_drop = 0
  Neu M/W < r2: drop bat dau tai t* khi r(t*) = M/W
    -> drop tap trung o cuoi stage, noi rate cao nhat
```

### Run thuc te: tai sao 0 drop?

```text
Run ngay 2026-06-21:
  W_effective ~ 0.005s (p95 = 5ms)
  Peak rate = 28/s

  VU can o peak: ceil(28 x 0.005) = ceil(0.14) = 1 VU
  preAllocated = 18 -> DU THUA (18 >> 1)
  maxVUs = 60 -> TRAN RAT CAO

  -> 0 drop la HOAN TOAN DU KIEN
  -> Test khong phat hien bottleneck vi backend QUÁ NHANH
  -> Day la "baseline khoe manh"
  -> De thay drop, can tang W (vd them delay/slow query)
     hoac giam VU pool (vd pre=2, max=4)
```

## 7. Service/API flow

Case 01 co 3 branch, moi arrival event chay DUNG 1 API call theo
**deterministic weighted pick**.

### Branch selection code

```js
export function campaignWarmupSurge(data = {}) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const productId = (ctx.iter % 50) + 1;
  const choice = weightedPick([
    { name: 'landing',  weight: 55 },
    { name: 'detail',   weight: 30 },
    { name: 'cart_add', weight: 15 },
  ], ctx.iter);
  // ...
}
```

Co che `weightedPick` tu `common.js`:

```js
export function weightedPick(items, n) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const pick = n % total;
  let cursor = 0;
  for (const item of items) {
    cursor += item.weight;
    if (pick < cursor) return item.name;
  }
  return items[items.length - 1].name;
}
```

### Bang phan bo branch theo iteration

Trong moi block 100 iteration (total weight = 55+30+15 = 100):

| Iteration | pick = iter % 100 | Branch | Weight range |
| ---: | ---: | --- | ---: |
| 0-54 | 0-54 | landing | 0-54 (55 so) |
| 55-84 | 55-84 | detail | 55-84 (30 so) |
| 85-99 | 85-99 | cart_add | 85-99 (15 so) |

Voi 705 iteration:

```text
  landing:  55% x 705 = 387.75 ~ 388 (thuc te: 390)
  detail:   30% x 705 = 211.5  ~ 212 (thuc te: 210)
  cart_add: 15% x 705 = 105.75 ~ 106 (thuc te: 105)
```

### 3 API endpoints

| Branch | Weight | Service | Method | Endpoint | Query params | Simulated cost |
| --- | ---: | --- | --- | --- | --- | ---: |
| landing | 55% | products-service | GET | `/api/sim/products` | `limit=12&sort=popular&view=grid&campaign=flash&cpu_ms=2&db_rows=3&gzip_kb=2` | DB 3 rows + CPU 2ms + GZIP 2KB |
| detail | 30% | products-service | GET | `/api/sim/products/:id` | `view=full&include_reviews=1&cpu_ms=2&db_rows=2` | DB 2 rows + CPU 2ms |
| cart_add | 15% | cart-service | POST | `/api/sim/cart/add` | `cpu_ms=1&db_writes=1&memory_kb=4` | DB 1 write + CPU 1ms + Memory 4KB |

### Code trace cho tung branch

**Branch 1: Landing (55%)**:

```js
if (choice === 'landing') {
  result = requestJson('GET',
    `${BASE_URL}/api/sim/products?limit=12&sort=popular&view=grid&campaign=flash&cpu_ms=2&db_rows=3&gzip_kb=2`,
    null, {
      caseId: 'rar-01-campaign-warmup-surge',
      service: 'products-service',
      operation: 'campaign_surge_landing',
      endpoint: 'GET /api/sim/products',
      userId: ctx.userId,
    });
}
```

**Branch 2: Detail (30%)**:

```js
} else if (choice === 'detail') {
  result = requestJson('GET',
    `${BASE_URL}/api/sim/products/${productId}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
    null, {
      caseId: 'rar-01-campaign-warmup-surge',
      service: 'products-service',
      operation: 'campaign_surge_detail',
      endpoint: 'GET /api/sim/products/:id',
      userId: ctx.userId,
    });
}
```

**Branch 3: Cart add (15%)**:

```js
} else {
  result = requestJson('POST',
    `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4`,
    { product_id: productId, quantity: 1 }, {
      caseId: 'rar-01-campaign-warmup-surge',
      service: 'cart-service',
      operation: 'campaign_surge_cart_add',
      endpoint: 'POST /api/sim/cart/add',
      userId: ctx.userId,
    });
}
```

### Flow diagram

```text
+---------------------------------------------------+
|        ARRIVAL EVENT (1 slot = 1 event)            |
+---------------------------------------------------+
|  1. userContext(data.seed, USER_POOL=800)          |
|     -> userId = rar-user-{N}                        |
|     -> abVariant = 'a' hoac 'b'                     |
|     -> vuId = exec.vu.idInTest                     |
|                                                    |
|  2. productId = (iter % 50) + 1  (tu 1 den 50)     |
|                                                    |
|  3. weightedPick (55% landing, 30% detail,          |
|                   15% cart_add)                     |
|     +-- landing (55%) --------------------------+  |
|     |  GET /api/sim/products                     |  |
|     |    ?limit=12&sort=popular&view=grid        |  |
|     |    &campaign=flash&cpu_ms=2&db_rows=3      |  |
|     |    &gzip_kb=2                              |  |
|     |  tags:                                     |  |
|     |    service: products-service               |  |
|     |    operation: campaign_surge_landing       |  |
|     |    endpoint: GET /api/sim/products         |  |
|     +-------------------------------------------+  |
|     +-- detail (30%) ---------------------------+  |
|     |  GET /api/sim/products/{productId}         |  |
|     |    ?view=full&include_reviews=1            |  |
|     |    &cpu_ms=2&db_rows=2                    |  |
|     |  tags:                                     |  |
|     |    service: products-service               |  |
|     |    operation: campaign_surge_detail        |  |
|     |    endpoint: GET /api/sim/products/:id     |  |
|     +-------------------------------------------+  |
|     +-- cart_add (15%) -------------------------+  |
|     |  POST /api/sim/cart/add                    |  |
|     |    { product_id, quantity: 1 }             |  |
|     |    ?cpu_ms=1&db_writes=1&memory_kb=4      |  |
|     |  tags:                                     |  |
|     |    service: cart-service                   |  |
|     |    operation: campaign_surge_cart_add      |  |
|     |    endpoint: POST /api/sim/cart/add        |  |
|     +-------------------------------------------+  |
|                                                    |
|  4. finishEvent(started, result.ok, tags)          |
|     -> ramping_arrival_events_total += 1            |
|     -> ramping_arrival_event_duration_ms add        |
|     -> neu !ok: ramping_arrival_events_failed++     |
+---------------------------------------------------+
```

### Product ID rotation

```js
const productId = (ctx.iter % 50) + 1;
```

```text
Product ID xoay vong 1->50 moi 50 iteration:
  iter=0:  productId=1
  iter=1:  productId=2
  iter=49: productId=50
  iter=50: productId=1  (quay lai)

Voi 705 iteration: moi product ID xuat hien 705/50 ~ 14 lan
```

### Counter reconciliation

```text
Case 01: 1 event = 1 API call -> moi counter deu bang nhau neu 0 drop

Voi 705 slot, 0 drop, 0 fail:
  iterations                            = 705
  http_reqs                             = 705  (1 request/event)
  ramping_arrival_events_total          = 705  (1 finishEvent/event)
  ramping_arrival_api_calls_total       = 705  (1 API call/event)
  ramping_arrival_events_failed         = 0

Run that: 705 iter, 705 http_reqs, checks=100% -> khop hoan hao
```

## 8. Metrics & tags deep-dive

### Custom metrics (tu common.js)

#### `ramping_arrival_events_total` (Counter)

```text
Loai: Counter
Khi nao tang: Moi lan finishEvent() duoc goi
Tags: case_id, service, operation, user_id
Y nghia: Tong so arrival event DA HOAN THANH

Voi case 01:
  - Moi event goi finishEvent() dung 1 lan
  - Counter ~ iterations (neu khong crash)

Cach doc:
  - events_total ~ iterations -> flow binh thuong
  - events_total < iterations -> co event khong finish (crash)
```

#### `ramping_arrival_events_failed` (Counter)

```text
Loai: Counter
Khi nao tang: finishEvent() voi ok=false
Tags: case_id, service, operation, user_id
Y nghia: So event co IT NHAT 1 API call that bai

Threshold: count < 20
Run that: 0 -> tat ca event thanh cong
```

#### `ramping_arrival_api_calls_total` (Counter)

```text
Loai: Counter
Khi nao tang: Moi lan requestJson() goi HTTP
Tags: case_id, service, operation, endpoint, user_id
Y nghia: Tong so HTTP call

Voi case 01 (1 call/event):
  api_calls_total ~ http_reqs ~ iterations
```

#### `ramping_arrival_event_duration_ms` (Trend)

```text
Loai: Trend (percentiles)
Khi nao ghi: finishEvent() tinh Date.now() - startedAt
Tags: case_id, service, operation, user_id
Y nghia: Thoi gian end-to-end cua 1 event (tu VU nhan slot den finish)

Run that: avg=3.64ms, med=3ms, p95=5ms, p99=6ms, max=18ms

Day la metric QUAN TRONG NHAT de uoc tinh VU demand:
  VU can ~ ceil(current_rate x p95_event_duration)
```

### k6 built-in metrics lien quan

| Metric | Loai | Y nghia | Muc do quan trong | Run that value |
| --- | --- | --- | --- | ---: |
| `dropped_iterations` | Counter | Slot den gio nhung khong co VU ranh | **CRITICAL** -- PRIMARY signal | 0 |
| `iterations` | Counter | Tong iteration hoan thanh | Cao -- reconcile target | 705 |
| `http_reqs` | Counter | Tong HTTP request | Cao -- so sanh voi iterations | 705 |
| `http_req_duration` | Trend | Thoi gian HTTP request | Cao -- compare voi event duration | p95=4.27ms |
| `http_req_failed` | Rate | Ti le HTTP fail | Cao -- threshold | 0% |
| `checks` | Rate | Ti le check pass | Cao -- threshold | 100% |
| `vus` | Gauge | Active VU sampled | Trung binh -- capacity signal | max=1 |
| `vus_max` | Gauge | VU envelope max | Thap -- da hieu dung | 18 |
| `iterations_rate` | Rate | Completed iteration/s | Thap -- average tren duration | 12.82/s |

### Tags deep-dive

Moi metric duoc gan tags de loc va phan tich:

| Tag | Nguon | Gia tri vi du | Muc dich |
| --- | --- | --- | --- |
| `case_id` | script | `rar-01-campaign-warmup-surge` | Loc metric theo case |
| `service` | requestJson | `products-service`, `cart-service` | Nhom theo service |
| `operation` | requestJson + finishEvent | `campaign_surge_landing`, `campaign_surge_detail`, `campaign_surge_cart_add` | Phan biet API operation |
| `endpoint` | requestJson | `GET /api/sim/products`, `GET /api/sim/products/:id`, `POST /api/sim/cart/add` | Route pattern |
| `user_id` | userContext | `rar-user-1`, `rar-user-42` | Trace per-user |
| `executor_family` | buildRampingArrivalScenario | `ramping_arrival_rate` | Nhom test theo executor |
| `workload_shape` | buildRampingArrivalScenario | `ramping_ingress_rate` | Phan loai workload |
| `business_case` | buildRampingArrivalScenario | `marketing_campaign_warmup_to_peak` | Muc dich business |

### Luu y: tag tren request vs event metrics

```text
request-level metrics (http_req_*, ramping_arrival_api_calls_total):
  Co tag: case_id, service, operation, endpoint, user_id

event-level metrics (ramping_arrival_events_*, ramping_arrival_event_duration_ms):
  Co tag: case_id, service, operation, user_id
  KHONG co endpoint -> vi 1 event chi co 1 call trong case 01,
  nhung trong case nhieu call (rar-04), event khong the gan 1 endpoint
```

### Cach reconcile counters

```text
Step 1: Kiem tra iterations va dropped_iterations
  iterations + dropped + interrupted ~ scheduled_slots = 705

Step 2: Kiem tra events_total va iterations
  ramping_arrival_events_total ~ iterations (= 705)

Step 3: Kiem tra api_calls_total va http_reqs
  ramping_arrival_api_calls_total ~ http_reqs (= 705)

Step 4: Kiem tra events_failed
  ramping_arrival_events_failed = 0 -> PASS

Step 5: Kiem tra branch breakdown
  390 landing + 210 detail + 105 cart_add = 705
  Ty le: 55.3% / 29.8% / 14.9% ~ 55/30/15
```

## 9. Pass criteria

### Threshold table

| Threshold | Dieu kien | Y nghia | Run that | Pass? |
| --- | --- | --- | ---: | --- |
| `checks` | `rate > 0.98` | >98% checks pass | 100% | PASS |
| `http_req_failed` | `rate < 0.02` | <2% HTTP fail | 0% | PASS |
| `dropped_iterations` | `count <= 5` | Toi da 5 slot drop | 0 | PASS |
| `ramping_arrival_events_failed` | `count < 20` | <20 event fail | 0 | PASS |

### Phan tich tung threshold

#### checks > 0.98

```text
Check trong case 01: kiem tra HTTP status = 200 (expectedStatus)

Voi 705 request:
  - Pass neu >= 691 request co status 200
  - Cho phep toi da 14 request fail status check

Tai sao khong phai 1.0?
  - Network hiccup, TCP reset, transient error -> khong tranh duoc
  - 2% la industry standard cho HTTP API threshold
  - Nhung threshold chinh cho contract la dropped_iterations
```

#### dropped_iterations <= MAX_DROPPED (= 5)

```text
Day la threshold QUAN TRONG NHAT cho ingress curve case.

maxDropped = 5 cho phep toi da 5/705 = 0.7% slot bi drop.
Day la "drop budget" nho cho campaign ingress.

Tai sao khong phai 0?
  - Campaign thuc te co the chap nhan vai slot drop o peak
  - 5 drop tren 705 slot la 0.7% -> chap nhan duoc
  - Neu muon strict contract -> set MAX_DROPPED=0

Run that: dropped_iterations=0 -> pass de dang.
```

### PASS co nghia gi trong business terms?

```text
PASS (Run 2026-06-21):
  - 705/705 campaign slots duoc xu ly -> ingress curve giu 100%
  - 0 drop -> VU pool du capacity o TAT CA cac stage
  - 100% checks -> tat ca 3 API endpoints hoat dong
  - 0% HTTP fail -> khong request nao bi timeout/refused
  - p95=5ms -> latency rat thap, margin an toan cao

=> "Products + Cart service chiu duoc campaign curve 2->8->28->6/s
    trong moi truong local, vo-i event p95=5ms."
```

### FAIL co nghia gi trong business terms?

```text
FAIL (vi du neu dropped_iterations = 20 > maxDropped = 5):
  - 20/705 = 2.8% slot bi drop
  - He thong KHONG giu duoc ingress curve day du
  - Nguyen nhan: VU pool khong du o mot giai doan nao do
  - Can dieu tra: stage nao bi drop? peak? recovery?

=> "Campaign ingress curve KHONG dat. Can tang VU pool hoac
    toi uu backend truoc khi launch campaign."
```

## 10. Cach chay + output 5 buoc

### Full run (local + dashboard)

```powershell
cd "E:\Khoa hoc\k6"

# Set environment
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

# Chay voi summary export
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
```

### Run khong co dashboard (local only)

```powershell
$env:BASE_URL = "http://localhost:80"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"
```

### Smoke test nhanh (scale=0.1, moi stage 1s)

```powershell
$env:RAR_01_DURATION_SCALE = "0"   # envInt + scaleSeconds -> moi stage 1s
$env:RAR_01_PEAK_RATE = "8"
$env:RAR_01_PREALLOCATED_VUS = "4"
$env:RAR_01_MAX_VUS = "12"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

# Xoa override sau smoke
Remove-Item Env:RAR_01_DURATION_SCALE, Env:RAR_01_PEAK_RATE, Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Smoke config khac full run:
  - scale=0 -> scaleSeconds(15,0) = "1s", scaleSeconds(20,0) = "1s", ...
  - Tong duration: 4 x 1s = 4s (thay vi 55s)
  - Peak rate: 8/s (thay vi 28/s)
  - preAllocatedVUs: 4 (thay vi 18)
  - maxVUs: 12 (thay vi 60)

Muc dich: xac nhan script chay duoc, ket noi backend OK, khong loi syntax
```

### Output 5 buoc doc

#### Buoc 1: Header -- xac nhan config

```text
execution: local
  script: ...\rar-01-campaign-warmup-surge.js
  output: cloud (http://localhost:18080)

scenarios: (100.00%) 1 scenario, 60 max VUs, 1m25s max duration
  campaign_warmup_surge: ramping-arrival-rate, 2.00 iterations/s startRate

Checklist:
  [ ] executor = ramping-arrival-rate (KHONG PHAI ramping-vus)
  [ ] startRate = 2/s
  [ ] stages: 15s, 20s, 15s, 5s
  [ ] max VUs = 60
  [ ] preAllocatedVUs = 18
```

#### Buoc 2: Expected slots -- tinh toan target

```text
Cong thuc: slots = duration x (rate_start + rate_end)/2 cho moi stage

Stage 1: 15 x (2+8)/2   = 75
Stage 2: 20 x (8+28)/2  = 360
Stage 3: 15 x (28+6)/2  = 255
Stage 4: 5 x (6+0)/2    = 15
Total:                   705

Day la CON SO MUC TIEU. Moi phan tich sau do xoay quanh 705.
```

#### Buoc 3: Summary counts -- doc iteration va drop

```text
Run that:
  iterations: 705
  http_reqs: 705
  dropped_iterations: 0
  checks: 100% (705/705 passed)
  http_req_failed: 0%

Kiem tra:
  [ ] iterations ~ 705?
  [ ] dropped_iterations = 0?
  [ ] iterations + dropped ~ 705?

Neu iterations = 705, dropped = 0 -> tat ca slot da duoc xu ly
```

#### Buoc 4: Custom metrics -- reconcile event counters

```text
Run that:
  ramping_arrival_events_total: 705
  ramping_arrival_events_failed: 0
  ramping_arrival_api_calls_total: 705
  ramping_arrival_event_duration_ms: avg=3.64ms, p95=5ms

Reconcile:
  [ ] events_total (705) ~ iterations (705)?
  [ ] api_calls_total (705) ~ http_reqs (705)?
  [ ] events_failed (0) = 0?
  [ ] p95 event duration < 100ms? (5ms -> RAT THAP)

Branch breakdown:
  [ ] landing 55% x 705 = 388 (thuc te: 390)
  [ ] detail  30% x 705 = 212 (thuc te: 210)
  [ ] cart_add 15% x 705 = 106 (thuc te: 105)
```

#### Buoc 5: Business conclusion -- ra quyet dinh

```text
Run 2026-06-21:
  Target: 705 arrivals theo curve 2->8->28->6->0/s
  Actual: 705 iterations, 0 drop, 0 fail, p95=5ms

  => PASS: Products + Cart service giu duoc campaign ingress curve
           trong 55s voi margin an toan cao (p95=5ms, can ~1 VU
           nhung co pre=18, max=60).
```

## 11. Dashboard 3-chart reading guide

### Chart 1: Response time

**Mo ta**: Bieu do hien thi p95/p99/http_req_duration theo thoi gian.

**Ky vong cho case 01**:

```text
Run that:
  - p95 on dinh o ~4ms suot 55s
  - Khong co spike dot ngot
  - p99 co the cao hon (6-8ms) nhung khong leo thang
  - Khong co pattern "tang dan" (memory leak, cache degradation)
```

**Nhung gi can tim**:

```text
1. Branch latency khac biet:
   - Filter theo operation: landing vs detail vs cart_add
   - cart_add co db_writes=1 -> co the cham hon landing (chi read)
   - Detail co include_reviews=1 -> co the cham hon landing co ban

2. Latency thay doi theo stage:
   - Warmup (rate thap): latency co the thap
   - Peak (rate cao): latency co the tang do resource pressure
   - Neu latency tang ro o peak stage -> dau hieu system qua tai

3. Spike o giai doan chuyen stage:
   - Khi rate thay doi dot ngot (stage boundary) -> co the co GC spike
   - Binh thuong neu nho (< 2x baseline) va tai tao nhanh

4. Cart add p95 cao bat thuong:
   - cart-service la write path -> nhan DB lock, flush
   - Neu cart p95 cao gap 5-10x landing -> cart service can toi uu
```

**Run that analysis**:

```text
p95 = 5ms cho TOAN BO cac branch:
  - Backend products + cart service deu rat nhanh
  - CPU + DB + GZIP deu nhe (cpu_ms=1-2, db_rows=2-3, db_writes=1)
  - Day la baseline ly tuong
```

### Chart 2: Execution timeline (iterations va http_reqs)

**Mo ta**: Bieu do hien thi iterations/s va http_reqs/s theo thoi gian (bucket).

**Ky vong cho case 01**:

```text
Run that:
  - iterations/s BAM THEO CURVE: tang tu ~2/s -> ~8/s -> ~28/s -> ~6/s -> 0
  - http_reqs/s trung voi iterations/s (vi 1 call/event)
  - Ca 2 duong gan nhu chong khit len nhau

DAY LA DIEM DAC BIET CUA RAMPLING-ARRIVAL-RATE:
  Execution timeline CO HINH DANG CURVE, khong phang nhu CAR.
```

**Nhung gi can tim**:

```text
1. Iterations/s thap hon expected o peak stage:
   -> dropped_iterations > 0 -> VU pool khong du
   -> hoac backend cham lam iteration keo dai qua bucket boundary

2. Iterations/s = 0 o 1-2 bucket dau:
   -> Cold start, VU dang spawn
   -> Binh thuong (ke ca voi preAllocated=18)

3. http_reqs/s < iterations/s:
   -> Mot so iteration khong goi HTTP -> bug script
   -> KHONG xay ra trong case 01

4. http_reqs/s > iterations/s:
   -> Mot so iteration goi nhieu hon 1 HTTP -> khong xay ra case 01
   -> Xay ra trong case 04 (3 calls/event)

5. Duong curve khong muot:
   -> Bucket boundary cat ngang iteration -> count bi lech
   -> Dung summary total, khong dung chart bucket count
```

**Run that analysis**:

```text
iterations/s va http_reqs/s deu theo curve 2->8->28->6/s:
  - Curve ro rang, cac stage phan biet duoc
  - Khong co bucket nao tut dot ngot
  - Peak ~28/s hien thi ro o stage 2
  - Drain ve 0/s o cuoi stage 4
```

### Chart 3: VUs vs iter/s

**Mo ta**: Bieu do hien thi so VU active va iteration rate.

**Ky vong cho case 01**:

```text
Run that:
  - active VUs: 0 hoac 1 (sampled o 1s granularity)
  - iter/s: bam theo curve
  - KHONG co tuong quan VU tang -> iter/s tang
  - active VUs << maxVUs (60) -> margin an toan lon

DIEM DAC BIET CUA CASE 01:
  active VU = 0 hoac 1 trong chart vi event QUA NHANH (p95=5ms)
  -> VU hoan thanh event GIUA 2 LAN SAMPLE (1s granularity)
  -> Chart sample luc VU idle -> hien 0
  -> KHONG CO NGHIA la khong co VU hoat dong!
```

**Nhung gi can tim**:

```text
1. active VUs = maxVUs:
   -> VU pool cham tran -> nguy co drop
   -> Neu dong thoi iter/s < target rate -> drop dang xay ra

2. active VUs TANG theo iter/s:
   -> Backend cham dan -> moi event ton nhieu thoi gian hon
   -> Neu cham maxVUs -> drop bat dau
   -> Day la dau hieu system qua tai

3. active VUs KHONG giam sau peak:
   -> VU bi "ket" o event dai -> khong tra ve pool
   -> Co the do GC, connection leak, hoac slow event

4. active VU luon = 0:
   -> Event qua nhanh, chart sample khong bat duoc
   -> KHONG co nghia "khong co VU"
   -> Kiem tra config preAllocatedVUs + vus_max summary de xac nhan
```

**Run that analysis**:

```text
active VUs: 0 hoac 1 (sampled)
  - Day la tin hieu TOT: event qua nhanh, VU quay vong nhanh
  - 1 VU du de xu ly toan bo 705 events trong 55s
  - 18 preAllocatedVUs la qua du -> co the giam xuong 2-3
  - vus_max = 18: k6 van khoi tao 18 VU (preAllocated)
    nhung chi 0-1 VU active o bat ky thoi diem sample nao
```

### Chart 4: Executor tab

**Checklist**:

```text
[ ] Executor detected: ramping-arrival-rate
[ ] startRate: 2
[ ] timeUnit: 1s
[ ] Stages: 4 stages (15s, 20s, 15s, 5s)
[ ] preAllocatedVUs: 18
[ ] maxVUs: 60
[ ] dropped_iterations: khop voi summary (0)
[ ] case_id: rar-01-campaign-warmup-surge
[ ] executor_family: ramping_arrival_rate
[ ] workload_shape: ramping_ingress_rate
[ ] business_case: marketing_campaign_warmup_to_peak
```

## 12. 4 output -> decision scenarios

Moi scenario duoi day la output mau (dua tren run that hoac mo phong) va quyet
dinh kinh doanh tuong ung.

### Scenario A: Perfect pass (Run 2026-06-21 thuc te)

```text
============================================================
OUTPUT
------------------------------------------------------------
iterations:                      705
http_reqs:                       705
dropped_iterations:              0
checks:                          100% (705/705)
http_req_failed:                 0%
events_total:                    705
events_failed:                   0
api_calls_total:                 705
event_duration p95:              5 ms
event_duration avg:              3.64 ms
active VUs max (observed):       1
vus_max:                         18

THRESHOLDS
------------------------------------------------------------
checks > 0.98:                   PASS (1.00)
http_req_failed < 0.02:          PASS (0.00)
dropped_iterations <= 5:         PASS (0)
events_failed < 20:              PASS (0)

============================================================
BUSINESS DECISION
------------------------------------------------------------
VERDICT: PASS - Campaign ingress curve san sang production

Phan tich:
  - 705/705 arrivals duoc xu ly (100% curve contract)
  - 0 drop -> VU pool du capacity o TAT CA cac stage
  - 0 fail -> tat ca 3 endpoints hoat dong
  - p95=5ms -> latency rat thap
  - Chi can 1 VU de xu ly toan bo curve -> margin an toan rat cao

Hanh dong:
  - Deploy campaign voi confidence cao
  - Co the tang peak rate (40/s, 50/s) de test gioi han
  - Document baseline nay cho regression test tuong lai
```

### Scenario B: Drop > 0 o peak stage (VU undersized)

```text
============================================================
OUTPUT (mo phong: VU pool qua nho cho W=100ms)
------------------------------------------------------------
iterations:                      680
http_reqs:                       680
dropped_iterations:              25
checks:                          100% (680/680)
http_req_failed:                 0%
events_total:                    680
events_failed:                   0
event_duration p95:              100 ms
event_duration avg:              85 ms
active VUs max (observed):       60     <-- CHAM TRAN!
vus_max:                         60

THRESHOLDS
------------------------------------------------------------
checks > 0.98:                   PASS (1.00)
http_req_failed < 0.02:          PASS (0.00)
dropped_iterations <= 5:         FAIL (25 > 5)  <-- BREACH!
events_failed < 20:              PASS (0)

============================================================
BUSINESS DECISION
------------------------------------------------------------
VERDICT: FAIL - Peak stage VU pool khong du

Phan tich:
  - 25/705 = 3.5% slot bi drop
  - Drop TAP TRUNG o cuoi stage 2 va dau stage 3 (peak)
  - active VUs cham tran 60 -> khong the spawn them worker
  - W=100ms -> VU can o peak = ceil(28 x 0.100) = 3 VU
    -> Voi 60 VUs, tai sao van drop?
    -> Co the do VU spawn delay: rate tang tu 8->28/s trong 20s
       -> can spawn VUs kip luc rate tang
    -> Hoac W thuc te cao hon 100ms o peak

Chan doan:
  - Tang maxVUs len 90 -> rerun
  - Hoac giam peak rate xuong 20/s -> xem con drop khong
  - Hoac toi uu backend de giam W < 50ms

Hanh dong:
  - KHONG deploy campaign voi peak 28/s nhu config hien tai
  - Option A: tang maxVUs (neu backend latency chap nhan duoc)
  - Option B: toi uu backend de giam W (tot hon)
  - Option C: giam peak rate trong campaign (neu business OK)
```

### Scenario C: High p95 nhung khong drop

```text
============================================================
OUTPUT (mo phong: backend latency cao nhung VU pool du)
------------------------------------------------------------
iterations:                      705
http_reqs:                       705
dropped_iterations:              0
checks:                          100% (705/705)
http_req_failed:                 0%
events_total:                    705
events_failed:                   0
event_duration p95:              350 ms
event_duration avg:              280 ms
active VUs max (observed):       15
vus_max:                         18

THRESHOLDS
------------------------------------------------------------
checks > 0.98:                   PASS (1.00)
http_req_failed < 0.02:          PASS (0.00)
dropped_iterations <= 5:         PASS (0)
events_failed < 20:              PASS (0)

============================================================
BUSINESS DECISION
------------------------------------------------------------
VERDICT: PASS contract nhung CANH BAO latency

Phan tich:
  - 705/705 arrivals duoc xu ly -> curve contract dat
  - 0 drop -> VU pool du (su dung 15/18 VU)
  - p95=350ms -> latency cao gap 70 lan baseline (5ms)
  - VU demand: ceil(28 x 0.350) = 10 VU -> active 15

Dieu tra:
  - So sanh voi baseline p95=5ms
  - Tai sao latency tang 70x? DB query cham? Network?
  - Dung tag operation de xem branch nao cham nhat
    + landing p95 = ?
    + detail p95 = ?
    + cart_add p95 = ?

Nguy co:
  - Neu latency tang them -> VU demand tang -> nguy co drop
  - Voi W=500ms: can 14 VU -> van OK (18 pre)
  - Voi W=700ms: can 20 VU > pre=18 -> can spawn -> OK (max=60)
  - Voi W=2500ms: can 70 VU > max=60 -> drop!
  - Margin an toan KHONG cao nhu baseline

Hanh dong:
  - Dieu tra root cause latency cao
  - Co the deploy campaign voi warning (theo doi latency)
  - Thiet lap alert latency tren production
  - KHONG deploy neu SLA yeu cau p95 < 50ms
```

### Scenario D: Low drop + p95 spike (tail latency investigation)

```text
============================================================
OUTPUT (mo phong: cart_add p99 spike o peak)
------------------------------------------------------------
iterations:                      703
http_reqs:                       703
dropped_iterations:              2
checks:                          99.7% (701/703)
http_req_failed:                 0%
events_total:                    703
events_failed:                   2
event_duration p95:              8 ms
event_duration p99:              450 ms     <-- P99 SPIKE!
event_duration avg:              4 ms
active VUs max (observed):       3
vus_max:                         18

Breakdown theo operation:
  campaign_surge_landing:   390/390 pass, p95=4ms,  p99=6ms
  campaign_surge_detail:    210/210 pass, p95=5ms,  p99=8ms
  campaign_surge_cart_add:  101/105 pass, p95=8ms,  p99=450ms  <--!

THRESHOLDS
------------------------------------------------------------
checks > 0.98:                   PASS (0.997)
http_req_failed < 0.02:          PASS (0.00)
dropped_iterations <= 5:         PASS (2)
events_failed < 20:              PASS (2)

============================================================
BUSINESS DECISION
------------------------------------------------------------
VERDICT: PASS contract nhung cart_add co tail latency issue

Phan tich:
  - 2 drop -> chap nhan duoc (2/705 = 0.28%)
  - 2 event fail -> deu la cart_add (4/105 cart_add fail = 3.8%)
  - cart_add p99=450ms -> 1% request cham gap ~100x
  - landing va detail deu sach -> van de CUC BO o cart service

Chan doan:
  - cart_add la POST + db_writes=1 -> write contention?
  - cart_add co memory_kb=4 -> GC pause?
  - p99 cao nhung p95 van 8ms -> tail latency, khong phai toan bo
  - 2 drop co the do cart_add event o cuoi peak stage qua dai
    -> VU busy -> slot khong co worker -> drop

Hanh dong:
  - Dieu tra cart-service write path
  - Kiem tra DB lock, connection pool, write contention
  - Co the deploy campaign nhung giam sat cart-service p99
  - Fix cart tail latency -> rerun -> target p99 < 50ms
```

## 13. Nghich ly -- nhung su that gay ngac nhien

### Nghich ly 1: "28/s peak it hon CAR 20/s fixed ve total slots nhung can NHIEU VU hon"

```text
So sanh:
  rar-01: peak=28/s, duration=55s -> total slots = 705
          average rate = 705/55 = 12.82/s

  car-01: rate=20/s, duration=45s -> total slots = 900
          average rate = 20/s

VI SAO GAY NGAC NHIEN:
  Nhin qua: rar-01 co "tong slot it hon" (705 < 900) va
            "average rate thap hon" (12.82 < 20)
  -> Tuong rang rar-01 "nhe hon" car-01
  -> Nhung VU demand tinh theo PEAK, khong phai average!

SU THAT:
  rar-01 peak 28/s: VU can = ceil(28 x W)
  car-01 rate 20/s: VU can = ceil(20 x W)

  Voi W=100ms:
    rar-01: ceil(28 x 0.100) = 3 VU
    car-01: ceil(20 x 0.100) = 2 VU
    -> rar-01 can 50% nhieu VU hon!

  Voi W=500ms:
    rar-01: ceil(28 x 0.500) = 14 VU
    car-01: ceil(20 x 0.500) = 10 VU
    -> rar-01 can 40% nhieu VU hon!

-> VU sizing trong RAR do PEAK RATE quyet dinh, khong phai average.
-> RAR co the can nhieu VU hon CAR du total slots it hon!
```

### Nghich ly 2: "preAllocatedVUs=18 khong phai 18 user"

```text
SAI: "18 preAllocatedVUs = 18 user dang browse san pham"
DUNG: "18 VU = 18 worker san sang nhan slot.
        Moi VU co the phuc vu HANG CHUC user khac nhau."

Voi 705 slot va 18 VU:
  Moi VU phuc vu trung binh 705/18 ~ 39 event
  Moi event la 1 user khac nhau (user-1, user-2, ...)
  -> 18 VU phuc vu 705 user khac nhau trong 55s!

Tuong tuong: 18 thu ngan phuc vu 705 khach trong 55 phut
  -> Hoan toan binh thuong
  -> Thu ngan khong "thuoc ve" khach nao
```

### Nghich ly 3: "active VU = 0 khong co nghia khong co worker"

```text
Run that: dashboard chart hien active VU = 0 hoac 1

SAI: "Chi co 0-1 VU hoat dong -> preAllocatedVUs=18 la thua"
DUNG: "Event QUA NHANH (3-5ms) -> VU hoan thanh event giua 2 lan
        sample (1s granularity) -> chart sample luc VU idle"

Co che:
  - Dashboard sample active VUs moi 1 giay
  - Event hoan thanh trong 3-5ms
  - Trong 1 giay, 1 VU xu ly ~200 events (5ms/event)
  - Nhung moi lan sample (1s), VU co kha nang cao DANG IDLE
    (vi event qua nhanh, 995ms idle trong 1s)
  - -> Chart hien 0-1 active VU

Bang chung VU co hoat dong:
  - vus_max summary = 18 -> k6 da tao 18 VU
  - iterations = 705 -> co 705 event duoc xu ly
  - progress output hien VU count
  -> 18 VU da duoc tao va da xu ly 705 event
```

### Nghich ly 4: "Rate curve ramp nhung iteration schedule khong bi delay"

```text
SAI: "Rate thay doi theo stage -> schedule phuc tap -> co the delay"
DUNG: "k6 tinh toan slot time TRUOC khi test bat dau
        -> schedule la fixed timeline, khong bi delay"

Co che:
  - k6 tinh toan thoi diem cho TUNG SLOT truoc khi test bat dau
  - Cong thuc: slot_i_time = start_time + cumulative_slots_at_rate
  - Rate tai tung thoi diem duoc linear interpolate giua stage targets
  - Schedule da duoc "cung hoa" truoc -> khong phu thuoc runtime
  - Giong nhu tau dien: lich trinh da len san,
    chi co "tau co chay duoc khong", khong co "lich trinh thay doi"
```

### Nghich ly 5: "dropped_iterations co the = 0 nhung test van FAIL"

```text
Nguoc lai voi truc giac: dropped=0 KHONG DAM BAO pass

Tinh huong:
  dropped_iterations = 0
  Nhung checks = 85% (FAIL threshold >98%)
  Nhung events_failed = 105 (FAIL threshold <20)
  Nhung http_req_failed = 5% (FAIL threshold <2%)

-> Contract "giu duoc arrival curve" dat (0 drop)
   Nhung "chat luong xu ly" khong dat (checks/events_failed)

-> Trong RAR, PASS can CA HAI:
   - So luong (dropped_iterations)
   - Chat luong (checks, failed rates)
```

## 14. Checklist

### Pre-run (truoc khi chay)

```text
[ ] Backend health: curl http://localhost:80/health -> 200 OK
[ ] k6 version: k6.exe v2.0.0+
[ ] Metrics server: curl http://localhost:18080/v1/capabilities -> 200
[ ] Token valid: curl -H "Authorization: Bearer student-token-..." .../v1/me -> 200
[ ] Script inspect: k6 inspect rar-01-campaign-warmup-surge.js -> OK
[ ] Env vars: BASE_URL, K6_CLOUD_HOST, K6_CLOUD_TOKEN
[ ] Dashboard: http://localhost:18080 accessible
[ ] Config verify: startRate=2, stages 15/20/15/5, pre=18, max=60
[ ] Du lieu test cu da duoc don dep (neu can)
```

### During-run (trong khi chay)

```text
[ ] Dashboard Overview chart xuat hien data
[ ] iter/s BAM THEO CURVE (tang dan o stage 1-2, giam dan o stage 3-4)
[ ] dropped_iterations = 0 (theo doi real-time Executor tab)
[ ] Khong co HTTP error spike
[ ] p95 on dinh, khong tang dan
[ ] active VUs khong cham maxVUs (neu cham -> nguy co drop)
[ ] Khong co log loi tu k6 process
[ ] CPU/memory k6 process trong gioi han
```

### Post-run (sau khi chay)

```text
[ ] iterations ~ 705
[ ] dropped_iterations <= MAX_DROPPED (5)
[ ] interrupted_iterations = 0
[ ] checks rate > 0.98
[ ] http_req_failed rate < 0.02
[ ] events_failed < 20
[ ] events_total ~ iterations
[ ] api_calls_total ~ http_reqs
[ ] event_duration p95 trong nguong chap nhan
[ ] Branch breakdown: landing 55% (~388), detail 30% (~212), cart_add 15% (~106)
[ ] Reconciliation: iterations + dropped ~ 705
[ ] Dashboard charts khop summary numbers
[ ] Luu summary export file
[ ] Ghi lai run ID de trace
```

## 15. 5 Variations -- thay doi config de thay executor behavior

Moi variation duoi day thay doi mot khia canh cua config de minh hoa hanh vi
cua `ramping-arrival-rate`.

### Variation 1: Higher peak rate (40/s)

**Muc dich**: Test gioi han campaign khi peak tang len 40 arrivals/s.

```powershell
$env:RAR_01_PEAK_RATE = "40"
$env:RAR_01_PREALLOCATED_VUS = "25"
$env:RAR_01_MAX_VUS = "80"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

Remove-Item Env:RAR_01_PEAK_RATE, Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Config thay doi:
  - Peak rate: 28/s -> 40/s (tang 43%)
  - preAllocatedVUs: 18 -> 25 (tang VU du phong)
  - maxVUs: 60 -> 80 (tang tran)

Stage math moi:
  Stage 1: 15 x (2+8)/2   = 75  (khong doi)
  Stage 2: 20 x (8+40)/2  = 480 (tang tu 360)
  Stage 3: 15 x (40+6)/2  = 345 (tang tu 255)
  Stage 4: 5 x (6+0)/2    = 15  (khong doi)
  Total:                   915 slots (tang tu 705)

VU can o peak (W=5ms):
  ceil(40 x 0.005) = 1 VU -> van de

VU can o peak (W=100ms):
  ceil(40 x 0.100) = 4 VU -> can nhieu VU hon

Observation:
  - Tang 43% rate -> tang 30% total slots
  - Kiem tra dropped_iterations co > 0 khong
  - Kiem tra p95 co tang khong (nhieu request/s -> resource pressure)
```

### Variation 2: Longer surge (30s o peak)

**Muc dich**: Mo phong campaign co launch window keo dai (30s thay vi 20s).

```powershell
# Can tao script variation hoac modify stage duration:
# stage 2: { target: 28, duration: scaleSeconds(30, SCALE) }

# Hoac override RAR_01_PEAK_RATE va RAR_01_RECOVERY_RATE de keo dai peak
# (can modify script de co RAR_01_SURGE_DURATION)

# Cach don gian: tang DURATION_SCALE
$env:RAR_01_DURATION_SCALE = "1.5"  # 20s x 1.5 = 30s surge

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

Remove-Item Env:RAR_01_DURATION_SCALE -ErrorAction SilentlyContinue
```

```text
Config thay doi:
  - Surge duration: 20s -> 30s (x1.5)
  - Tong duration: 55s -> 82.5s

Stage math moi:
  Stage 1: 22.5 x (2+8)/2   = 112.5
  Stage 2: 30 x (8+28)/2    = 540
  Stage 3: 22.5 x (28+6)/2  = 382.5
  Stage 4: 7.5 x (6+0)/2    = 22.5
  Total:                     1057.5 ~ 1058 slots

Observation:
  - Surge keo dai -> nhieu slot o peak zone
  - Neu backend cham dan -> co the thay drop o CUOI surge
  - Dau hieu memory leak se ro hon voi surge dai
```

### Variation 3: Tighter VU budget (pre=8, max=20)

**Muc dich**: Co y thu hep VU pool de xem dropped_iterations xuat hien.

```powershell
$env:RAR_01_PREALLOCATED_VUS = "8"
$env:RAR_01_MAX_VUS = "20"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

Remove-Item Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Config thay doi:
  - preAllocatedVUs: 18 -> 8 (giam 56%)
  - maxVUs: 60 -> 20 (giam 66%)

Expected voi W=5ms (backend nhanh):
  VU can o peak = ceil(28 x 0.005) = 1 VU
  -> pre=8 van DU THUA -> 0 drop

Expected voi W=100ms (backend trung binh):
  VU can o peak = ceil(28 x 0.100) = 3 VU
  -> pre=8 van DU -> 0 drop

Expected voi W=500ms (backend cham):
  VU can o peak = ceil(28 x 0.500) = 14 VU
  -> pre=8 < can=14 -> can spawn them 6 VU
  -> max=20 > can=14 -> VAN DU -> 0 drop

Expected voi W=800ms (backend rat cham):
  VU can o peak = ceil(28 x 0.800) = 23 VU
  -> max=20 < can=23 -> DROP!
  -> drop bat dau khi activeVUs cham 20
  -> Test FAIL -> hoc duoc cach doc drop

Observation:
  - Neu backend nhanh (p95=5ms): 0 drop du VU pool nho
    -> Day la suc manh cua event nhanh + open model
  - Neu backend cham -> drop xuat hien
  - Tang dan maxVUs: 20->30->40->50 de thay drop giam dan
```

### Variation 4: Smoke test (scale=0.1, moi stage ~1-2s)

**Muc dich**: Xac nhan script chay duoc, ket noi OK.

```powershell
$env:RAR_01_DURATION_SCALE = "0"    # envInt + scaleSeconds -> 1s/stage
$env:RAR_01_PEAK_RATE = "8"
$env:RAR_01_PREALLOCATED_VUS = "4"
$env:RAR_01_MAX_VUS = "8"

.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js"

Remove-Item Env:RAR_01_DURATION_SCALE, Env:RAR_01_PEAK_RATE, Env:RAR_01_PREALLOCATED_VUS, Env:RAR_01_MAX_VUS -ErrorAction SilentlyContinue
```

```text
Config thay doi:
  - scale=0 -> moi stage 1s -> tong 4s
  - Peak rate: 8/s (giam tu 28/s)
  - VU budget: pre=4, max=8

Stage math:
  Stage 1: 1 x (2+8)/2  = 5
  Stage 2: 1 x (8+8)/2  = 8   (peak=8)
  Stage 3: 1 x (8+6)/2  = 7
  Stage 4: 1 x (6+0)/2  = 3
  Total:                  23 slots

Expected:
  iterations ~ 23
  dropped_iterations = 0
  p95 < 100ms

Muc dich:
  - Kiem tra script khong loi syntax
  - Kiem tra ket noi backend
  - Lam quen voi output format
  - Chay trong <10s
```

### Variation 5: Single-branch only (bo weightedPick)

**Muc dich**: Test rieng tung branch de tim bottleneck.

```js
// Sua script tam: bo weightedPick, hardcode branch
export function campaignWarmupSurge(data = {}) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const productId = (ctx.iter % 50) + 1;

  // Chi test cart_add (write path)
  const result = requestJson('POST',
    `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4`,
    { product_id: productId, quantity: 1 },
    { caseId: CASE_ID, service: 'cart-service',
      operation: 'campaign_surge_cart_add',
      endpoint: 'POST /api/sim/cart/add', userId: ctx.userId }
  );

  finishEvent(started, result.ok, {
    caseId: CASE_ID,
    service: 'cart-service',
    operation: 'campaign_surge_cart_add',
    userId: ctx.userId,
  });
}
```

```text
Test cac scenario:
  a) 100% landing:  test read path products list
  b) 100% detail:   test read path product detail
  c) 100% cart_add: test write path cart service

Observation:
  - So sanh p95 cua tung branch doc lap
  - cart_add co db_writes -> co the cham hon landing
  - Tim branch nao la bottleneck o peak 28/s
  - Sau khi tim duoc -> toi uu rieng branch do
  - Roi quay lai weighted mix de verify toan bo curve
```

## 16. Anti-patterns

Nhung sai lam pho bien khi doc output cua `ramping-arrival-rate`.

### Anti-pattern 1: "18 preAllocatedVUs = test voi 18 user"

```text
SAI: "Config pre=18 -> test 18 user. UserPool=800 la vo nghia."

VI SAO SAI:
  - VU la worker, khong phai user
  - userPool=800 la identity pool de gan userId
  - Moi VU phuc vu nhieu user khac nhau
  - userId = rar-user-N den tu iterationInTest % 800
  - 18 VU phuc vu 705 user trong 55s

DUNG: "preAllocatedVUs=18 la so worker san sang nhan slot.
        So user duoc test = min(scheduled_slots, userPool)
        = min(705, 800) = 705."
```

### Anti-pattern 2: "Latency thap thi pass, khong can check dropped_iterations"

```text
SAI: "p95=5ms -> test pass. Khong can check dropped_iterations."

VI SAO SAI:
  - p95 thap -> VU demand thap -> DE pass
  - NHUNG van phai check dropped_iterations
  - Co the maxVUs qua thap -> drop du p95 thap
  - Co the checks fail du p95 thap
  - Co the events_failed > 0 du p95 thap

DUNG: "p95 la 1 trong NHIEU tin hieu.
        Pass/fail duoc quyet dinh boi TAT CA threshold."
```

### Anti-pattern 3: "Tang maxVUs that cao de khong bao gio drop"

```text
SAI: "maxVUs=10000 -> khong drop -> test luon pass.
       Day la cach 'an toan'."

VI SAO SAI:
  - maxVUs qua cao -> mat gia tri cua open model
  - Khong phat hien duoc contract breach that su
  - Backend co the cham 10s/request, k6 spawn du VU de giu rate
  - Che giau van de backend
  - Lang phi tai nguyen test machine

DUNG: "maxVUs nen phan anh capacity thuc te:
        - So pod/container toi da trong production
        - So thread/connection pool toi da
        Nhan voi safety factor 1.2-1.5.
        Neu test drop voi maxVUs production-realistic
        -> production se drop that."
```

### Anti-pattern 4: "Dung average rate de tinh VU sizing"

```text
SAI: "Average rate = 705/55 = 12.82/s.
       VU can = ceil(12.82 x 0.005) = 1 VU.
       Vay 1 VU la du."

VI SAO SAI:
  - VU sizing phai dung PEAK rate, khong phai average
  - O peak 28/s: VU can = ceil(28 x 0.005) = 1 VU (van OK voi W=5ms)
  - Nhung voi W=200ms:
    + Average: ceil(12.82 x 0.200) = 3 VU
    + Peak: ceil(28 x 0.200) = 6 VU (gap DOI!)
  - Dung average -> UNDERESTIMATE VU demand -> drop o peak

DUNG: "Luon tinh VU sizing tu PEAK rate cua toan bo curve.
        peak_VU = ceil(peak_rate x p95_event_duration)."
```

### Anti-pattern 5: "Nhin iter/s trong summary de danh gia curve"

```text
SAI: "Summary hien iterations/s = 12.82/s.
       Nhung peak la 28/s -> contract breach?"

VI SAO SAI:
  - iterations/s trong summary = iterations / test_duration
  - Test_duration = 55s, iterations = 705 -> 705/55 = 12.82/s
  - Day la AVERAGE, bao gom ca warmup (rate thap) va drain (rate 0)
  - Khong phan anh duoc peak rate thuc te

DUNG: "Danh gia curve contract bang:
        1. Stage math -> scheduled_slots = 705
        2. iterations + dropped ~ 705
        3. dropped_iterations <= maxDropped
        4. Dashboard Execution timeline -> curve co dung hinh dang khong
        iterations/s trong summary CHI la average tham khao."
```

### Anti-pattern 6: "Dung ramping-vus vi no cung co 'ramp'"

```text
SAI: "ramping-vus cung co stages, cung co ramp.
       Vay dung ramping-vus cho campaign ingress."

VI SAO SAI:
  - ramping-vus ramp VU COUNT, khong phai arrival rate
  - VU count tang -> throughput CO THE tang -> nhung phu thuoc latency
  - Backend cham -> throughput giam -> mat curve
  - Khong co dropped_iterations -> khong phat hien breach
  - KHONG test duoc "ingress curve doc lap voi backend"

DUNG: "ramping-vus ramp SO LUONG VU.
        ramping-arrival-rate ramp ARRIVAL RATE.
        Hai executor co chu 'ramping' nhung Y NGHIA HOAN TOAN KHAC."
```

## 17. Real validation data

### Run 2026-06-21 -- local validation

```text
Run ID:      #100
Script:      rar-01-campaign-warmup-surge.js
Exit code:   0
Date:        2026-06-21
Target:      http://localhost:80
Dashboard:   http://localhost:18080
```

### Summary chinh

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes` / `checks_fails` | `705 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `705` |
| `iterations_rate` | `12.82/s` |
| `http_reqs` | `705` |
| `http_reqs_rate` | `12.82/s` |
| `vus_max` | `18` |

### Latency breakdown

| Metric | avg | med | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ramping_arrival_event_duration_ms` | 3.64 | 3 | **5** | 6 | 18 |
| `http_req_duration` | 3.49 | 3.32 | **4.27** | 5.32 | 18.34 |

### Request breakdown

```text
campaign_surge_landing   GET 200  count=390  (55.3%)
campaign_surge_detail    GET 200  count=210  (29.8%)
campaign_surge_cart_add  POST 200 count=105  (14.9%)
                        Total:    count=705  (100%)
```

### Dashboard series check

```text
iterations:         points=55, sum=705, min=1, max=27, truncated=false
http_reqs:          points=705, sum=705, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus:                points=55, min=0, max=1, truncated=false
```

### Stage math reconciliation

| Stage | Phep tinh | Expected | Observed | Match |
| --- | --- | ---: | ---: | --- |
| 1 warmup | 15x(2+8)/2 | 75 | -- | -- |
| 2 surge | 20x(8+28)/2 | 360 | -- | -- |
| 3 recovery | 15x(28+6)/2 | 255 | -- | -- |
| 4 drain | 5x(6+0)/2 | 15 | -- | -- |
| **Total** | | **705** | **705** | **Exact** |

### Verdict

```text
PASS -- Campaign warmup surge ingress contract met day du:
  - 705/705 slots duoc xu ly (100% curve contract)
  - dropped_iterations = 0
  - checks = 100%
  - http_req_failed = 0%
  - events_failed = 0
  - event p95 = 5ms
  - Branch mix khop weight: 55/30/15

=> Products + Cart service san sang cho campaign launch
   voi curve 2->8->28->6/s.
```

## Reference

### Trong cung series

| Doc | Noi dung |
| --- | --- |
| `00_overview.md` | Tong quan series, cong thuc, mental model |
| `02_login-burst-recovery.md` | Case 02: Auth login burst recovery |
| `03_payment-webhook-wave.md` | Case 03: Payment webhook wave |
| `04_checkout-flash-sale-wave.md` | Case 04: Checkout flash-sale (multi-request) |
| `05_report-job-ingress-ramp.md` | Case 05: Report job -- dropped_iterations thuc te |
| `06_cache-feed-wave.md` | Case 06: Cacheable feed high-rate wave |
| `07_production-spike-mix.md` | Case 07: Mixed traffic spike |
| `08_validation-and-chart-analysis.md` | Full validation data + chart analysis 7 case |
| `RUN_GUIDE.md` | Huong dan chay day du |

### Source code

```text
Script:     E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-01-campaign-warmup-surge.js
Common:     E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js
Run helper: E:\Khoa hoc\k6\run-with-summary.ps1
```

### Cross-series reference

| Doc | Noi dung |
| --- | --- |
| `docs/practice/constant-arrival-rate/01_storefront-rps-contract.md` | CAR case 01 (gold standard) |
| `docs/practice/per-vu-iterations/01_user-journey-replay.md` | Regression test voi per-vu-iterations |
| `docs/practice/shared-iterations/` | Shared-iterations series |
| `docs/20260513_00_executor-from-simplest.md` | Executor tu don gian nhat |

### Key formulas

```text
slots_in_stage = duration_seconds x (rate_start + rate_end) / 2
total_scheduled_slots = sum of slots_in_stage across all stages
required_vus_at_rate = ceil(current_rate x W_effective)
capacity_with_M_vus = M / W_effective
drop_rate_at_rate = max(0, current_rate - M / W_effective)

VU sizing rule for ramping-arrival-rate:
  SIZE FOR PEAK RATE, NOT AVERAGE RATE
  peak_vus = ceil(peak_rate x p95_event_duration)
```

### Run 2026-06-21 reference data

```text
Run ID:       #100
Date:         2026-06-21
Curve:        2 -> 8 -> 28 -> 6 -> 0/s
Duration:     55s
Target slots: 705
Iterations:   705
Dropped:      0
HTTP reqs:    705
Checks:       100%
HTTP failed:  0%
Events failed: 0
Event p95:    5 ms
HTTP p95:     4.27 ms
active VU max: 1 (sampled)
vus_max:      18
Verdict:      PASS
```
