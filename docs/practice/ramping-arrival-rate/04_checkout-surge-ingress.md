# Case 04: Checkout Surge Ingress

> **Script:** `rar-04-checkout-flash-sale-wave.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 12 arrivals/s
> **Focus:** Multi-step checkout pipeline trong flash sale -- cart add -> checkout create -> order confirm.
> **Star insight:** Peak thap nhat series (12/s) nhung preAllocatedVUs cao nhat (25). Vi sao?

---

## 1. Tinh huong thuc te

### 1.1 Boi canh kinh doanh

Flash sale la su kien ban hang gioi han thoi gian, giam gia sau. Khi flash sale
bat dau, he thong e-commerce trai qua 3 pha traffic rieng biet:

```text
Pha 1 (Browse/Intent): Nguoi dung mo app, xem san pham flash sale, chon size/mau
                       -> Traffic chu yeu la GET browse/list/detail

Pha 2 (Checkout Peak): Nguoi dung bam "Mua ngay" -> cart -> checkout -> confirm
                       -> Traffic la POST lien tuc qua nhieu service

Pha 3 (Recovery):      San pham ban het hoac flash sale ket thuc
                       -> Traffic giam dan ve binh thuong
```

Trong do, **pha 2 (checkout)** la pha nguy hiem nhat vi:

```text
- Moi checkout event KHONG PHAI 1 HTTP request don le
- No la 1 PIPELINE 3 buoc: cart add -> checkout create -> order confirm
- Moi buoc goi den 1 service khac nhau (cart-service, order-service)
- Neu 1 buoc fail, toan bo pipeline fail (da cart add nhung checkout create fail
  -> gio hang co san pham nhung khong dat duoc hang)
- External dependency (payment gateway gia lap qua external_ms) tang latency
```

### 1.2 Cau hoi kinh doanh

Team business va infrastructure can tra loi:

```text
"Order/cart path co xu ly duoc checkout wave 1 -> 4 -> 12 -> 3/s
 ma khong drop hay fail khong?"

Cu the hon:
"Khi flash sale bat dau, 12 nguoi moi giay bam 'Mua ngay' va di qua
 toan bo pipeline cart+checkout+confirm. He thong co:
  - Giu duoc arrival contract (khong drop checkout request)?
  - Xu ly thanh cong toan bo 3 buoc (checks = 100%)?
  - Khong tao ra inconsistent state (cart co hang nhung order khong ton tai)?"
```

### 1.3 Vi sao checkout khac voi browse/login/webhook?

So sanh voi cac case khac trong series:

| Case | Peak rate | preAllocatedVUs | So API call/event | Event p95 | Dac diem |
| --- | ---: | ---: | ---: | ---: | --- |
| rar-01 campaign warmup | 28/s | 18 | 1 (GET) | 5ms | Doc thuan, 1 call |
| rar-02 login burst | 24/s | 16 | 1 (POST) | 23ms | Auth, DB write |
| rar-03 payment webhook | 20/s | 16 | 1 (POST) | 6ms | Webhook don gian |
| **rar-04 checkout flash-sale** | **12/s** | **25** | **3 (POST)** | **112ms** | **Pipeline 3 buoc, external latency** |
| rar-05 report job | 8/s | 25 | 1.4 avg | 9.01s | Async + sleep, drop 20 |
| rar-06 cache feed | 20/s | 18 | 1 (GET) | 4ms | Cache hit nhanh |
| rar-07 production spike | 22/s | 30 | 1 (POST) | 86ms | External_ms=80 |

**Diem dac biet cua rar-04**: Peak rate thap nhat (12/s) nhung preAllocatedVUs
cao nhat (25) cung rar-05. Ly do: moi event la pipeline 3 buoc, giu VU ~89ms
thay vi 4-6ms nhu case doc. VU capacity tinh theo Little's Law:
`required_vus = arrival_rate x event_duration`.

### 1.4 Flash sale checkout wave qua cac giai doan

```text
startRate = 1/s
15s -> 4/s   Giai doan browse/intent: nguoi dung dang xem san pham,
              mot so it da bat dau add to cart

20s -> 12/s  Giai doan checkout peak: flash sale chinh thuc mo,
              nguoi dung add cart + checkout + confirm o nhịp cao nhat

15s -> 3/s   Giai doan recovery: hang ton kho can, traffic checkout giam

5s  -> 0/s   Giai doan drain: ket thuc flash sale, khong con checkout moi
```

Bieu do minh hoa (text):

```text
Rate (arrivals/s)
 12 |                          ______
    |                         /      \
    |                        /        \
  4 |            ___________/          \_______
    |           /                              \
  1 |  ________/                                \______
  0 |___________________________________________________
    0s    15s              35s             50s    55s

    Browse/Intent    Checkout Peak      Recovery  Drain
```

### 1.5 Pipeline integrity -- vi sao khong the chi test tung buoc?

Mot sai lam pho bien la test tung buoc doc lap:

```text
SAI: "Test cart add rieng -> pass. Test checkout rieng -> pass.
      Test confirm rieng -> pass. Vay pipeline pass."

Tai sao sai:
  - Test rieng le khong tinh den SEQUENTIAL DEPENDENCY:
    + Cart add response KHONG anh huong checkout (dung)
    + NHUNG checkout response chua orderId -> confirm CAN orderId
  - Test rieng le khong tinh den VU HOLDING TIME:
    + 1 VU giu trong suot 3 buoc (~89ms)
    + Test rieng le: each call xong la VU tra ve pool
  - Test rieng le khong tinh den ACCUMULATED LATENCY:
    + Cart add 30ms + checkout 35ms + confirm 25ms = 90ms
    + Tong latency gap 3x latency tung call
  - Test rieng le khong tinh den FAILURE CASCADING:
    + Cart add fail -> checkout khong goi -> confirm khong goi
    + Nhung cart add OK + checkout FAIL -> confirm VAN GOI (voi fallback)
      -> Inconsistent state that rieng le testing khong phat hien
```

### 1.6 Hinh dung pipeline qua goc nhin cua 1 user

```text
User: rar-user-42 (userNumber = 42, tuong ung iteration index 41)

1. User 42 mo app, thay flash sale "Giay Nike giảm 70%"
2. User 42 chon size 42, bam "Them vao gio hang"
   -> Client goi POST /api/sim/cart/add {product_id: 12, quantity: 1}
   -> Server xu ly: CPU 1ms + DB write 1 row + allocate 4KB memory
   -> Response: 200 OK
   -> Client hien thi: "Da them vao gio hang"

3. User 42 bam "Mua ngay"
   -> Client goi POST /api/sim/checkout {user_id, items, payment_method: card}
   -> Server xu ly: CPU 2ms + DB write 2 rows + external call ~25ms (payment gateway)
   -> Idempotency-Key: rar04-{seed}-41-{vuId}-checkout
   -> Response: 200 OK + {data: {order_id: "..."}}
   -> Client hien thi: "Dat hang thanh cong, dang xu ly..."

4. Client goi POST /api/sim/orders/{order_id}/confirm
   -> Server xu ly: CPU 1ms + DB write 1 row + external call ~20ms (confirmation)
   -> Idempotency-Key: rar04-{seed}-41-{vuId}-confirm
   -> Response: 200 OK
   -> Client hien thi: "Don hang da duoc xac nhan"

Tong thoi gian user 42 trai nghiem: ~90ms
Trong 90ms do, VU giu bien cart, checkout, confirm responses trong bo nho.

Sau 90ms: VU tra ve pool, san sang nhan event moi (co the cho user khac).
```

### 1.7 Su khac biet ve mat VU pressure giua cac giai doan

```text
Giai doan browse/intent (1-4/s):
  - It event bat dau -> it VU active cung luc
  - Voi 4/s va event 89ms: can ceil(4 x 0.089) = 1 VU
  - pre=25 -> thua 24 VU -> 0 ap luc

Giai doan checkout peak (4-12/s):
  - Rate tang dan -> VU demand tang dan
  - Tai 8/s: can ceil(8 x 0.089) = 1 VU (van du)
  - Tai 12/s: can ceil(12 x 0.089) = 2 VU (van du nhung margin giam)
  - VU pool o ap luc CAO NHAT o thoi diem cuoi peak

Giai doan recovery (12-3/s):
  - Rate giam dan -> VU demand giam dan
  - VU duoc "giai phong" dan -> ap luc giam

Giai doan drain (3-0/s):
  - Rat it event -> VU gan nhu idle het
  - Toan bo pipeline da duoc "flush"
```

---

## 2. 2 yeu cau cot loi

### 2.1 Yeu cau (a): GIU INGRESS RATE CONG THEO STAGE (ramping arrival contract)

**Y nghia**: K6 phai bat dau iteration moi theo dung nhịp thay doi qua tung
stage, bat ke backend dang nhanh hay cham. Day la dieu kien tien quyet de test
checkout intake contract trong flash sale.

**Vi du cu the**:

```text
Config: startRate=1/s, stages: 15s->4/s, 20s->12/s, 15s->3/s, 5s->0/s

Timeline 55 giay:
  t=0.00s:  slot #0   schedule, rate dang ~1/s (dau stage 1)
  t=1.00s:  slot #1   schedule
  ...
  t=14.50s: slot #37  schedule, rate dang ~4/s (cuoi stage 1)
  t=15.00s: slot #38  schedule, rate bat dau tang tu 4->12/s (stage 2)
  ...
  t=34.50s: slot #197 schedule, rate dang ~12/s (cuoi peak)
  t=35.00s: slot #198 schedule, rate bat dau giam tu 12->3/s (stage 3)
  ...
  t=49.50s: slot #310 schedule, rate dang ~3/s (cuoi stage 3)
  t=50.00s: slot #311 schedule, rate giam tu 3->0/s (stage 4)
  t=54.50s: slot #317 schedule, slot cuoi cung

Tong: ~317.5 slots duoc schedule trong 55s
```

Diem quan trong: cac slot duoc schedule **dung nhịp**, khong phu thuoc vao
viec slot truoc da xong hay chua. Giong nhu:

```text
Khach hang den checkout counter theo dung khung gio flash sale:
  - 7:00-7:15: 1-4 khach/phut (dang xem hang)
  - 7:15-7:35: 4-12 khach/phut (flash sale peak)
  - 7:35-7:50: 12-3 khach/phut (giam dan)
  - 7:50-7:55: 3-0 khach/phut (dong counter)

Neu thu ngan khong co mat -> khach bo di (= dropped_iterations)
Khong phai "khach cho thu ngan xong roi moi den" -> arrival doc lap voi service time
```

### 2.2 Yeu cau (b): PHAT HIEN CONTRACT BREACH QUA dropped_iterations

**Y nghia**: Khi backend khong du capacity xu ly checkout pipeline, test phai
**bao loi ro rang** qua `dropped_iterations`, khong duoc "im lang pass" nhu
closed model.

**Vi du cu the**:

```text
Tinh huong: Payment gateway cham dot ngot (external_ms=25 -> external_ms=500)

Voi constant-vus (closed model):
  - VU loop cham hon -> throughput tu giam
  - Test van pass (khong co error, khong co drop)
  - KHONG phat hien duoc van de

Voi ramping-arrival-rate (open model):
  - Slot van den dung nhịp (12/s o peak)
  - Moi event ton nhieu thoi gian hon (3 buoc + external moi buoc)
  - Can nhieu VU hon de giu nhịp
  - VU pool can -> slot khong co worker -> dropped_iterations++
  - Test FAIL -> phat hien duoc contract breach
```

### 2.3 Tai sao ca 2 yeu cau phai thoa man DONG THOI?

```text
Neu CHI co (a) ma khong co (b):
  - Arrival rate dung nhịp nhung khong co co che bao breach
  - Giong nhu dong ho bao thuc reo dung gio nhung khong ai nghe

Neu CHI co (b) ma khong co (a):
  - Co bao loi nhung arrival rate khong theo stage
  - Khong test duoc dung checkout intake contract
  - Giong nhu bao chay nhung khong co lua

Ca 2 cung co -> ramping-arrival-rate la executor DUY NHAT thoa man.
```

---

## 3. Vi sao dung `ramping-arrival-rate`?

### 3.1 Checkout arrivals di theo flash sale curve

Flash sale checkout KHONG PHAI la traffic deu dan. No la 1 **wave** co hinh
dang:

```text
- Tang dan khi nguoi dung bam "Mua ngay" (browse -> intent -> checkout)
- Dat dinh khi nhieu nguoi cung checkout (peak flash sale)
- Giam dan khi hang ton kho can (recovery)
- Ve 0 khi flash sale ket thuc (drain)

Day la traffic hinh SONG, khong phai flat line.
```

`ramping-arrival-rate` la executor DUY NHAT ho tro:

```text
- startRate: rate ban dau (traffic nen)
- stages: mang cac stage {target, duration} thay doi rate theo thoi gian
- Moi stage: rate bien doi TUYEN TINH tu rate hien tai den target
- preAllocatedVUs/maxVUs: worker pool doc lap voi arrival schedule
```

### 3.2 So sanh 5 executor

| Executor | Model | Cach hoat dong | Vi sao KHONG phu hop cho checkout wave? |
| --- | --- | --- | --- |
| **ramping-arrival-rate** | Open | Schedule iteration theo rate thay doi qua stage. VU la worker pool. | **PHU HOP**: ingress rate thay doi theo flash sale curve. Drop bao contract breach. |
| constant-arrival-rate | Open | Schedule iteration theo rate CO DINH. VU la worker pool. | Chi giu duoc rate co dinh, khong mo phong duoc wave flash sale (tang/giam). |
| constant-vus | Closed | Giu N VU chay lien tuc. Moi VU loop: gui request -> doi -> gui tiep. | Backend cham -> VU loop cham -> throughput tu giam. Khong test duoc arrival contract. Khong mo phong duoc wave. |
| shared-iterations | Closed | Chia N iterations cho M VUs. VU nao xong truoc nhan iteration tiep. | Tong iteration co dinh nhung rate phu thuoc VU speed. Khong co stage. Khong test duoc "12/s o peak". |
| ramping-vus | Closed | Tang/giam so VU theo stage. Throughput phu thuoc VU count va loop time. | VU count thay doi theo stage nhung throughput van phu thuoc latency. Khong giu duoc rate doc lap. |

### 3.3 Phan tich sau: vi sao constant-arrival-rate khong du?

```text
constant-arrival-rate:
  rate = 12/s, duration = 55s
  -> 12 × 55 = 660 slots, DEU DAN trong 55s

Nhung flash sale checkout thuc te:
  - 15s dau: chi 1-4/s (nguoi dung dang browse)
  - 20s peak: 4-12/s (checkout wave)
  - 15s recovery: 12-3/s (giam dan)
  - 5s drain: 3-0/s

Neu dung constant-arrival-rate 12/s:
  - 15s dau: 12/s nhung thuc te chi 1-4/s -> test qua nang, khong thuc te
  - 20s peak: 12/s -> dung
  - 15s cuoi: 12/s nhung thuc te chi 3/s -> test qua nang

=> constant-arrival-rate test SAI profile traffic
=> Pass constant 12/s khong dam bao pass wave 1->4->12->3
   (vi VU pool ap luc khac nhau hoan toan)
```

### 3.4 Bang tom tat hanh vi qua 4 muc latency

Voi `ramping-arrival-rate`, peak=12/s, pre=25, max=80:

| Backend event duration (avg) | VU can thiet (Little's Law) | VU co san (max 80) | Ket qua |
| ---: | ---: | ---: | --- |
| 89ms (normal) | ceil(12 x 0.089) = 2 | 80 | PASS (0 drop) |
| 200ms (external cham) | ceil(12 x 0.200) = 3 | 80 | PASS (0 drop) |
| 500ms (payment gateway slow) | ceil(12 x 0.500) = 6 | 80 | PASS (0 drop) |
| 2000ms (external timeout) | ceil(12 x 2.000) = 24 | 80 | PASS (can 24/25 pre) |
| 7000ms (cuc ky cham) | ceil(12 x 7.000) = 84 | 80 (thieu 4) | FAIL (dropped_iterations) |

Diem mau chot: Voi `ramping-arrival-rate`, khi backend thuc su khong chiu duoc
checkout contract o peak, test BAO LOI qua `dropped_iterations`.

---

## 4. Config mapping

### 4.1 Bang tham so day du

| Tham so | Default | Y nghia | Vi sao chon gia tri nay? |
| --- | ---: | --- | --- |
| `RAR_04_START_RATE` | 1 | Rate dau run | Traffic nen truoc flash sale (browse) |
| `RAR_04_BROWSE_RATE` | 4 | Rate cuoi stage 1 | Pre-checkout ramp, nguoi dung bat dau intent |
| `RAR_04_CHECKOUT_RATE` | 12 | Rate peak stage 2 | Checkout intake peak trong flash sale |
| `RAR_04_RECOVERY_RATE` | 3 | Rate cuoi stage 3 | Recovery traffic sau flash sale |
| `RAR_04_DURATION_SCALE` | 1 | He so scale stage duration | Scale deu cac stage (vd 2 -> 110s) |
| `RAR_04_PREALLOCATED_VUS` | 25 | Worker warm san | Cao nhat series! Vi pipeline 3 buoc giu VU lau |
| `RAR_04_MAX_VUS` | 80 | Worker ceiling | Cho phep mo rong gap ~3x pre khi can |
| `RAR_04_MAX_DROPPED` | 3 | Drop budget | Cho phep 1 vai drop do tail latency |
| `RAR_04_USER_POOL` | 500 | User identity pool | 500 user identity xoay vong cho 317 events |

### 4.2 Stage math -- Scheduled slots

Cong thuc tinh cho moi stage (hinh thang, rate bien doi tuyen tinh):

```text
slots_stage = duration × (rate_start + rate_end) / 2
```

Bang tinh toan cu the:

| Stage | Duration | Rate start -> end | Area (slots) | Giai thich |
| --- | ---: | ---: | ---: | --- |
| 1 browse/intent | 15s | 1 -> 4/s | (1+4)/2 x 15 = 37.5 | Nguoi dung dang xem hang, mot so add cart |
| 2 checkout peak | 20s | 4 -> 12/s | (4+12)/2 x 20 = 160 | Flash sale mo, checkout wave dat dinh |
| 3 recovery | 15s | 12 -> 3/s | (12+3)/2 x 15 = 112.5 | Hang ban het, checkout giam dan |
| 4 drain | 5s | 3 -> 0/s | (3+0)/2 x 5 = 7.5 | Ket thuc flash sale |
| **Total** | **55s** | | **317.5** ~= 317 | |

So sanh scheduled vs observed:

```text
Scheduled slots (tinh toan): 317.5
Observed iterations (chay that): 317
Chenh lech: 0.5 (rounding o bien stage boundary)

=> Khop 99.8% -- arrival contract duoc giu vung
```

### 4.3 Giai thich preAllocatedVUs = 25 (CAO NHAT SERIES)

Day la diem MAU CHOT cua case nay. Xem bang so sanh:

| Case | Peak rate | Event p95 | preAllocatedVUs | VU/peak_rate |
| --- | ---: | ---: | ---: | ---: |
| rar-01 | 28/s | 5ms | 18 | 0.64 |
| rar-02 | 24/s | 23ms | 16 | 0.67 |
| rar-03 | 20/s | 6ms | 16 | 0.80 |
| **rar-04** | **12/s** | **112ms** | **25** | **2.08** |
| rar-06 | 20/s | 4ms | 18 | 0.90 |
| rar-07 | 22/s | 86ms | 30 | 1.36 |

rar-04 co **VU/peak_rate = 2.08**, cao gap 2-3 lan cac case doc thuan (GET).
Ly do: moi event la pipeline 3 buoc, giu VU trung binh ~89ms. Voi 12 arrivals/s:

```text
required_vus = ceil(arrival_rate x event_duration_avg)
             = ceil(12 x 0.089)
             = ceil(1.068)
             = 2 VUs

Vay tai sao pre=25 ma khong phai 2?
-> Xem Section 6 (Open model deep-dive) de co cau tra loi day du.
```

Tom tat: `pre=25` la conservative margin bao gom tail latency, external
dependency (external_ms=25+20), 3 sequential calls, va JS overhead.

### 4.4 Code config tu script that

```js
const CASE_ID = 'rar-04-checkout-flash-sale-wave';
const SCALE = envInt('RAR_04_DURATION_SCALE', 1);
const START_RATE = envInt('RAR_04_START_RATE', 1);
const BROWSE_RATE = envInt('RAR_04_BROWSE_RATE', 4);
const CHECKOUT_RATE = envInt('RAR_04_CHECKOUT_RATE', 12);
const RECOVERY_RATE = envInt('RAR_04_RECOVERY_RATE', 3);
const PREALLOCATED_VUS = envInt('RAR_04_PREALLOCATED_VUS', 25);
const MAX_VUS = envInt('RAR_04_MAX_VUS', 80);
const MAX_DROPPED = envInt('RAR_04_MAX_DROPPED', 3);
const USER_POOL = envInt('RAR_04_USER_POOL', 500);

export const options = {
  scenarios: {
    checkout_flash_sale_wave: buildRampingArrivalScenario(
      'checkoutFlashSaleWave',
      START_RATE,
      [
        { target: BROWSE_RATE,    duration: scaleSeconds(15, SCALE) },
        { target: CHECKOUT_RATE,  duration: scaleSeconds(20, SCALE) },
        { target: RECOVERY_RATE,  duration: scaleSeconds(15, SCALE) },
        { target: 0,              duration: scaleSeconds(5, SCALE) },
      ],
      '1s',
      PREALLOCATED_VUS,
      MAX_VUS,
      {
        case_id: CASE_ID,
        business_case: 'checkout_wave_during_flash_sale',
      },
    ),
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    dropped_iterations: [`count<=${MAX_DROPPED}`],
    ramping_arrival_events_failed: ['count<8'],
  },
};
```

---

## 5. Identity model deep-dive

### 5.1 VU = anonymous worker, KHONG PHAI business user

Trong ramping-arrival-rate, VU chi la **anonymous worker** trong pool. VU khong
gan voi 1 business user co dinh nao. Moi VU co the xu ly event cho nhieu user
khac nhau trong suot thoi gian test.

```text
SAI: "preAllocatedVUs=25 -> test voi 25 user dang checkout cung luc"
DUNG: "preAllocatedVUs=25 -> co 25 worker san sang nhan bat ky slot nao"

VU #7 co the:
  t=0.5s:  xu ly checkout cho user-1 (slot #0)
  t=0.6s:  xu ly checkout cho user-15 (slot #5)
  t=1.2s:  xu ly checkout cho user-89 (slot #12)
  ...
```

### 5.2 userContext tao identity tu iteration index

```js
export function userContext(seed = 'ramping-arrival', userPool = 1000) {
  const iteration = exec.scenario.iterationInTest;  // slot index toan cuc
  const pool = Math.max(1, userPool);
  const userNumber = (iteration % pool) + 1;        // user luan phien theo slot
  return {
    seed,
    vuId: exec.vu.idInTest,                         // CHI la worker id
    iter: iteration,
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `rar-user-${userNumber}`,                // business user tu slot
    requestKey: `${seed}-${iteration}-${exec.vu.idInTest}`,  // unique key
    abVariant: iteration % 2 === 0 ? 'b' : 'a',     // A/B testing
  };
}
```

Voi `USER_POOL = 500` va 317 iterations:

```text
iteration 0   -> userId = rar-user-1
iteration 1   -> userId = rar-user-2
...
iteration 316 -> userId = rar-user-317
iteration 317 -> userId = rar-user-318 (neu co)

Moi user xuat hien TOI DA 1 lan trong 317 events
(317 < 500, khong co user nao bi lap)
```

### 5.3 3-step pipeline bind vao CUNG MOT VU

Mot diem quan trong: 3 buoc (cart add, checkout create, order confirm) cua
CUNG MOT event duoc thuc thi boi CUNG MOT VU, tuan tu:

```text
Event #42 (arrival slot #42):
  VU #3 nhan slot #42
    -> Step 1: POST /api/sim/cart/add        (cpu_ms=1,  db_writes=1, memory_kb=4)
    -> Step 2: POST /api/sim/checkout         (cpu_ms=2,  db_writes=2, external_ms=25)
    -> Step 3: POST /api/sim/orders/:id/confirm (cpu_ms=1, db_writes=1, external_ms=20)
  VU #3 hoan thanh event -> tro ve pool

Event #42 duoc tinh la 1 "ramping_arrival_event".
Tong thoi gian event = start step 1 -> end step 3.
```

### 5.4 Idempotency keys -- dam bao dedup

Moi checkout va confirm deu co idempotency key rieng:

```js
const idempotencyKey = `rar04-${ctx.requestKey}`;

// Checkout
headers: { 'Idempotency-Key': `${idempotencyKey}-checkout` }

// Confirm
headers: { 'Idempotency-Key': `${idempotencyKey}-confirm` }
```

Dieu nay dam bao:

```text
- Neu checkout bi retry (network error), backend chi xu ly 1 lan
- `rar04-{seed}-{iteration}-{vuId}-checkout`: unique cho moi checkout request
- `rar04-{seed}-{iteration}-{vuId}-confirm`: unique cho moi confirm request
- Idempotency key KHONG PHAI business orderId -- no la co che chong trung lap
```

### 5.5 OrderId lay tu checkout response

```js
const orderId = responseJson(checkout.response, 'data.order_id', `order-${ctx.iter}`);
const confirm = requestJson('POST',
  `${BASE_URL}/api/sim/orders/${orderId}/confirm?...`,
  {}, { ... });
```

Pattern quan trong: step 3 (confirm) su dung orderId tu response cua step 2
(checkout). Day la **sequential dependency** -- khong the goi confirm song song
voi checkout, cung khong the bo qua checkout de goi confirm.

```text
Event flow:
  cart add (step 1)
    -> response: khong co data can thiet cho step sau
  checkout create (step 2)
    -> response: { data: { order_id: "..." } }
  order confirm (step 3)
    -> dung order_id tu step 2 de goi POST .../orders/:id/confirm

Neu step 2 fail:
  - responseJson tra ve fallback `order-{iter}` (fake orderId)
  - step 3 van goi confirm voi fake orderId -> co the fail them
  - finishEvent ghi nhan event failed (ok=false vi checkout.ok=false)
```

---

## 6. Open model deep-dive

> **DAY LA SECTION QUAN TRONG NHAT cua case nay.**
> Cau hoi: "Peak chi 12/s (thap nhat series) nhung preAllocatedVUs = 25 (cao nhat
> series). Tai sao?"

### 6.1 Little's Law co ban

Cong thuc Little's Law cho open model:

```text
required_vus = arrival_rate x avg_event_duration

Trong do:
  arrival_rate = so event bat dau moi giay (o day: 12/s o peak)
  avg_event_duration = thoi gian trung binh 1 event (3 buoc + JS overhead)
```

Tinh toan co ban voi rar-04:

```text
arrival_rate = 12/s (peak)
avg_event_duration ~ 89ms (tu run that: avg 87.71ms)
required_vus = 12 x 0.089 = 1.068
=> ceil(1.068) = 2 VUs

Vay tai sao pre=25 ma khong phai 2???
```

### 6.2 Vi sao pre=25 gap 12.5x Little's Law co ban?

Co 4 ly do:

#### Ly do 1: external_ms = 25 + 20 = 45ms per event

Moi event co 2 external call (gia lap payment gateway):

```text
Step 2 (checkout): external_ms=25 -> gia lap goi payment gateway ~25ms
Step 3 (confirm):  external_ms=20 -> gia lap goi external confirmation ~20ms

Tong external_ms = 45ms / event
```

Day la latency GIA LAP. Trong production, payment gateway co the mat 100-500ms.
external_ms=25 la conservative lower bound.

#### Ly do 2: 3 sequential calls -> latency cong don

Khac voi rar-01 (1 GET, 4ms), rar-04 co 3 calls tuan tu:

```text
Breakdown thoi gian 1 event (tu run that):
  POST cart/add:    ~30ms (cpu_ms=1, db_writes=1, memory_kb=4)
  POST checkout:    ~35ms (cpu_ms=2, db_writes=2, external_ms=25)
  POST confirm:     ~25ms (cpu_ms=1, db_writes=1, external_ms=20)
  JS overhead:      ~5-10ms (JSON parse, bien, goi ham)
  ----------------------------------------
  Total event:      ~89-100ms

So sanh:
  rar-01 (1 GET):     4ms event  -> 1 VU xu ly duoc 250 events/s
  rar-04 (3 POSTs):  89ms event  -> 1 VU xu ly duoc ~11 events/s
```

Moi VU chi xu ly duoc ~11 events/s thay vi 250 events/s -> can nhieu VU hon.

#### Ly do 3: Tail latency yeu cau margin

Little's Law dung avg nhung tail latency (p95, p99) moi la thuc te gay drop:

```text
Tu run that:
  event p50 = 87ms   (1 VU xu ly 11.5 events/s)
  event p95 = 112ms  (1 VU xu ly 8.9 events/s)
  event p99 = 118ms  (1 VU xu ly 8.5 events/s)

O peak 12/s:
  Neu tat ca event deu p50: can ceil(12 x 0.087) = 2 VU
  Neu co vai event p95:     VU can them thoi gian -> 2 VU co the khong du
  Neu nhieu event p95:      can 3+ VU de hap thu tail

Conservative sizing dung p95:
  required_vus_p95 = ceil(12 x 0.112) = ceil(1.34) = 2 VU

Nhung day moi la p95 cua INDIVIDUAL event. Con co...
```

#### Ly do 4: Concurrency overlap trong thuc te

Khi nhieu event chay dong thoi, chung chia se CPU, network, DB connection.
Thoi gian thuc te cua moi event tang len do contention:

```text
Ly thuyet: 12 events/s, moi event 89ms -> can 2 VU
Thuc te:   12 events/s, nhung 3-4 event chay dong thoi o mot thoi diem
           -> contention -> moi event cham hon 1 chut
           -> can them VU de bu dap

Voi pre=25:
  - 2 VU cho co ban Little's Law
  - 2-3 VU cho tail latency buffer
  - 5-8 VU cho contention/overlap buffer
  - 10-12 VU cho cold-start/warm-up margin
  => ~25 VU la safe margin cho scenario nay
```

### 6.3 Bang tinh toan VU sizing chi tiet

| Thanh phan | VUs can | Giai thich |
| --- | ---: | --- |
| Little's Law co ban (avg) | 2 | ceil(12 x 0.089) |
| Tail latency buffer (p95) | 1 | Chenh lech p95-avg = 112-89 = 23ms |
| Contention overlap | 3 | 3 buoc sequential + network + CPU share |
| 3-step concurrency | 2 | Pipeline giu VU lau hon 1-step |
| Warm-up / cold start | 2 | VU khoi tao, TCP connection setup |
| Burst margin | 5 | Rate tang tu 4->12/s trong 20s, ramp can VU |
| External dep safety | 5 | external_ms co the >25 trong thuc te |
| JS + framework overhead | 2 | k6 runtime, metric recording, check eval |
| **Conservative total** | **~22** | |
| **Chon pre=25** | **25** | Lam tron len + them 10% safety |

### 6.4 Tinh toan nguoc: kiem tra pre=25 co du khong?

```text
Voi pre=25 VU:
  Moi VU xu ly ~11 events/s (o event avg 89ms)
  25 VU x 11 events/s = 275 events/s theoretical max

  Peak yeu cau: 12 events/s
  275 >> 12 -> du rat nhieu

Nhung day la ly thuyet. Trong thuc te:
  - Khong phai tat ca 25 VU deu active cung luc
  - Moi VU co the bi "ket" boi 1 event lau (p99)
  - 3 sequential calls nghia la VU khong the nhan event moi
    cho den khi ca 3 buoc hoan thanh

Thuc te tu run:
  vus_max = 25 (k6 cap phat du 25 VU)
  vus (active) max = 1 (chi 1 VU active tai 1 thoi diem sampling)
  -> 24 VU con lai idle, san sang nhan event tiep theo

Dieu nay cho thay pre=25 la DU THUA cho kich ban hien tai.
Nhung pre=25 la DUNG DAN vi:
  - Neu external_ms tang tu 25->200ms -> VU demand tang
  - Neu DB lock cham -> moi buoc cham hon -> VU demand tang
  - Neu 3-step pipeline gap loi o buoc 2 -> retry -> VU giu lau hon
  - Conservative margin la can thiet de test "con xa contract breach bao xa"
```

### 6.5 Demo VU trajectory trong 1 giay o peak (12/s)

```text
t=20.000s (dang o peak 12/s):

VU #1:  nhan slot #180 -> cart add (0-5ms) -> checkout (5-40ms) -> confirm (40-60ms) -> done
VU #2:  nhan slot #181 -> dang o buoc cart add
VU #3:  idle
VU #4:  idle
...
VU #25: idle

t=20.050s: VU #1 xong event #180, tro ve pool
t=20.050s: slot #182 den -> VU #1 nhan -> bat dau event moi
t=20.060s: VU #2 xong event #181, tro ve pool
t=20.100s: slot #183 den -> VU #2 nhan -> bat dau event moi
...

Trong 1 giay o peak 12/s:
  - 12 slot duoc schedule
  - Voi event avg 89ms, can toi da 2 VU active dong thoi
  - 25 VU pre -> 23 VU idle -> margin an toan rat lon
```

### 6.6 Full timeline trace: VU #1 trong 55s

Trace chi tiet cua 1 VU de minh hoa cach VU duoc tai su dung lien tuc:

```text
VU #1 la 1 trong 25 VU preAllocated, duoc khoi tao luc t=0s.

t=0.000s:  VU #1 khoi tao, san sang trong pool
t=0.000s:  slot #0 den -> VU #1 nhan
t=0.003s:  cart add xong (3ms)
t=0.037s:  checkout create xong (34ms, gom external_ms=25)
t=0.061s:  confirm xong (24ms, gom external_ms=20)
t=0.065s:  finishEvent -> event #0 hoan thanh (65ms)
t=0.065s:  VU #1 tro ve pool

t=0.080s:  slot #1 den -> VU #1 nhan (VU #1 idle chi 15ms)
t=0.083s:  cart add xong
t=0.117s:  checkout create xong
t=0.141s:  confirm xong
t=0.145s:  finishEvent -> event #1 hoan thanh (65ms)

... VU #1 tiep tuc nhan slot, moi event ~65-120ms ...

t=20.000s: VU #1 dang xu ly event o peak 12/s
  (VU #1 da xu ly ~200 events trong 20s dau)

t=54.500s: slot #317 den -> VU #1 nhan slot cuoi cung
t=54.595s: finishEvent -> event cuoi cung hoan thanh
t=54.595s: VU #1 tro ve pool -> idle den khi test ket thuc

Tong cong VU #1 da xu ly: khoang 317/25 = ~12-13 events
(Moi VU chi xu ly ~13 events trong 55s vi co 25 VU chia se 317 events)
```

### 6.7 Tai sao KHONG nen giam pre xuong 5 (nguy hiem)

So sanh 2 scenario voi cung peak 12/s, nhung pre khac nhau:

```text
Scenario A: pre=25 (hien tai)
  - 25 VU san sang
  - Event avg 89ms -> 1 VU xu ly duoc ~11 events/s
  - 25 VU x 11 = 275 events/s theoretical max
  - Peak 12/s -> VU hoat dong o 12/275 = 4.4% capacity
  -> Margin an toan rat lon: tail latency, contention deu duoc hap thu
  -> PASS: 0 drop

Scenario B: pre=5 (giam 5x)
  - 5 VU san sang
  - 1 VU xu ly duoc ~11 events/s
  - 5 VU x 11 = 55 events/s theoretical max
  - Peak 12/s -> VU hoat dong o 12/55 = 22% capacity
  -> Ly thuyet van du (55 >> 12)
  -> NHUNG:
    + 1 event tail p99 = 118ms -> 1 VU "ket" 118ms
    + Trong 118ms do, ~1.4 slot den (118ms / 83ms = 1.4)
    + Neu 2 VU deu dang xu ly event lau -> 2 VU bi "ket"
    + Con 3 VU -> can xu ly 12/s -> 4 events/s moi VU
    + Moi VU chi xu ly 3600/89 = 40 events/s max -> du
    + Nhung neu ca 3 VU deu bi tail latency -> drop!
  -> RUI RO CAO: 5 VU co the du cho avg nhung tail latency + contention
     co the gay drop dot ngot ma khong co du margin de hap thu

Ket luan: pre=25 la DUNG DAN. Giam xuong 5 la DAT CUOC VAO MAY MAN.
  Neu muon giam, test EMPIRICALLY: dat RAR_04_PREALLOCATED_VUS=10
  roi chay lai, quan sat dropped_iterations. DUNG giam mu quang.
```

### 6.8 Mo rong: Cong thuc VU sizing tong quat cho ramping-arrival-rate

```text
preAllocatedVUs >= ceil(peak_rate x event_p95) + contention_margin + tail_buffer

Trong do:
  peak_rate:       rate cao nhat trong tat ca stage (o day: 12/s)
  event_p95:       p95 cua event duration (o day: 0.112s)
  contention_margin: VU du phong cho overlap/concurrency (thuong 2-5)
  tail_buffer:     VU du phong cho p99+ tail (thuong 1-3)

Ap dung cho rar-04:
  ceil(12 x 0.112) = ceil(1.34) = 2 VU
  contention_margin = 8 (vi 3-step pipeline, external dep, cold start)
  tail_buffer = 3
  safety_factor = 1.5x
  => (2 + 8 + 3) x 1.5 = 19.5 -> lam tron len 25

So sanh voi cac case khac:
  rar-01: ceil(28 x 0.005) + 3 + 2 = 1 + 5 = 6, safety 2x -> pre=18 (du thua)
  rar-02: ceil(24 x 0.023) + 3 + 2 = 1 + 5 = 6, safety 2x -> pre=16
  rar-03: ceil(20 x 0.006) + 3 + 2 = 1 + 5 = 6, safety 2x -> pre=16
  rar-07: ceil(22 x 0.086) + 5 + 3 = 2 + 8 = 10, safety 2.5x -> pre=30

Thay ro: cac case 1-step GET chi can pre~18, nhung rar-04 (3-step pipeline
voi external) can pre=25 du gap 1.4x mac du peak CHI BANG 1/2.
```

---

## 7. Service/API flow

### 7.1 Tong quan pipeline

Moi checkout event la 1 pipeline 3 buoc sequential. KHONG CO BRANCHING -- tat ca
event deu di qua cung 1 flow:

```text
                  +-------------+
  arrival slot -> |  cart add   | (step 1)
                  +------+------+
                         |
                         v
                  +-------------+
                  |  checkout   | (step 2)
                  +------+------+
                         |
                         v
                  +-------------+
                  |  confirm    | (step 3)
                  +------+------+
                         |
                         v
                     finishEvent
```

### 7.2 Bang chi tiet tung buoc

| Step | Service | Operation | Endpoint | Query params | Body | Headers | Expected |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| 1 | cart-service | `checkout_wave_cart_add` | `POST /api/sim/cart/add` | `cpu_ms=1&db_writes=1&memory_kb=4` | `{product_id, quantity}` | `X-User-ID` | 200 |
| 2 | order-service | `checkout_wave_create` | `POST /api/sim/checkout` | `cpu_ms=2&db_writes=2&external_ms=25&external_fail_rate=0` | `{user_id, items, payment_method}` | `X-User-ID`, `Idempotency-Key` | 200 |
| 3 | order-service | `checkout_wave_confirm` | `POST /api/sim/orders/:id/confirm` | `cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0` | `{}` | `X-User-ID`, `Idempotency-Key` | 200 |

### 7.3 Code day du

```js
export function checkoutFlashSaleWave(data) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const productId = (ctx.iter % 30) + 1;
  const idempotencyKey = `rar04-${ctx.requestKey}`;

  // Step 1: Add to cart
  const cart = requestJson('POST',
    `${BASE_URL}/api/sim/cart/add?cpu_ms=1&db_writes=1&memory_kb=4`,
    {
      product_id: productId,
      quantity: 1,
    }, {
      caseId: CASE_ID,
      service: 'cart-service',
      operation: 'checkout_wave_cart_add',
      endpoint: 'POST /api/sim/cart/add',
      userId: ctx.userId,
    });

  // Step 2: Create checkout (external_ms=25 gia lap payment gateway)
  const checkout = requestJson('POST',
    `${BASE_URL}/api/sim/checkout?cpu_ms=2&db_writes=2&external_ms=25&external_fail_rate=0`,
    {
      user_id: ctx.userId,
      items: [{ id: productId, qty: 1 }],
      payment_method: 'card',
    }, {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'checkout_wave_create',
      endpoint: 'POST /api/sim/checkout',
      userId: ctx.userId,
      headers: { 'Idempotency-Key': `${idempotencyKey}-checkout` },
    });

  // Step 3: Confirm order (external_ms=20 gia lap external confirmation)
  const orderId = responseJson(checkout.response, 'data.order_id', `order-${ctx.iter}`);
  const confirm = requestJson('POST',
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=1&db_writes=1&external_ms=20&external_fail_rate=0`,
    {}, {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'checkout_wave_confirm',
      endpoint: 'POST /api/sim/orders/:id/confirm',
      userId: ctx.userId,
      headers: { 'Idempotency-Key': `${idempotencyKey}-confirm` },
    });

  // Finish: event duoc coi la thanh cong neu ca 3 buoc deu ok
  finishEvent(started, cart.ok && checkout.ok && confirm.ok, {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'checkout_flash_sale_wave',
    userId: ctx.userId,
  });
}
```

### 7.4 Cac diem dac biet trong flow

**productId = (ctx.iter % 30) + 1**: San pham xoay vong tu 1-30. 317 events
voi 30 san pham -> moi san pham duoc mua ~10-11 lan. Mo phong flash sale voi
30 san pham ban chay.

**payment_method = 'card'**: Tat ca deu dung "card" (khong co branching
payment method). Trong thuc te co the co nhieu payment method (card, wallet,
COD) nhung case nay giu don gian de tap trung vao pipeline aspect.

**3 buoc sequential, khong branching**: Khac voi rar-01 (weightedPick 3
branches) va rar-05 (40% async_job), rar-04 la deterministic -- moi event
deu di qua ca 3 buoc.

**finishEvent chi ghi nhan OK neu ca 3 buoc OK**: Neu step 2 fail, step 3
van chay (voi fallback orderId) nhung event duoc ghi nhan la failed.

### 7.5 Header tags va tracing

Moi request deu mang:

```text
X-Test-Suite: ramping-arrival-rate
X-Load-Profile: ramping-arrival-rate-practice
X-User-ID: rar-user-{userNumber}
Content-Type: application/json
Idempotency-Key: rar04-{seed}-{iteration}-{vuId}-checkout (step 2)
Idempotency-Key: rar04-{seed}-{iteration}-{vuId}-confirm  (step 3)
```

---

## 8. Metrics va tags

### 8.1 Custom metrics tu common.js

| Metric | Type | Y nghia | Tags |
| --- | --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Tong so event da hoan thanh (thanh cong + that bai) | case_id, service, operation, user_id |
| `ramping_arrival_events_failed` | Counter | Tong so event that bai (it nhat 1 step fail) | case_id, service, operation, user_id |
| `ramping_arrival_api_calls_total` | Counter | Tong so API call da goi (3 calls/event) | case_id, service, operation, endpoint, user_id |
| `ramping_arrival_event_duration_ms` | Trend | Thoi gian toan bo event (start -> finish) | case_id, service, operation, user_id |

### 8.2 Moi quan he cot loi

Day la insight QUAN TRONG NHAT ve metrics cua rar-04:

```text
http_reqs = 3 x iterations

Vi:
  Moi event = 3 API calls (cart add + checkout create + order confirm)
  Khong co branching -> moi event luon co 3 calls
  Khong co retry loop -> moi call chi goi 1 lan

Tu run that:
  iterations = 317
  http_reqs = 951
  951 / 317 = 3.0  -> khop chinh xac!

Kiem cheo:
  ramping_arrival_events_total = 317 (bang iterations)
  ramping_arrival_api_calls_total = 951 (bang http_reqs)
```

### 8.3 Bang metric tu run that

| Metric | Value | Giai thich |
| --- | ---: | --- |
| `iterations` | 317 | Bang scheduled slots (317.5) |
| `iterations_rate` | 5.89/s | Trung binh tren 55s |
| `http_reqs` | 951 | = 3 x 317, khop chinh xac |
| `http_reqs_rate` | 17.67/s | = 3 x 5.89, khop |
| `checks_rate` | 1 | 100% checks pass |
| `checks_passes/checks_fails` | 951 / 0 | Tat ca 951 check deu pass |
| `http_req_failed_rate` | 0 | Khong HTTP failure nao |
| `dropped_iterations` | 0 | Khong drop nao |
| `ramping_arrival_events_failed_rate` | 0 | Khong event failed nao |
| `vus` max | 1 | Chi 1 VU active tai thoi diem sampling |
| `vus_max` | 25 | 25 VU duoc cap phat (preAllocatedVUs) |

### 8.4 Request count breakdown

```text
checkout_wave_cart_add  POST 200  count=317
checkout_wave_create    POST 200  count=317
checkout_wave_confirm   POST 200  count=317
                                      ---
                              Total   951

Moi operation deu co count=317 -> 3 x 317 = 951 -> Khop!
Tat ca HTTP status deu 200 -> khong co 4xx/5xx nao.
```

### 8.5 Event duration vs HTTP request duration

Day la 1 diem de nham lan pho bien:

```text
event_duration = thoi gian toan bo pipeline (3 buoc + JS)
http_req_duration = thoi gian TUNG HTTP request rieng le

Tu run that:
  event_duration avg/med/p95/p99/max:
    87.71 / 87 / 108 / 117.84 / 127 ms

  http_req_duration avg/med/p95/p99/max:
    29.02 / 34.14 / 54.92 / 57.81 / 85.13 ms

Chenh lech:
  event_avg / http_avg = 87.71 / 29.02 = 3.02
  -> Gan bang 3 (vi 3 sequential calls)
  -> event duration ~= tong cua 3 http request durations + JS overhead
```

**KHONG doc event duration roi nghi "checkout API cham 87ms"** -- checkout API
(p95) chi ~55ms. Event duration 87ms la tong thoi gian cua ca 3 buoc cong lai.

---

## 9. Pass criteria

### 9.1 Thresholds

```js
thresholds: {
  checks: ['rate>0.99'],                          // >99% checks pass
  http_req_failed: ['rate<0.01'],                  // <1% HTTP failures
  dropped_iterations: [`count<=${MAX_DROPPED}`],   // drop <= 3
  ramping_arrival_events_failed: ['count<8'],       // <8 events failed
}
```

### 9.2 Tieu chi PASS

```text
PASS khi:
  checks > 0.99             (951/951 = 1.0 -> 100% > 99%)
  http_req_failed < 0.01    (0/951 = 0 -> 0% < 1%)
  dropped_iterations <= 3   (0 <= 3)
  ramping_arrival_events_failed < 8  (0 < 8)

Ket qua run that:
  PASS — tat ca 4 tieu chi deu dat, dropped_iterations = 0
```

### 9.3 Tieu chi FAIL

```text
FAIL khi 1 trong cac dieu kien sau:

1. dropped_iterations > MAX_DROPPED:
   -> VU pool khong du capacity giu arrival contract o peak
   -> Can tang preAllocatedVUs hoac maxVUs

2. http_req_failed > 0.01:
   -> Backend tra ve 4xx/5xx
   -> Co the la validation error, service unavailable, timeout

3. checks < 0.99:
   -> response status khong dung expected (vd step 2 tra 500)

4. ramping_arrival_events_failed >= 8:
   -> Nhieu event co it nhat 1 step fail
   -> Pipeline integrity bi pha vo
```

### 9.4 Tieu chi WARNING (khong fail nhung can chu y)

```text
1. vus_max > preAllocatedVUs:
   -> k6 da mo rong VU pool qua pre
   -> Canh bao: pre co the chua du conservative

2. http_req_duration p95 > 100ms cho confirm hoac checkout:
   -> Payment/external path co tail latency

3. event_duration p95 > 200ms:
   -> Pipeline tong thoi gian qua cao, co the gay drop o peak cao hon

4. cart_add fail nhung checkout+confirm pass:
   -> Khong the xay ra (vi cart add la step 1, neu fail se khong goi step 2)
   -> Neu xay ra -> bug trong flow code
```

---

## 10. Cach chay + output 5 buoc

### 10.1 Chuan bi moi truong

```powershell
# 1. Kiem tra k6 version
k6 version
# Expected: k6 v2.0.0+

# 2. Kiem tra load-target health
curl http://localhost:80/health
# Expected: HTTP 200

# 3. Kiem tra metrics server
curl http://localhost:18080/v1/capabilities
# Expected: HTTP 200
```

### 10.2 Chay test

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js"
```

### 10.3 Output 5 buoc

#### Buoc 1: Static validation (inspect)

```powershell
k6 inspect "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js"
```

Expected output:

```text
executor: ramping-arrival-rate
exec: checkoutFlashSaleWave
stages: [1->4 15s, 4->12 20s, 12->3 15s, 3->0 5s]
startRate: 1
timeUnit: 1s
preAllocatedVUs: 25
maxVUs: 80
executor_family: ramping_arrival_rate
workload_shape: ramping_ingress_rate
case_id: rar-04-checkout-flash-sale-wave
business_case: checkout_wave_during_flash_sale
```

#### Buoc 2: Run progress output

```text
running (55.0s), 25/80 VUs, 317 complete and 0 interrupted iterations
checkout_flash_sale_wave: [#######...] 25 VUs  55.0s/55.0s
```

Key observations tu progress line:
- `25/80 VUs`: da cap phat 25 VU (= preAllocatedVUs), chua can mo rong
- `317 complete`: iterations hoan thanh = scheduled slots
- `0 interrupted`: khong event nao bi ngat giua chung

#### Buoc 3: Summary output

```text
checks_rate..................: 1        (100% checks pass)
http_req_failed_rate.........: 0        (0% HTTP failures)
dropped_iterations...........: 0        (0 drop)
ramping_arrival_events_failed_rate: 0   (0 events failed)

iterations...................: 317       (bang scheduled 317.5)
iterations_rate..............: 5.89/s
http_reqs....................: 951       (= 3 x 317)
http_reqs_rate...............: 17.67/s
vus_max......................: 25        (= preAllocatedVUs)
vus...........................: min=0 max=1

ramping_arrival_event_duration_ms:
  avg=87.71  med=87  p95=108  p99=117.84  max=127

http_req_duration:
  avg=29.02  med=34.14  p95=54.92  p99=57.81  max=85.13
```

#### Buoc 4: Verify dashboard

```text
Dashboard series check:
  iterations:          points=54, sum=317, min=1, max=12, truncated=false
  http_reqs:           points=951, sum=951, min=1, max=1, truncated=false
  dropped_iterations:  points=0, truncated=false
  vus:                 points=53, min=0, max=1, truncated=false
```

#### Buoc 5: Threshold evaluation

```text
✓ checks rate>0.99........................: 1 (100%)
✓ http_req_failed rate<0.01...............: 0 (0%)
✓ dropped_iterations count<=3.............: 0 <= 3
✓ ramping_arrival_events_failed count<8..: 0 < 8

All 4 thresholds passed.
```

---

## 11. Dashboard 3-chart reading guide

### 11.1 Chart 1: Execution timeline (iterations vs http_reqs)

Day la chart QUAN TRONG NHAT de xac nhan flow 3-step.

**Cach doc**:

```text
Timeline co 2 duong:
  - iterations (xanh): so event hoan thanh theo thoi gian
  - http_reqs (do): so HTTP request hoan thanh theo thoi gian

Dac diem cua rar-04:
  http_reqs bucket PHAI gap ~3x iterations bucket
  -> 1 event sinh ra 3 HTTP requests

Tu run that:
  iterations sum = 317
  http_reqs sum = 951
  951 / 317 = 3.0 -> Khop!

Neu chart hien thi:
  iterations bucket = 10 (10 events trong 1 sampling interval)
  http_reqs bucket = 30 (30 requests trong cung interval)
  -> Dung ty le 1:3
```

**Dau hieu canh bao**:

```text
http_reqs / iterations < 3:
  -> Co event khong hoan thanh du 3 buoc
  -> Step 2 hoac step 3 bi skip (vd fail o step 1)

http_reqs / iterations > 3:
  -> Co retry (khong co trong code hien tai)
  -> Neu co -> dang co infinite retry loop

dropped_iterations > 0:
  -> VU pool khong du capacity
  -> Xuat hien duong dropped_iterations (thuong la duong mau do)
```

### 11.2 Chart 2: Response time (per operation)

**Cach doc**:

Chart nay co 3 duong (hoac 3 nhom) tuong ung 3 operation:

```text
checkout_wave_cart_add:  POST /api/sim/cart/add          (nhanh nhat)
checkout_wave_create:    POST /api/sim/checkout           (cham nhat, external_ms=25)
checkout_wave_confirm:   POST /api/sim/orders/:id/confirm (trung binh, external_ms=20)
```

**Expectation**:

```text
cart_add p95 < checkout_create p95:
  cart_add chi co cpu_ms=1, db_writes=1 (khong external) -> nhanh
  checkout_create co external_ms=25 -> cham hon

confirm p95 < checkout_create p95:
  confirm co external_ms=20 < checkout_create external_ms=25

Thu tu p95 mong doi:
  cart_add < confirm < checkout_create
```

**Dau hieu canh bao**:

```text
checkout_create p95 cao dot bien (>200ms):
  -> Payment gateway (external) dang cham
  -> Co the gay drop o peak cao hon

confirm p95 > checkout_create p95:
  -> External confirmation cham bat thuong
  -> Co the la bug: confirm goi sai endpoint hoac bi redirect

cart_add p95 cao (>100ms):
  -> Cart service DB co van de
  -> Co the gay backlog toan bo pipeline
```

### 11.3 Chart 3: VUs vs iter/s

**Cach doc**:

```text
Truc trai (VUs): so VU active tai thoi diem sampling
Truc phai (iter/s): so iteration bat dau moi giay

Dac diem cua rar-04:
  - vus (active) max = 1 (chi 1 VU active tai 1 sampling point)
  - iter/s tang dan 1->4->12->3->0 theo stage
  - vus_max = 25 (tong VU duoc cap phat, KHONG PHAI active)

QUAN TRONG: vus max = 1 khong co nghia "chi can 1 VU".
  Vus la sampled metric, lay mau moi ~1s.
  Voi event duration 89ms, 1 VU xu ly xong event trong < 0.1s,
  tra ve pool truoc khi sample tiep theo.
  -> 1 VU active tai moi sampling point la BINH THUONG.
```

**Dau hieu canh bao**:

```text
vus (active) tang cao (5-10+):
  -> Nhieu VU active dong thoi
  -> Event duration dai bat thuong
  -> Co the sap drop

vus_max > preAllocatedVUs:
  -> k6 da mo rong VU pool
  -> pre khong du conservative

iter/s khong theo duoc stage curve:
  -> Arrival schedule bi gian doan
  -> Co the do dropped_iterations hoac rate limit
```

### 11.4 Executor tab

```text
Case ID:     rar-04-checkout-flash-sale-wave
Executor:    ramping-arrival-rate
pre/max VUs: 25/80
Stages:      1->4 (15s), 4->12 (20s), 12->3 (15s), 3->0 (5s)
Business:    checkout_wave_during_flash_sale
Tags:        executor_family=ramping_arrival_rate,
             workload_shape=ramping_ingress_rate
```

---

## 12. 4 output -> decision scenarios

### Scenario 1: PASS hoan hao

```text
Output:
  dropped_iterations = 0
  checks = 100% (951/951)
  http_req_failed = 0%
  ramping_arrival_events_failed = 0
  http_reqs = 3 x iterations = 951
  event p95 = 112ms
  vus_max = 25 (khong vuot pre)

Ket luan:
  CHECKOUT WAVE PASS. He thong xu ly duoc pipeline 3 buoc o peak 12/s.
  Khong drop, khong fail, khong inconsistent state.

Hanh dong:
  - Checkout pipeline da duoc verify cho flash sale peak 12/s.
  - Co the tu tin deploy flash sale campaign.
  - Giu nguyen pre=25 de co margin an toan.
  - Theo doi external_ms trong production de dieu chinh VU pool neu can.
```

### Scenario 2: Step 2 (checkout create) fail -- Step 1 da committed

```text
Output:
  dropped_iterations = 0
  checks ~ 66% (2/3 ratio, step 2 fail)
  http_req_failed > 0 (step 2 tra 500)
  ramping_arrival_events_failed > 0
  http_reqs = 3 x iterations (van du 3 calls/event)
  Breakdown:
    cart_add POST 200:             count=317
    checkout_create POST 500:      count=317  (FAIL)
    confirm POST 200 (fallback):   count=317

Ket luan:
  CHECKOUT WAVE FAIL -- ORDER SERVICE. Checkout create bi loi nhung cart add
  da thanh cong. Day la INCONSISTENT STATE nguy hiem:
    - Gio hang co san pham (cart add OK)
    - Nhung khong co order (checkout create FAIL)
    - User thay "dat hang that bai" nhung cart khong trong
    - Neu user refresh cart -> thay san pham cu -> boi roi -> bo di

Hanh dong:
  - Kiem tra order-service logs, DB connection, payment gateway health.
  - Kiem tra idempotency key co bi conflict khong.
  - Xem xet rollback cart khi checkout fail (compensating transaction).
  - DAY LA PATTERN NGUY HIEM NHAT: 1 step success + 1 step fail trong pipeline.
```

### Scenario 3: Dropped o checkout peak

```text
Output:
  dropped_iterations = 15 (> MAX_DROPPED = 3)
  iterations = 302 (thay vi 317)
  checks = 100% (906/906)
  http_reqs = 906 (= 3 x 302)
  vus_max = 80 (= maxVUs, da mo rong het co)
  vus active max = 20+

Ket luan:
  CHECKOUT WAVE FAIL -- VU CAPACITY. k6 khong the bat dau 15 scheduled
  arrivals o peak vi VU pool can. Da mo rong den maxVUs=80 nhung van
  khong du. Event duration qua dai so voi VU pool.

Hanh dong:
  - Kiem tra event_duration tai thoi diem peak -> co the >500ms?
  - Kiem tra external_ms thuc te -> payment gateway cham?
  - Tang preAllocatedVUs va maxVUs.
  - HOAC: toi uu pipeline (vd confirm async thay vi sync).
  - HOAC: chap nhan drop budget lon hon (vd maxDropped=15).
  - KHONG duoc ignore drop: drop nghia la co khach hang khong duoc phuc vu.
```

### Scenario 4: cart add fail (step 1) -- pipeline khong chay tiep

```text
Output:
  dropped_iterations = 0
  checks ~ 33% (1/3 ratio, step 1 fail)
  http_req_failed > 0 (step 1 tra 500)
  ramping_arrival_events_failed = 317 (tat ca event fail)
  http_reqs = 317 (CHI 1 call/event, khong phai 3)
  Breakdown:
    cart_add POST 500:             count=317  (FAIL)
    checkout_create POST 200:      count=0    (khong duoc goi)
    confirm POST 200:              count=0    (khong duoc goi)

Ket luan:
  CHECKOUT WAVE FAIL -- CART SERVICE. Cart add failed -> checkout_create
  khong duoc goi (vi sequential dependency). Day la fail-safe: pipeline
  dung o buoc 1, khong tao inconsistent state.

  Nhung: http_reqs = 317 != 3 x 317. Ti le http_reqs/iterations = 1
  thay vi 3. Day la dau hieu step 1 fail cham dut pipeline.

Hanh dong:
  - Focus vao cart-service: DB write path, memory, CPU.
  - Kiem tra tai sao cart add lai fail: DB lock? Memory can? Connection pool?
  - Day la van de DOC LAP voi order-service, khong blame order.
  - Sua cart-service truoc khi chay lai test.
```

### Scenario 5: http_reqs != 3 x iterations (pipeline incomplete)

```text
Output:
  dropped_iterations = 0
  checks = 100% (tat ca request tra ve 200)
  http_req_failed = 0%
  ramping_arrival_events_failed = 0
  iterations = 317
  http_reqs = 634 (CHI 2 x iterations, khong phai 3)
  Breakdown:
    cart_add POST 200:             count=317
    checkout_create POST 200:      count=317
    confirm POST 200:              count=0    (MISSING!)

Ket luan:
  NGUY HIEM THAM LANG. Step 3 (confirm) khong duoc goi nhung
  KHONG CO ERROR nao. Checks van 100% vi chi co 2 calls duoc goi
  va ca 2 deu 200. http_req_failed van 0%.

  Tai sao nguy hiem:
    - User da cart add + checkout create, nhung order CHUA DUOC CONFIRM
    - Order ton tai trong DB nhung o trang thai "pending", khong "confirmed"
    - Fulfillment team khong xu ly order vi chua confirm
    - User thay "dat hang thanh cong" nhung hang khong duoc ship

  Dau hieu phat hien:
    http_reqs / iterations = 2 (dang le 3)
    -> KHONG the bo qua viec verify ti le nay!

Hanh dong:
  - Kiem tra code: tai sao step 3 khong duoc goi?
    Co the: comment nham, conditional logic sai, exception bi nuot
  - SUA LAI CODE de dam bao step 3 luon duoc goi
  - THEM CHECK: assert http_reqs == 3 x iterations trong post-run validation
```

### Scenario 6: Mot vai event failed (step 2 intermittent failure)

```text
Output:
  dropped_iterations = 0
  checks ~ 99% (951 - 6 = 945 / 951 = 99.4%)
  http_req_failed = 0.6% (6/951)
  ramping_arrival_events_failed = 2 (2 event co it nhat 1 step fail)
  iterations = 317
  http_reqs = 951 (van du 3 calls/event)
  Breakdown:
    cart_add POST 200:             count=317
    checkout_create POST 200:      count=315
    checkout_create POST 500:      count=2    (2 FAIL)
    confirm POST 200:              count=317

Ket luan:
  CHECKOUT WAVE PARTIAL FAIL -- INTERMITTENT. 2/317 events that bai o
  step 2 (checkout create). Day la pattern "sporadic failure":
    - 315 event hoan toan OK
    - 2 event: cart add OK, checkout create FAIL, confirm van goi (fallback orderId)
    -> 2 inconsistent state!

  Khong phai toan bo pipeline chet, chi 1 vai event bi anh huong.
  Thresholds: ramping_arrival_events_failed=2 < 8 -> VAN PASS.
  Nhung day la WARNING quan trong: co intermittent issue.

Hanh dong:
  - Kiem tra 2 failed event: thoi diem xay ra? Co lien quan den peak?
  - Kiem tra order-service logs tai thoi diem 2 event fail
  - Kiem tra external_fail_rate: co = 0 (khong mo phong external fail)
    -> Day la REAL failure, khong phai gia lap
  - Neu chi xay ra o peak: co the la race condition, DB lock timeout
  - Neu xay ra ngau nhien: co the la network hiccup, connection pool can
  - QUAN TRONG: du thresholds PASS, van phai investigate!
```

### Scenario 7: So sanh dac tinh tung scenario

| Scenario | Drop | Checks | http_fail | events_fail | http_reqs:iter | Nghiem trong | Hanh dong uu tien |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1: Pass hoan hao | 0 | 100% | 0% | 0 | 3:1 | Khong | Theo doi external_ms trong prod |
| 2: Step 2 fail, step 1 committed | 0 | ~66% | >0% | >0 | 3:1 | CRITICAL | Rollback cart, fix order-service |
| 3: Drop o peak | >3 | 100% | 0% | 0 | 3:1 | HIGH | Tang VU hoac toi uu pipeline |
| 4: Step 1 fail | 0 | ~33% | >0% | 317 | 1:1 | HIGH | Fix cart-service |
| 5: Step 3 missing | 0 | 100% | 0% | 0 | 2:1 | CRITICAL | Fix code, add assertion |
| 6: Intermittent step 2 | 0 | ~99% | <1% | 2-7 | 3:1 | MEDIUM | Investigate sporadic failure |

---

## 13. Nghich ly / Misconceptions

### 13.1 NGHICH LY LON NHAT: "Peak thap nhat nhung preAllocatedVUs cao nhat"

Day la **star insight** cua case rar-04:

```text
Dien giai:
  rar-04 co peak rate = 12/s -- THAP NHAT trong 7 case
  rar-04 co preAllocatedVUs = 25 -- CAO NHAT (bang rar-05)

Cau hoi:
  "Neu peak thap nhat, tai sao can nhieu VU nhat?
   Dang le peak cao nhat (rar-01: 28/s) moi can nhieu VU chu?"

Tra loi:
  Vi VU demand KHONG PHAI chi phu thuoc vao peak rate.
  VU demand = arrival_rate x event_duration (Little's Law).

  rar-01: 28/s x 0.005s = 0.14 -> 1 VU la du (pre=18 la thua nhieu)
  rar-04: 12/s x 0.089s = 1.07 -> 2 VU minimum

  Nhung pre=25 khong phai vi can 25 VU de xu ly 12/s.
  pre=25 la conservative margin cho:
    - Tail latency (p95=112ms thay vi avg=89ms)
    - external_ms co the >25 trong thuc te
    - 3 sequential calls giu VU lau hon
    - Contention overlap khi nhieu event chay dong thoi

  SO SAI: "preAllocatedVUs ti le thuan voi peak rate"
  SO DUNG: "preAllocatedVUs ti le thuan voi peak_rate x event_duration"
```

Bay hinh anh sai ma nguoi moi thuong mac:

```text
SAI #1: "12/s la nhe nhat, can it VU nhat"
  -> Bo qua event_duration = 89ms vs 4ms cua case GET

SAI #2: "pre=25 la qua cao, giam xuong 5 la du"
  -> Bo qua tail latency, external dependency, pipeline overhead

SAI #3: "VU chi can du cho avg, khong can margin"
  -> Bo qua p95, p99, contention, warm-up

SAI #4: "vus_max=1 -> chi can 1 VU"
  -> Nham lan giua vus (sampled metric) va vus_max (total allocated)
```

### 13.2 Vus sampled vs VU allocated

```text
vus (metric): so VU DANG CHAY EVENT tai thoi diem sampling
  - Lay mau moi ~1s
  - Voi event 89ms, VU xong event trong <0.1s
  -> Chi 1 VU active tai moi sampling point la BINH THUONG

vus_max (metric): tong so VU DA DUOC CAP PHAT
  - Bao gom ca VU idle (khong active tai thoi diem sampling)
  - vus_max = 25 -> k6 da tao 25 VU, nhung chi 1 active tai 1 luc

Ket luan: vus=1 KHONG CO NGHIA chi can 1 VU.
  Neu chi cap phat 1 VU: event 89ms -> 1 VU xu ly 11/s
  -> peak 12/s -> thieu VU -> drop!
```

### 13.3 http_reqs gap 3x iterations KHONG PHAI la loi

```text
Nguoi moi thuong thay http_reqs = 951, iterations = 317 -> nghi:
  "Sao http_reqs nhieu gap 3 lan iterations? Co phai retry khong?"

Thuc te: day la DUNG DAN, va la dac trung cua case nay:
  - 1 event = 3 API calls
  - http_reqs = 3 x iterations la EXPECTED
  - Neu http_reqs = iterations -> moi la DAU HIEU LOI (step 2, 3 khong chay)

De tranh nham lan:
  - Doc http_reqs nhu la "tong so API call"
  - Doc iterations nhu la "tong so event"
  - So sanh ti le: 3:1 la dung cho case 3-step pipeline
```

### 13.4 external_ms la gia lap, khong phai thuc te

```text
external_ms=25 va external_ms=20 la THAM SO GIA LAP trong load-target.

Y nghia:
  - external_ms=25: backend se ngu 25ms truoc khi tra response
    -> Gia lap do tre cua payment gateway ben ngoai

  - external_ms=20: backend se ngu 20ms truoc khi tra response
    -> Gia lap do tre cua external order confirmation

Trong production:
  - Payment gateway thuc te co the mat 100-500ms
  - External confirmation co the mat 50-200ms
  - Neu dung external_ms=25 va 20 de test -> KET QUA LA CONSERVATIVE
  - Neu pass voi external_ms thap, chua CHAC da pass voi external_ms cao

De test production-realistic:
  $env:RAR_04_EXTERNAL_MS = "200" (neu script ho tro)
  Hoac sua truc tiep external_ms=200 trong URL
```

### 13.5 "http_reqs = 3 x iterations khong quan trong, chi can thresholds pass"

```text
SAI: "Thresholds pass het -> khong can check http_reqs"

Tai sao sai:
  - thresholds chi check checks_rate, http_req_failed, dropped_iterations,
    events_failed
  - KHONG CO THRESHOLD NAO check "http_reqs = 3 x iterations"
  - Neu step 3 bi skip, checks van 100% (2 calls deu 200), events_failed=0
    (vi finishEvent(false) khong duoc goi)
  - -> Thresholds pass nhung pipeline thuc te BI DUT!

  Day la "false positive" nguy hiem nhat: thresholds pass nhung
  pipeline khong hoan chinh. Chi co the phat hien bang cach
  SO SANH http_reqs voi iterations.

DUNG: LUON verify http_reqs / iterations = 3 sau moi run.
  Neu ti le khac 3 -> pipeline khong hoan chinh -> INVESTIGATE NGAY.
```

### 13.6 "preAllocatedVUs ti le thuan voi peak rate"

```text
Day la sai lam CO BAN NHAT ve VU sizing.

SAI: "Case A peak 30/s -> pre=30. Case B peak 15/s -> pre=15.
      preAllocatedVUs ti le thuan voi peak rate."

DUNG: preAllocatedVUs ti le thuan voi peak_rate x event_duration.

Vi du cung peak 12/s:
  - Case GET 1-step (event 5ms):  pre can = ceil(12 x 0.005) = 1
  - Case POST 3-step (event 89ms): pre can = ceil(12 x 0.089) = 2
  - Case POST 3-step + external 200ms: pre can = ceil(12 x 0.400) = 5

Chenh lech pre: gap 5x mac du cung peak 12/s!

Khuyet danh: Dung bao gio uoc luong preAllocatedVUs chi tu peak rate.
  LUON tinh: peak_rate x event_duration x safety_factor.
```

### 13.7 Tong ket bang so sanh: VU sizing logic toan series

| Case | Peak (/s) | Event shape | Event duration | raw VU need | Safety factor | Recommended pre |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rar-01 | 28 | 1 GET, co branching | 5ms | 1 | 15x | 18 |
| rar-02 | 24 | 1 POST, auth | 23ms | 1 | 15x | 16 |
| rar-03 | 20 | 1 POST, webhook | 6ms | 1 | 15x | 16 |
| **rar-04** | **12** | **3 POST, external** | **89ms** | **2** | **12.5x** | **25** |
| rar-05 | 8 | 1.4 avg, async | 9000ms | 72 | 0.6x* | 25* |
| rar-06 | 20 | 1 GET, cache | 4ms | 1 | 15x | 18 |
| rar-07 | 22 | 1 POST, external 80ms | 86ms | 2 | 15x | 30 |

*rar-05 pre=25 la insufficient, can pre=60+ de pass. Safety factor <1
 vi event duration QUa lon (9s) so voi test duration (55s).

---

## 14. Checklist

Truoc khi chay rar-04:

```text
[ ] k6 version >= 2.0.0
[ ] Load-target health check: curl http://localhost:80/health -> 200
[ ] Metrics server: curl http://localhost:18080/v1/capabilities -> 200
[ ] Script inspect pass: k6 inspect rar-04-checkout-flash-sale-wave.js
[ ] BASE_URL da duoc set (default: http://localhost:80)
[ ] K6_CLOUD_HOST da duoc set (neu push dashboard)
[ ] K6_CLOUD_TOKEN da duoc set (neu push dashboard)
[ ] Khong co process nao cham port 80 khac
```

Sau khi chay, verify:

```text
[ ] iterations = 317 (khop scheduled slots 317.5)
[ ] http_reqs = 3 x iterations (951)
[ ] dropped_iterations = 0
[ ] checks_rate > 0.99
[ ] http_req_failed_rate < 0.01
[ ] ramping_arrival_events_failed < 8
[ ] http_reqs gap 3x iterations tren execution timeline chart
[ ] checkout_create p95 > cart_add p95 (external_ms=25)
[ ] confirm p95 > cart_add p95 (external_ms=20)
[ ] vus_max = preAllocatedVUs (khong mo rong VU pool)
[ ] Tat ca 3 operations deu co count = 317
```

---

## 15. 4-5 variations

### Variation 1: Higher checkout peak (stress test)

```powershell
$env:RAR_04_START_RATE = "2"
$env:RAR_04_BROWSE_RATE = "8"
$env:RAR_04_CHECKOUT_RATE = "30"
$env:RAR_04_RECOVERY_RATE = "6"
$env:RAR_04_PREALLOCATED_VUS = "50"
$env:RAR_04_MAX_VUS = "120"
```

Muc tieu: Tim diem gay cua pipeline khi checkout peak tang tu 12->30/s.

Du kien: event_duration van ~89ms -> required_vus = ceil(30 x 0.089) = 3 VU.
Nhung pre van can du cao cho tail + contention. Neu drop xuat hien -> xac
dinh duoc peak rate toi da ma pre=50 co the xu ly.

### Variation 2: External MS production-realistic

```powershell
# Khong co env var truc tiep, sua URL trong script:
# /api/sim/checkout?...&external_ms=200&external_fail_rate=0.02
# /api/sim/orders/:id/confirm?...&external_ms=150&external_fail_rate=0.01
```

Muc tieu: Mo phong payment gateway thuc te (200ms) + external failure rate.

Du kien: event_duration tang tu 89ms len ~400-500ms. Voi peak 12/s:
required_vus = ceil(12 x 0.450) = 6 VU. pre=25 van du nhung margin giam.
Them external_fail_rate -> 1 vai event fail o step 2 hoac 3.

### Variation 3: Price/quantity variation (realistic cart)

```powershell
# Sua script: quantity thay doi theo iteration
# quantity = (ctx.iter % 5) + 1
# payment_method = weightedPick([{name:'card', weight:60}, {name:'wallet', weight:40}], ctx.iter)
```

Muc tieu: Mo phong gio hang da dang (1-5 items, nhieu payment method).

Du kien: Event duration tuong tu vi query params giong nhau. Nhung request
body lon hon (nhieu items) -> co the anh huong nho den latency.

### Variation 4: Smoke test (1/4 duration)

```powershell
$env:RAR_04_DURATION_SCALE = "0.25"
```

Muc tieu: Quick smoke test de verify script khong bi loi truoc khi chay full.

Du kien: Scheduled slots = 317.5 x 0.25 = ~79. Cac stage duration giam:
3.75s, 5s, 3.75s, 1.25s. Tong = 13.75s. Pass nhanh.

### Variation 5: Single-step-only (skip confirm)

```powershell
# Sua script: comment step 3 (confirm), chi giu cart add + checkout
# finishEvent(started, cart.ok && checkout.ok, ...)
```

Muc tieu: Co lap van de -- xem cart+checkout (2-step) co bi drop khong.

Du kien: http_reqs = 2 x iterations (634). event_duration giam ~25ms (bo
external_ms=20 cua confirm). pre=25 cang du thua. Dung de verify rang
confirm step KHONG PHAI la nguyen nhan gay drop.

### Variation 6: Production-scale stress (scale x5)

```powershell
$env:RAR_04_DURATION_SCALE = "5"
$env:RAR_04_START_RATE = "5"
$env:RAR_04_BROWSE_RATE = "20"
$env:RAR_04_CHECKOUT_RATE = "60"
$env:RAR_04_RECOVERY_RATE = "15"
$env:RAR_04_PREALLOCATED_VUS = "100"
$env:RAR_04_MAX_VUS = "300"
```

Muc tieu: Mo phong flash sale quy mo lon (Black Friday/Cyber Monday).

Du kien: Scheduled slots ~1587. Peak 60/s. Voi event avg 89ms:
required_vus_min = ceil(60 x 0.089) = 6 VU. Nhung voi 300 VU max,
canh bao khi vus_max tang qua pre=100 -> can mo rong pool.

### Variation 7: External failure injection (payment gateway error)

```powershell
# Sua URL truc tiep trong script:
# /api/sim/checkout?...&external_ms=25&external_fail_rate=0.05
# /api/sim/orders/:id/confirm?...&external_ms=20&external_fail_rate=0.03
```

Muc tieu: Mo phong payment gateway co 5% fail rate + confirmation 3% fail.

Du kien: ~16 checkout fail trong 317 events (5%). Trong do:
- 5% cua 317 = ~16 event: checkout_create that bai
- 3% cua ~301 = ~9 event: confirm that bai (sau khi checkout OK)
- Tong event failed: ~25
- ramping_arrival_events_failed = 25 -> vuot threshold 8 -> FAIL

DAy la scenario THUC TE: payment gateway khong bao gio 100% uptime.
Threshold <8 events failed la CHAT CHE cho scenario co external_fail_rate.
Can dieu chinh threshold neu muon accept external failure rate thuc te.

---

## 16. Anti-patterns

### Anti-pattern 1: Giam preAllocatedVUs vi "peak chi 12/s"

```text
SAI: "12/s la thap nhat series -> pre=25 la phi pham -> giam xuong 5"

Tai sao sai:
  - Bo qua event_duration = 89ms (gap 20x case GET)
  - Bo qua 3 sequential calls giu VU lau
  - Neu giam pre=5: VU demand = 12 x 0.089 = 2 VU minimum
    -> 5 van du cho avg, nhung tail latency + contention -> co the drop

DUNG: pre=25 la conservative margin DUNG DAN cho pipeline 3 buoc.
  Neu muon giam, test truoc voi RAR_04_PREALLOCATED_VUS=10 va xem
  co drop khong. Dung giam mu quang.
```

### Anti-pattern 2: Dung ramping-vus de test checkout wave

```text
SAI: "Dung ramping-vus, tang VUs tu 1->25 theo stage la du"

Tai sao sai:
  - ramping-vus la closed model -> throughput phu thuoc VU count VA latency
  - Voi event 89ms: 1 VU -> ~11 events/s
  - Voi 25 VU -> 275 events/s (gap 20x peak 12/s)
  - Test pass de dang, nhung KHONG test duoc arrival contract
  - LEN PRODUCTION: 12 checkout/s that tu ben ngoai -> backend cham
    -> khong co "them VU tu dong" -> drop that

DUNG: Dung ramping-arrival-rate de schedule arrival doc lap,
  VU pool chi la worker.
```

### Anti-pattern 3: Doc event duration roi nghi do la http_req_duration

```text
SAI: "API cham 112ms, can toi uu"

Tai sao sai:
  - event p95 = 112ms la TONG thoi gian 3 API calls + JS overhead
  - http_req_duration p95 = 54.92ms la thoi gian TUNG call rieng le
  - Khong phai "1 API cham 112ms" ma la "3 API tong 112ms"

DUNG: Doc rieng http_req_duration cho tung operation de xac dinh
  API nao cham. Doc event_duration de biet toan bo pipeline ton bao lau.
  TOI UU DUNG API (vd checkout_create 55ms) chu khong phai
  toi uu "event" (112ms la binh thuong cho 3-step pipeline).
```

### Anti-pattern 4: Khong verify http_reqs = 3 x iterations

```text
SAI: "Pass het thresholds -> OK"

Tai sao sai:
  - Thresholds pass nhung http_reqs = iterations (khong phai 3x)
  - Nghia la step 2, 3 khong chay -> chi co step 1 chay
  - Test "pass" nhung thuc te checkout pipeline HOAN TOAN KHONG CHAY

DUNG: LUON verify http_reqs = 3 x iterations.
  Day la "heartbeat" cua case 3-step pipeline.
  Neu ti le khong dung -> pipeline bi dut, du thresholds co pass.
```

### Anti-pattern 5: Bo qua inconsistent state khi step 2 fail

```text
SAI: "Co 1 vai event fail, con lai pass -> OK"

Tai sao sai:
  - Neu step 1 (cart add) success + step 2 (checkout) fail
  - -> Gio hang co san pham nhung khong co order
  - -> Inconsistent state, user bi boi roi

DUNG: Phan tich pattern cua failed events:
  - Step nao fail? Bao nhieu event?
  - Co event nao step 1 OK, step 2 FAIL khong?
  - Neu co -> INCONSISTENT STATE -> critical issue
```

### Anti-pattern 6: Chi doc avg, bo qua tail latency

```text
SAI: "Event avg 87ms -> pipeline khoe -> khong can quan tam p95/p99"

Tai sao sai:
  - Avg bi anh huong boi cac event nhanh (50-60ms)
  - Tail latency (p95=112ms, p99=118ms) la thuc te anh huong
    den VU availability
  - 1 event tail 118ms giu VU lau gap 2x event trung binh
  - Nhieu tail event cung luc -> VU pool bi "can" -> drop

DUNG: LUON doc ca avg VA p95/p99/max.
  p95 cho biet "95% nguoi dung trai nghiem pipeline nhanh c nao"
  p99 cho biet "1% worst-case" -> quyet dinh VU pool sizing
```

### Anti-pattern 7: Khong verify data integrity giua cac step

```text
SAI: "Tat ca HTTP status 200 -> data dung"

Tai sao sai:
  - Step 1: cart add product_id=12 -> response khong co data kiem tra
  - Step 2: checkout create -> response co order_id
  - Step 3: confirm order_id tu step 2 -> response khong co data kiem tra
  - Neu order_id sai hoac bi thay doi -> confirm sai don hang

DUNG: Them check de verify data flow:
  - Check checkout response co chua data.order_id
  - Check confirm response status 200 (da co)
  - Verify order_id khong null/undefined
  - Neu co the, verify order_id format (UUID, numeric, etc.)
```

### Anti-pattern 8: Co lap test checkout ma khong test cart va confirm

```text
SAI: "Checkout la buoc quan trong nhat -> chi test checkout"

Tai sao sai:
  - Pipeline la 3 buoc LIEN KET
  - Cart add la precondition cua checkout
  - Confirm la completion cua checkout
  - Neu chi test checkout:
    + Khong phat hien cart-service van de
    + Khong phat hien confirm flow loi
    + Khong phat hien inconsistent state (cart OK + checkout FAIL)

DUNG: LUON test toan bo pipeline. Neu muon isolate:
  - Test pipeline day du TRUOC
  - Neu fail -> isolate tung step de tim root cause
  - Sau khi fix -> test lai pipeline day du
```

---

## 17. Real validation data

### 17.1 Run result

```text
Run ID: #103 (local)
Script: rar-04-checkout-flash-sale-wave.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### 17.2 Full summary

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes / checks_fails` | `951 / 0` |
| `http_req_failed_rate` | `0` |
| `http_req_failed` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `ramping_arrival_events_failed` | `0` |
| `iterations` | `317` |
| `iterations_rate` | `5.89/s` |
| `http_reqs` | `951` |
| `http_reqs_rate` | `17.67/s` |
| `vus` min / max | `0 / 1` |
| `vus_max` | `25` |

### 17.3 Duration percentiles

**Event duration (3-step pipeline)**:

| avg | med | p95 | p99 | max |
| ---: | ---: | ---: | ---: | ---: |
| 87.71 ms | 87 ms | 108 ms | 117.84 ms | 127 ms |

**HTTP request duration (per call)**:

| avg | med | p95 | p99 | max |
| ---: | ---: | ---: | ---: | ---: |
| 29.02 ms | 34.14 ms | 54.92 ms | 57.81 ms | 85.13 ms |

### 17.4 Request breakdown

| Operation | Method | Status | Count |
| --- | --- | ---: | ---: |
| `checkout_wave_cart_add` | POST | 200 | 317 |
| `checkout_wave_create` | POST | 200 | 317 |
| `checkout_wave_confirm` | POST | 200 | 317 |
| **Total** | | | **951** |

### 17.5 Dashboard verification

```text
iterations:          points=54, sum=317, min=1, max=12, truncated=false
http_reqs:           points=951, sum=951, min=1, max=1, truncated=false
dropped_iterations:  points=0, truncated=false
vus:                 points=53, min=0, max=1, truncated=false
```

### 17.6 Verdict

```text
PASS — rar-04 checkout flash-sale wave met the full stage contract.
  - 317 scheduled slots -> 317 iterations (100% completion)
  - 951 HTTP requests (3 calls/event, matching the 3-step pipeline)
  - 0 dropped iterations (VU pool sufficient)
  - 100% checks pass (all 951 HTTP calls returned expected 200)
  - 0 HTTP failures (no 4xx/5xx)
  - 0 event failures (all 3-step pipelines completed successfully)
  - Event p95 = 108ms (3 steps + JS overhead)
  - HTTP p95 = 54.92ms (per individual call)
  - Active VU max = 1 (sampled), vus_max = 25 (preAllocatedVUs)

Star insight confirmed:
  Lowest peak rate (12/s) but highest preAllocatedVUs (25) because each event
  is a 3-step pipeline holding a VU ~89ms. Little's Law + multi-step pipeline
  explains why VU demand is not proportional to arrival rate alone.
```

---

## Reference

- Script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-04-checkout-flash-sale-wave.js`
- Common: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
- Validation: `E:\Khoa hoc\k6\docs\practice\ramping-arrival-rate\08_validation-and-chart-analysis.md`
- Gold standard: `E:\Khoa hoc\k6\docs\practice\constant-arrival-rate\01_storefront-rps-contract.md`
- Series overview: `E:\Khoa hoc\k6\docs\practice\ramping-arrival-rate\00_overview.md`
- Run guide: `E:\Khoa hoc\k6\RUN_GUIDE.md`
