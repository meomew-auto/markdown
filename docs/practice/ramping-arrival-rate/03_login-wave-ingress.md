# Case 03: Payment Webhook Wave

> **Script:** `rar-03-payment-webhook-wave.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 20 arrivals/s
> **Focus:** payment-provider webhook wave ingress -- hệ thống của bạn nhận callback wave từ external provider.

---

## 1. Tinh huong thuc te

### Boi canh kinh doanh

Mot payment provider (vi du nhu Stripe, VNPay, MoMo) xu ly thanh toan cho nguoi dung
cuoi. Sau khi thanh toan hoan tat, provider **day webhook callback** ve order service
cua ban de xac nhan trang thai don hang:

```text
Nguoi dung thanh toan tren app
        |
        v
[Payment Provider] ---- thanh toan thanh cong
        |
        +-----> POST /webhooks/payment  (event #1)
        +-----> POST /webhooks/payment  (event #2)
        +-----> POST /webhooks/payment  (event #3)
        | ...
        v
[Order Service cua ban] ----> cap nhat order status = 'paid'
```

Day la external producer: provider quyet dinh **toc do** va **hinh dang** cua wave
gui callback. He thong cua ban khong the noi "backend cham nen provider gui cham lai".
Ban phai **hap thu wave** dung nhu no den.

### Dac diem cua webhook wave

Provider khong gui callback deu dan. Trong thuc te, webhook callback thuong co hinh
dang **wave** (song) -- tang dan len peak roi giam dan:

```text
startRate = 2/s    (binh thuong, it giao dich)
15s -> 8/s          (normal intake, giao dich bat dau nhieu)
20s -> 20/s         (webhook wave peak, provider day hang loat)
15s -> 4/s          (drain/recovery, wave giam)
5s  -> 0/s          (drain ve 0)
```

Wave nay co the la:

```text
- Dot khuyen mai giam gia -> nhieu nguoi thanh toan cung luc -> provider tra ve nhieu callback
- Gio cao diem (12h-13h, 18h-20h) -> luong giao dich tang dot bien
- Flash sale (vd 10h00 Black Friday) -> hang nghin thanh toan trong vai giay
- Provider bi tre (backlog) -> day bu callback tu 30 phut truoc
```

### Cau hoi kinh doanh

```text
Order service co nhan duoc payment webhook wave 2 -> 8 -> 20 -> 4/s
ma khong mat event nao khong?
```

Day khong phai la "uoc luong". Day la **cau hoi song con**:

```text
- Neu mat webhook payment da thanh toan -> order van o status 'pending'
  -> nguoi dung bi tru tien nhung don hang khong duoc xac nhan
  -> complaint, chargeback, mat uy tin voi payment provider

- Neu webhook trung lap khong duoc xu ly dung -> order bi cap nhat 2 lan
  -> inventory tru 2 lan -> lech ton kho
  -> accounting ghi nhan doanh thu 2 lan -> bao cao tai chinh sai
```

### Idempotency: phong thuy quan trong nhat

Payment provider **co the** gui cung mot webhook nhieu lan. Ly do:

```text
- Provider gui callback, nhung khong nhan duoc HTTP 200 trong 5 giay -> retry
- Network partition: HTTP 200 tu backend toi provider nhung goi response bi mat
- Provider restart: gui lai cac callback chua duoc xac nhan
- Provider co chinh sach "at-least-once delivery"
```

De xu ly dieu nay, **idempotency key** la bat buoc:

```text
Moi webhook event co mot idempotency key duy nhat (Idempotency-Key header).
Neu order service nhan cung key 2 lan:
  - Lan 1: xu ly webhook binh thuong -> tra 200
  - Lan 2: phat hien key da ton tai -> tra 200 nhung KHONG xu ly lai
```

Script rar-03 gui kem `Idempotency-Key: payment-webhook-<requestKey>` trong header.
Backend (load-target) duoc cau hinh `claim_ttl_ms=4000`, mo phong cua so idempotency
4 giay: trong 4s sau lan nhan dau tien, cac request trung key se duoc nhan ra va tu
choi xu ly lap.

### Tai sao day la case don gian nhat trong series?

Trong 7 case cua bo `ramping-arrival-rate`, rar-03 la case **don gian nhat ve mat
structural complexity**:

```text
rar-01 (campaign):   weightedPick 3 branch (landing 55%, detail 30%, cart_add 15%)
rar-02 (login):      weightedPick 3 branch (login 60%, me 25%, refresh 15%)
rar-03 (webhook):    1 operation duy nhat, 0 branch
rar-04 (checkout):   3-step flow (cart add + checkout create + confirm), 0 branch
rar-05 (report):     weightedPick 2 branch (dashboard 60%, async_job 40%)
rar-06 (cache-feed): weightedPick 2 branch (homefeed 70%, recommendations 30%)
rar-07 (spike mix):  weightedPick 6 branch
```

Rar-03 co **dung 1 POST request**, khong re nhanh, khong weightedPick, khong multi-step.
Day la case de nhat de verify rang **open model hoan toan giu duoc arrival curve**
ngay ca khi chi co 1 thao tac POST voi write DB.

Nhung su don gian nay chinh la suc manh cua no: no co lap **ingress behavior** khoi
branching complexity, giup ban tap trung vao viec doc hieu arrival curve, dropped
iterations, va VU utilization trong open model.

### Webhook retry semantics -- tai sao idempotency bat buoc

Payment provider thuong tuan theo mot retry policy nhat dinh. Hieu duoc policy
nay giup ban cau hinh `claim_ttl_ms` cho dung:

```text
Retry policy dien hinh cua payment provider:

Lan 1: gui webhook ngay sau thanh toan (t=0)
  - Neu nhan HTTP 200 trong 5s -> DONE
  - Neu khong nhan duoc 200 (timeout/5xx/network error) -> retry

Lan 2: retry sau 5s (t=5)
Lan 3: retry sau 10s (t=15)
Lan 4: retry sau 20s (t=35)
Lan 5: retry sau 40s (t=75)
Lan 6: danh dau webhook "failed", bao len dashboard provider
```

Dieu nay nghia la:

```text
- Cung mot webhook co the den 2-5 lan trong vong 75 giay
- Neu claim_ttl_ms = 4000 (4 giay): CHI bat duoc duplicate neu retry trong 4s
  -> Duplicate o lan 2 (t=5) se KHONG duoc nhan ra
  -> Can tang claim_ttl_ms len > 10s de bat 2 lan retry dau tien

- Trong thuc te, claim TTL nen > max retry interval cua provider
  -> Vi du claim_ttl_ms = 60000 (60 giay) de bat tat ca retry
  -> Nhung can can nhac: 60s TTL voi 20/s peak -> 1200 keys trong claim store
  -> Phai dam bao claim store du capacity (memory/Redis)
```

### Webhook signature verification (khong co trong script nay)

Trong production, webhook thuong co **signature** de xac thuc rang callback
that su den tu provider (khong phai attacker gia mao):

```text
Header: X-Payment-Signature: hmac-sha256=abcd1234...
Body: { "order_id": "...", "status": "paid", ... }

Backend:
  1. Tinh HMAC-SHA256(body, secret_key)
  2. So sanh voi X-Payment-Signature header
  3. Neu khop -> xu ly webhook
  4. Neu khong khop -> 401 Unauthorized (co the la tan cong)
```

Script rar-03 khong bao gom signature verification vi day la mock
load-target. Neu muon test signature verification:

```javascript
// Them vao requestJson headers:
headers: {
  'Idempotency-Key': `payment-webhook-${ctx.requestKey}`,
  'X-Payment-Signature': computeHmac(body, SECRET_KEY),
}
```

Nhung viec tinh HMAC trong k6 script ton CPU -> anh huong den event
duration -> co the lam tang VU requirement. Can tinh toan truoc.

### Hinh dung truc quan: wave shape so voi cac case khac

```text
arrivals/s
    |
 20 |                          ___
    |                         /   \
 16 |                        /     \
    |                       /       \
 12 |                      /         \
    |                     /           \
  8 |               _____/             \_____
    |              /                         \
  4 |             /                           \_____
    |         ___/                                   \___
  2 |     ___/                                             \___ 0
    +----+----+----+----+----+----+----+----+----+----+----+----+----+-->
    0    5   10   15   20   25   30   35   40   45   50   55         t(s)

Stage 1: normal (2->8)   Stage 2: wave peak (8->20)
Stage 3: drain (20->4)   Stage 4: final drain (4->0)
```

Day la hinh dang "con song don" (single wave): tang tu tu, dat dinh, roi
rut dan. No khac voi cac case khac:

```text
rar-01 (campaign):  2->8->28->6->0  (peak 28/s, bien do cao hon)
rar-02 (login):     1->6->24->5->0  (burst 24/s, it giai doan tang)
rar-03 (webhook):   2->8->20->4->0  (wave 20/s, dang song can doi)
rar-04 (checkout):  1->4->12->3->0  (flash sale, peak thap nhung multi-step)
rar-06 (cache-feed):4->12->36->8->0 (peak 36/s, cao nhat series)
rar-07 (spike-mix): 3->12->32->10->0 (peak 32/s, mixed)
```

Rar-03 co peak 20/s -- khong phai cao nhat, khong phai thap nhat. La mot
case "trung binh" ve arrival rate nhung "don gian nhat" ve structure.

---

## 2. 2 yeu cau cot loi

Case nay co **2 yeu cau cot loi** ma chi `ramping-arrival-rate` moi thoa man duoc:

### Yeu cau (a): MO PHONG ARRIVAL WAVE DUNG PROVIDER CURVE

**Y nghia**: K6 phai bat dau iteration moi theo **dung arrival curve** ma provider
tao ra, tu 2/s tang len 8/s, dat peak 20/s, roi giam xuong 4/s ve 0. Khong duoc
phu thuoc vao toc do xu ly cua backend.

```text
Timeline 55 giay:
  t=0s - t=15s:   arrival rate tang tuyen tinh 2 -> 8/s    (normal intake)
  t=15s - t=35s:  arrival rate tang tuyen tinh 8 -> 20/s   (webhook wave peak)
  t=35s - t=50s:  arrival rate giam tuyen tinh 20 -> 4/s   (drain/recovery)
  t=50s - t=55s:  arrival rate giam tuyen tinh 4 -> 0/s    (final drain)

Tong scheduled slots = 545 arrivals
```

**Kiem chung voi so lieu that tu validation run**:

```text
startRate=2, stages: 15s->8, 20s->20, 15s->4, 5s->0
scheduled_slots = 545
iterations thuc te = 545
dropped_iterations = 0
ramping_arrival_events_failed = 0

=> Toan bo 545 slot duoc start thanh cong, 0 drop, 0 fail
=> Arrival curve duoc giu nguyen toan bo 55 giay
```

### Yeu cau (b): PHAT HIEN MAT EVENT QUA dropped_iterations

**Y nghia**: Neu backend khong du capacity de xu ly webhook wave (qua cham, qua tai),
test phai **bao loi ro rang** qua `dropped_iterations`. Mot webhook payment bi mat
la mot don hang khong duoc cap nhat -- khong the im lang pass.

**Dieu gi xay ra neu dung closed model cho case nay?**

```text
Tinh huong: Backend order service bi cham (DB lock 200ms)
Phai xu ly webhook peak 20/s trong 20 giay (stage 2)

Voi constant-vus (closed model):
  - VU loop cham -> throughput tu giam
  - 12 VUs / 0.2s = 60 req/s -> nhung thuc te chi ~40 req/s vi DB lock
  - Test bao "pass" (checks van OK, HTTP van 200)
  - KHONG phat hien duoc mat event

Voi ramping-arrival-rate (open model):
  - Slot den dung lich 20/s o stage peak
  - Backend cham -> moi event ton nhieu thoi gian
  - Can nhieu VU de giu nhịp 20/s
  - VU pool can (pre=16, max=50) -> slot khong co worker -> dropped_iterations++
  - Test FAIL -> phat hien duoc capacity gap
```

### Tai sao ca 2 yeu cau phai thoa man DONG THOI?

```text
Neu CHI co (a) ma khong co (b):
  - Arrival wave mo phong dung nhu provider
  - Nhung backend yeu -> mat event -> khong ai biet
  - Giong nhu camera ghi lai vu chay nhung khong bao cho ai

Neu CHI co (b) ma khong co (a):
  - Co phat hien drop nhung arrival rate khong dung curve
  - Khong test duoc dieu kien thuc te cua provider
  - Giong nhu bao chay reo nhung khong co lua that

Ca 2 cung co -> ramping-arrival-rate la executor DUY NHAT thoa man.

### So sanh voi constant-arrival-rate: tai sao khong dung CAR?

Co nguoi co the hoi: "Tai sao khong dung `constant-arrival-rate` voi
rate=20/s cho 55 giay? Don gian hon ma van la open model?"

Cau tra loi nam o **hinh dang cua traffic**:

```text
constant-arrival-rate (rate=20/s, 55s):
  rate
    |
 20 +-------------------------------------------------
    |
    +----+----+----+----+----+----+----+----+----+--> t
    0   10   20   30   40   50   55

  Scheduled: 20 x 55 = 1100 arrivals
  -> DEPT DANG: 1100 arrivals, nhung thuc te chi ~545
  -> Test khong mo phong dung wave shape cua provider
  -> 1100 arrivals co the gay drop vo nghia (VU pool khong can thiet)

ramping-arrival-rate (start=2, 15s->8, 20s->20, 15s->4, 5s->0):
  Scheduled: 545 arrivals theo wave shape
  -> DEPT DANG: 545 arrivals, dung nhu provider that
  -> Moi stage co arrival rate rieng
```

Dung `constant-arrival-rate` cho case nay giong nhu dung mot toc do co
dinh de mo ta mot chuyen xe co luc nhanh luc cham -- sai ban chat.

### So sanh voi cac case CAR trong bo constant-arrival-rate

```text
CAR-01 (storefront): arrival rate CO DINH 20/s trong 45s
  -> Phu hop constant-arrival-rate vi: browse/list la traffic deu dan
  -> Khong co wave, khong co peak/burst

RAR-03 (webhook): arrival rate THAY DOI 2->8->20->4->0/s
  -> Phu hop ramping-arrival-rate vi: webhook provider push theo wave
  -> Co wave shape ro rang, co peak o giua

Day la su khac biet CO BAN giua 2 executor trong cung open model:
  - CAR: "Toi can 20 arrivals/s, khong doi"
  - RAR: "Toi can arrival rate tang tu 2 len 20 roi giam ve 0"
```

### Bai hoc ve "shape-aware" testing

```text
Khong phai open-model test nao cung la "fixed rate".
Mot so traffic co hinh dang (shape) -- wave, burst, spike, ramp.

Shape-aware testing tra loi cau hoi:
  "He thong co chiu duoc traffic SHAPE nay khong?"
  Khong chi la:
  "He thong co chiu duoc traffic RATE nay khong?"

Vi du:
  - 20/s deu trong 55s -> co the pass
  - 2->8->20->4->0/s trong 55s -> cung co the pass
  - Nhung 0->50->0/s dot ngot trong 10s -> co the FAIL
    mac du average rate van ~20/s

Ramping-arrival-rate la cong cu de test shape-aware.
```

---

## 3. Vi sao dung `ramping-arrival-rate`?

### Provider la external producer

Diem mau chot cua case nay: **provider quyet dinh arrival rate, khong phai ban**.

```text
Closed model (constant-vus, ramping-vus):
  Throughput = so luong VU / thoi gian moi VU hoan thanh loop
  -> Throughput PHU THUOC vao toc do backend
  -> Khong mo phong duoc external producer

Open model (constant-arrival-rate, ramping-arrival-rate):
  Arrival rate duoc len lich doc lap voi backend
  -> Arrival rate CO DINH theo config
  -> Mo phong dung external producer push events
```

Dung closed model de test webhook wave giong nhu co gang mo phong song bien bang
cach tha thuyen xuong ho boi -- no khong bao gio co hinh dung cua mot con song that.

### So sanh 5 executor

Bang duoi day so sanh tat ca executor ma k6 cung cap, phan tich vi sao moi cai
**khong phu hop** cho case webhook wave:

| Executor | Model | Cach hoat dong | Vi sao KHONG phu hop cho webhook wave? |
| --- | --- | --- | --- |
| `constant-vus` | Closed | Co dinh N VU, moi VU tu loop | Throughput phu thuoc loop duration. Khong mo phong duoc wave. Backend cham -> throughput giam -> test van pass. |
| `ramping-vus` | Closed | VU tang/giam theo stage | VU thay doi nhung throughput van phu thuoc loop duration. Khong dam bao arrival rate doc lap. |
| `shared-iterations` | Closed | Chia N iteration cho VU pool | Iteration co dinh, khong co khai niem arrival rate. Khong mo phong duoc wave shape. |
| `per-vu-iterations` | Closed | Moi VU chay N iteration | Khong kiem soat duoc arrival rate hay arrival shape. |
| `constant-arrival-rate` | Open | Co dinh arrival rate | Arrival rate CO DINH -- khong mo phong duoc wave (rate thay doi theo thoi gian). |
| `ramping-arrival-rate` | **Open** | **Arrival rate thay doi theo stage** | **Phu hop: mo phong chinh xac wave shape cua provider.** |

### Tai sao khong dung constant-arrival-rate?

```text
constant-arrival-rate:
  rate = 20/s, duration = 55s
  -> 20 x 55 = 1100 arrivals
  -> KHONG mo phong duoc hinh dang wave (2->8->20->4->0)
  -> Provider khong bao gio gui deu 20/s trong 55s
  -> Test khong phan anh thuc te

ramping-arrival-rate:
  startRate = 2/s + stages: 15s->8, 20s->20, 15s->4, 5s->0
  -> 545 arrivals theo wave shape
  -> Mo phong dung provider pattern
  -> Dung thuc te
```

### Ramping-arrival-rate nam giua constant-arrival-rate va ramping-vus

```text
                    Closed model                  Open model
               (throughput tuy thuoc)      (arrival rate doc lap)
                         |                           |
              ramping-vus                        ramping-arrival-rate
              constant-vus                       constant-arrival-rate
                         |                           |
                    "Bao nhieu VU?"             "Bao nhieu arrivals/s?"
```

Ramping-arrival-rate la **open-model twin** cua ramping-vus:
- ramping-vus: thay doi so luong VU, throughput la he qua
- ramping-arrival-rate: thay doi arrival rate, VU la resource de dap ung

---

## 4. Config mapping

### Bang tham so day du

| Tham so | Default | Y nghia |
| --- | ---: | --- |
| `RAR_03_START_RATE` | 2 | Arrival rate tai t=0 (events/s) |
| `RAR_03_NORMAL_RATE` | 8 | Arrival rate sau stage 1 -- normal intake |
| `RAR_03_WAVE_RATE` | 20 | Arrival rate o stage 2 -- provider peak |
| `RAR_03_DRAIN_RATE` | 4 | Arrival rate sau stage 3 -- recovery |
| `RAR_03_DURATION_SCALE` | 1 | He so nhan duration cua tat ca stage |
| `RAR_03_PREALLOCATED_VUS` | 16 | VU duoc khoi tao san, san sang nhan viec |
| `RAR_03_MAX_VUS` | 50 | Tran VU -- pool khong vuot qua con so nay |
| `RAR_03_MAX_DROPPED` | 3 | Ngan sach drop -- so slot toi da duoc phep mat |
| `RAR_03_USER_POOL` | 500 | Kich thuoc pool identity (user/order) |

### Config trong script

```javascript
const CASE_ID = 'rar-03-payment-webhook-wave';
const SCALE = envInt('RAR_03_DURATION_SCALE', 1);
const START_RATE = envInt('RAR_03_START_RATE', 2);
const NORMAL_RATE = envInt('RAR_03_NORMAL_RATE', 8);
const WAVE_RATE = envInt('RAR_03_WAVE_RATE', 20);
const DRAIN_RATE = envInt('RAR_03_DRAIN_RATE', 4);
const PREALLOCATED_VUS = envInt('RAR_03_PREALLOCATED_VUS', 16);
const MAX_VUS = envInt('RAR_03_MAX_VUS', 50);
const MAX_DROPPED = envInt('RAR_03_MAX_DROPPED', 3);
const USER_POOL = envInt('RAR_03_USER_POOL', 500);
```

### Scenario build

```javascript
export const options = {
  scenarios: {
    payment_webhook_wave: buildRampingArrivalScenario(
      'paymentWebhookWave', START_RATE, [
        { target: NORMAL_RATE, duration: scaleSeconds(15, SCALE) },
        { target: WAVE_RATE,   duration: scaleSeconds(20, SCALE) },
        { target: DRAIN_RATE,  duration: scaleSeconds(15, SCALE) },
        { target: 0,           duration: scaleSeconds(5, SCALE)  },
      ], '1s', PREALLOCATED_VUS, MAX_VUS, {
        case_id: CASE_ID,
        business_case: 'payment_provider_webhook_wave',
      }
    ),
  },
  thresholds: {
    checks:                        ['rate>0.99'],
    http_req_failed:               ['rate<0.01'],
    dropped_iterations:            [`count<=${MAX_DROPPED}`],
    ramping_arrival_events_failed: ['count<10'],
  },
};
```

### Stage math: Scheduled slots

Cong thuc tinh scheduled slots cho ramping-arrival-rate:

```text
slots(stage) = duration * (rate_start + rate_end) / 2
```

Day la cong thuc dien tich hinh thang (trapezoid area). K6 dung linear interpolation
giua cac stage target.

Tinh toan cu the cho case nay:

| Stage | Duration | Rate start -> end | Area (slots) | Giai thich |
| --- | ---: | ---: | ---: | --- |
| 1 normal intake | 15s | 2 -> 8/s | (2+8)/2 x 15 = **75** | Bat dau tu 2/s, tang dan len 8/s |
| 2 webhook wave peak | 20s | 8 -> 20/s | (8+20)/2 x 20 = **280** | Provider day manh nhat |
| 3 drain/recovery | 15s | 20 -> 4/s | (20+4)/2 x 15 = **180** | Wave giam dan |
| 4 final drain | 5s | 4 -> 0/s | (4+0)/2 x 5 = **10** | Ve 0 |
| **Total** | **55s** | | **545** | |

```text
75 + 280 + 180 + 10 = 545 slots ✅
```

**Kiem chung that te**: 545 iterations observed, exact match.

### PreAllocatedVUs = 16 va MaxVUs = 50

```text
Tinh toan VU can thiet theo Little's Law:

Tai peak 20/s, event p95 ~6ms = 0.006s:
  required_VUs = arrival_rate * avg_event_duration
               = 20/s * 0.006s
               = 0.12 VU
  -> Ly thuyet: < 1 VU la du!

Nhung Little's Law la lower bound. Trong thuc te:
  - VU khoi tao + giai phong co overhead
  - GC pause, network jitter tao ra tail latency
  - preAllocatedVUs=16: dam bao pool san sang gap 100x nhu cau ly thuyet
  - maxVUs=50: tran an toan, khong bao gio cham toi trong case nay
```

### Vi sao stage 4 target=0 thay vi target>0?

```text
target=0 o stage cuoi cung la intentional:
  - Day la "drain" stage -- giam dan ve 0
  - Moi stage la linear ramp tu rate truoc den target
  - target=0 nghia la: trong 5 giay, rate giam tu 4/s xuong 0/s
  - Ket thuc test sach se, khong co arrival dot ngot

Neu target > 0 (vi du target=2):
  - Rate giam tu 4/s xuong 2/s trong 5s
  - Sau 5s, test ket thuc dot ngot khi van con 2/s
  - Cac slot con dang chay se bi interrupted
  -> `interrupted_iterations > 0` -> lam "nhiem" pass/fail signal
```

### Vi sao preAllocatedVUs = 16? Tai sao khong phai 5 hoac 50?

```text
Con so 16 khong phai ngau nhien. Day la ket qua cua viec can nhac:

1. Little's Law lower bound:
   peak_rate = 20/s, avg_duration = 0.005s
   required = 20 * 0.005 = 0.1 VU
   -> Ly thuyet: 1 VU la du

2. Safety margin cho tail latency:
   p99 = 21ms = 0.021s
   required_p99 = 20 * 0.021 = 0.42 VU
   -> Van < 1 VU

3. Safety margin cho cold start + GC:
   - VU pool khoi tao mat thoi gian
   - GC pause co the lam VU khong phan hoi trong 10-50ms
   - Network jitter co the tang duration

4. Safety margin cho "what if" scenarios:
   - Neu claim_ttl_ms tang -> backend kiem tra nhieu keys -> cham hon
   - Neu provider retry nhieu -> backend load cao hon
   - Neu DB write that cham hon (external_ms > 0)

5. Cost cua preAllocatedVUs:
   - 16 VU chiem rat it memory (~2MB/VU -> 32MB)
   - 50 VU (max): van nho, tran an toan
   - Khong co ly do de tiet kiem VU trong gioi han nay

=> 16 la con so "du thua mot cach hop ly" (generously over-provisioned).
   Day la best practice: preAllocatedVUs nen > Little's Law estimate
   mot he so 2-10x de dap ung tail latency va cold start.
```

### VU count impact chart

```text
Tac dong cua cac muc preAllocatedVUs khac nhau cho case nay (peak 20/s):

pre=2, max=10:
  - Du cho avg duration (0.1 VU), nhung....
  - Neu p99 = 200ms -> 4 VUs can -> 2 khong du -> pool expand -> drop
  - Neu cold start 100ms -> mat vai slot trong giay dau tien

pre=8, max=30:
  - An toan hon, du cho p99 = 400ms
  - Pool co the expand toi 30 neu can
  - Phu hop cho production-like staging

pre=16, max=50:        <-- DEFAULT, duoc chon cho case nay
  - Rat an toan, du cho p99 = 800ms
  - Pool co du headroom
  - Phu hop cho "what if" testing

pre=32, max=80:
  - Bao thu, du cho p99 = 1.6s
  - Ton nhung khong gay hai
  - Co the dung neu backend that cham
```

---

## 5. Identity model deep-dive

### VU la vo danh, userId la dinh danh

Trong open model, VU **khong gan voi identity co dinh**. Moi iteration, VU nhan mot
userId moi tu pool:

```javascript
export function userContext(seed = 'ramping-arrival', userPool = 1000) {
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

### Bang identity mapping

| Thanh phan | Gia tri vi du | Giai thich |
| --- | --- | --- |
| `vuId` | 1, 2, ..., 16 | ID cua VU trong test -- vo danh, thay doi theo iteration |
| `userId` | `rar-user-1`, ..., `rar-user-500` | Identity nghiep vu -- xoay vong qua user pool 500 |
| `requestKey` | `seed-42-3` | Unique key cho moi request -- ket hop seed + iteration + vuId |
| `iter` | 0, 1, ..., 544 | Chi so iteration toan test |
| `scenarioIter` | 0, 1, ... | Chi so iteration trong scenario nay |

### Luu y quan trong ve identity model

**VU khong so huu order**:

```text
Trong closed model (constant-vus):
  - VU #1 login, browse, add to cart, checkout -> cung mot user xuyen suot
  - Identity gan voi VU -> VU la "nguoi dung ao"

Trong open model (ramping-arrival-rate):
  - VU #1 xu ly webhook cho order #42 (iter 42%500)
  - VU #1 xu ly webhook cho order #143 (iter 143%500)
  - VU #1 xu ly webhook cho order #251 (iter 251%500)
  - VU KHONG so huu identity -> VU la "worker", khong phai "user"
```

**Dieu nay phu hop voi thuc te webhook**:

```text
Payment provider gui:
  - Webhook cho order cua user A
  - Webhook cho order cua user B
  - Webhook cho order cua user C

Provider khong quan tam backend dang dung "VU nao" de xu ly.
Identity nam o noi dung webhook (order_id, provider_event_id),
khong nam o VU.
```

### Idempotency-Key: moi request co key rieng

```javascript
// Trong script:
const result = requestJson('POST',
  `${BASE_URL}/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000`,
  { /* body */ },
  {
    // ...
    headers: { 'Idempotency-Key': `payment-webhook-${ctx.requestKey}` },
  }
);
```

Moi request co mot `Idempotency-Key` duy nhat duoc tao tu `requestKey`:

```text
requestKey = "${seed}-${iteration}-${vuId}"
           = "1719000000000-42-3"
           -> Idempotency-Key = "payment-webhook-1719000000000-42-3"
```

**Tai sao dung requestKey thay vi order_id hoac provider_event_id?**

```text
- order_id: co the bi lap vi pool 500 -> order_id xoay vong sau 500 iteration
- provider_event_id: gan voi requestKey, dam bao unique toan test
- Neu dung order_id lam Idempotency-Key -> order #42 co the bi coi la
  "da xu ly" khi gap lan 2 -> webhook that cho order #42 o iteration 542 bi bo qua
- Dung requestKey dam bao: moi LAN GOI la mot key moi
  -> provider_event_id trong body la dinh danh event that
  -> Idempotency-Key o header la dinh danh lan goi
```

### order_id tu iter%USER_POOL

```javascript
const orderId = `rar03-${ctx.iter % USER_POOL}`;
```

Voi `USER_POOL=500`, `iter` chay tu 0 den 544:

```text
iter=0   -> orderId = rar03-0
iter=1   -> orderId = rar03-1
...
iter=499 -> orderId = rar03-499
iter=500 -> orderId = rar03-0    (xoay vong)
iter=501 -> orderId = rar03-1
...
iter=544 -> orderId = rar03-44
```

545 iteration, pool 500 -> 45 order xuat hien 2 lan, 455 order xuat hien 1 lan.
Dieu nay mo phong mot tap don hang co kich thuoc gioi han -- khong phai moi
webhook la mot order moi.

### provider_event_id va amount

```javascript
provider_event_id: `evt-${ctx.requestKey}`,
status: 'paid',
amount: 120000 + (ctx.iter % 5000),
```

- `provider_event_id`: unique tren toan bo test vi gan voi `requestKey`
- `status`: luon la `'paid'` -- tat ca webhook deu la xac nhan thanh toan thanh cong
- `amount`: dao dong tu 120,000 den 124,999 -- mo phong cac don hang co gia tri khac nhau

---

## 6. Open model deep-dive

### Single POST operation: truong hop don gian nhat

Rar-03 la case **duy nhat** trong toan bo 7-case series chi co 1 operation, khong
re nhanh, khong multi-step:

```javascript
export function paymentWebhookWave(data) {
  const started = Date.now();
  const ctx = userContext(data.seed, USER_POOL);
  const orderId = `rar03-${ctx.iter % USER_POOL}`;
  const result = requestJson('POST',
    `${BASE_URL}/api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=4000`,
    {
      order_id: orderId,
      provider_event_id: `evt-${ctx.requestKey}`,
      status: 'paid',
      amount: 120000 + (ctx.iter % 5000),
    },
    {
      caseId: CASE_ID,
      service: 'order-service',
      operation: 'payment_webhook_wave_receive',
      endpoint: 'POST /api/sim/orders/webhooks/payment',
      userId: ctx.userId,
      headers: { 'Idempotency-Key': `payment-webhook-${ctx.requestKey}` },
    }
  );

  finishEvent(started, result.ok, {
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'payment_webhook_wave',
    userId: ctx.userId,
  });
}
```

### Flow cua mot iteration

```text
1. start timer (Date.now())
2. userContext() -> userId, orderId, requestKey
3. POST /api/sim/orders/webhooks/payment
   - body: { order_id, provider_event_id, status, amount }
   - params: cpu_ms=1, db_writes=2, claim_ttl_ms=4000
   - header: Idempotency-Key, X-User-ID, X-Test-Suite
4. check status 200
5. finishEvent() -> record metrics
6. done
```

Toan bo event hoan thanh trong khoang 5-6ms (p95).

### Tai sao can it VU du co db_writes=2?

```text
db_writes=2 nghia la backend ghi 2 dong vao DB (gia lap bang webhook_logs).
Nhung backend load-target xu ly rat nhanh (~5ms) vi DB la in-memory hoac
SQLite local.

Little's Law:
  peak_rate = 20/s
  avg_event_duration = 0.005s
  required_VUs = 20 * 0.005 = 0.1 VU

Thuc te: preAllocatedVUs=16 la du thua rat nhieu.
Active VU max observed = 0 (sampling granularity 1s, event < 1ms sample interval).
vus_max = 16 = preAllocatedVUs (pool khong can expand).

Dieu nay khong phai la "VU khong can thiet" -- day la:
  - pre=16 la buffer an toan
  - max=50 la tran de phong backend slow
  - Trong validation nay, backend nhanh nen VU pool gan nhu idle
```

### Khong co sleep(), khong co async branch, khong co wait

Rar-03 la case thuan khiet nhat: khong `sleep()`, khong `wait()`, khong re nhanh
async. Moi event la mot POST don thuan, tra ve ngay lap tuc.

```text
So sanh voi cac case khac:
  rar-01: weightedPick 3 branch, nhung tat ca deu la GET/POST don
  rar-02: weightedPick 3 branch, co POST auth (db_rows=1), GET me (memory_kb=4)
  rar-03: **1 operation, khong branch** -> don gian nhat
  rar-04: 3-step flow (3 HTTP calls trong 1 event)
  rar-05: weightedPick voi async_job branch co sleep(0.14s) -> VU bi hold
  rar-06: weightedPick 2 branch GET
  rar-07: weightedPick 6 branch
```

Chinh vi khong co sleep/wait, moi event hoan thanh rat nhanh (~5ms) va VU duoc
giai phong ngay lap tuc. Day la ly do tai sao preAllocatedVUs=16 la qua du cho
peak 20/s -- moi VU chi "ban" trong 5ms, sau do san sang cho slot tiep theo.

### Open model schedule: cai gi xay ra moi giay

```text
Tai t=17.5s (dang o stage 2, rate dang o khoang 9/s):

1. K6 scheduler tinh toan: rate hien tai = 8 + (17.5-15)/(20)*(20-8) = 8 + 2.5/20*12
   = 8 + 1.5 = 9.5 arrivals trong giay nay
2. Scheduler tao 9-10 slot, cach deu nhau ~100-111ms
3. Moi slot duoc assign 1 VU tu pool (pre=16)
4. VU thuc thi POST, hoan thanh trong ~5ms
5. VU quay lai pool, san sang cho slot tiep theo

Tai t=25s (dang o stage 2 peak, rate = 20/s):

1. Rate hien tai = 20/s
2. Scheduler tao 20 slot, cach deu 50ms
3. 20 slot can 20 VU... nhung chi can 20 * 0.005 = 0.1 VU dong thoi
4. Thuc te: 1-2 VU la du, 16 VU preallocated la qua du

Tai t=45s (dang o stage 3, rate dang o khoang 8/s):

1. Rate hien tai = 8/s
2. Scheduler tao 8 slot, cach deu 125ms
3. Van chi can < 1 VU dong thoi
```

### K6 scheduler internals cho ramping-arrival-rate

De hieu sau hon ve cach k6 schedule slot, day la mo ta logic ben trong:

```text
1. Scenario bat dau tai t=0:
   startRate = 2/s -> scheduler tao slot moi 500ms (1/2 s)

2. Trong moi stage, rate thay doi tuyen tinh:
   rate(t) = rate_start + (t - t_stage_start) / duration * (target - rate_start)

   Vi du o stage 2 (15s -> 35s):
   rate(t) = 8 + (t-15)/20 * (20-8) = 8 + (t-15) * 0.6

   t=15s: rate = 8/s    -> slot moi 125ms
   t=20s: rate = 11/s   -> slot moi ~91ms
   t=25s: rate = 14/s   -> slot moi ~71ms
   t=30s: rate = 17/s   -> slot moi ~59ms
   t=35s: rate = 20/s   -> slot moi 50ms

3. Interval giua cac slot = 1 / rate(t)
   Khi rate tang -> interval giam -> slot den nhanh hon

4. Moi slot:
   a. Kiem tra VU pool con VU khong
   b. Neu co: lay 1 VU, thuc thi iteration
   c. Neu khong: dropped_iterations++
   d. Slot duoc schedule doc lap, khong cho slot truoc hoan thanh

5. Khi test ket thuc (t=55s):
   Cac slot dang chay duoc phep hoan thanh (gracefulStop)
   Cac slot chua start -> interrupted_iterations
```

### Tai sao scheduler dung linear interpolation?

```text
Linear interpolation giua cac stage target la cach don gian va hieu qua
nhat de mo phong mot wave:

- De hinh dung: rate tang deu, khong dot ngot
- De tinh toan: area = trapezoid -> du doan duoc scheduled slots
- Phu hop thuc te: provider wave thuong tang/giam dan, khong nhay cap

Neu muon mo phong stage transition dot ngot (step function):
-> Dung nhieu scenario rieng biet voi constant-arrival-rate
-> Hoac dung custom executor (khong co san trong k6)
```

### Moi quan he giua VU_idle_time va arrival_rate

```text
Trong open model, VU danh phan lon thoi gian o trang thai "idle"
(cho slot moi). Viec nay hoan toan binh thuong:

Tai peak 20/s:
  - arrival interval = 50ms
  - event duration = 5ms
  - VU "ban" 5ms, "ranh" 45ms (90% idle)
  - Vay 1 VU co the xu ly 20 slot/s
  - Nhung neu co 16 VU preallocated -> moi VU chi xu ly 20/16 = 1.25 slot/s
  - VU idle time > 99%!

Dieu nay la BY DESIGN, khong phai lang phi:
  - VU la "workers" san sang nhan viec bat ky luc nao
  - Neu event duration tang dot ngot (backend cham) -> VU san sang
  - preAllocatedVUs la buffer, khong phai target utilization
```

### Bai hoc tu preAllocatedVUs

```text
preAllocatedVUs=16 la "qua du" cho case nay. Nhung:
  - preAllocatedVUs la INITIAL pool size, khong phai max usage
  - Pool duoc khoi tao truoc (pre-allocate) de giam cold-start latency
  - Neu backend co p99 = 100ms thay vi 5ms:
    Little's Law: 20 * 0.1 = 2 VUs -> 16 van du
  - Neu backend co p99 = 1s:
    Little's Law: 20 * 1 = 20 VUs -> 16 khong du -> pool expand toi max=50
  - maxVUs=50 cho phep pool expand gap 3x preAllocated trong tinh huong xuau
```

---

## 7. Service/API flow

### Single endpoint -- single operation

Moi webhook event la mot HTTP POST den **dung mot endpoint**:

| Operation | Method | Endpoint | Expected |
| --- | --- | --- | ---: |
| `payment_webhook_wave_receive` | POST | `/api/sim/orders/webhooks/payment` | 200 |

### Request breakdown

#### URL query params

| Param | Gia tri | Y nghia |
| --- | ---: | --- |
| `cpu_ms` | 1 | Gia lap 1ms CPU processing tren backend |
| `db_writes` | 2 | Gia lap 2 DB write operations (webhook_log + order update) |
| `claim_ttl_ms` | 4000 | Idempotency claim TTL: 4 giay |

#### Request body

```json
{
  "order_id": "rar03-42",
  "provider_event_id": "evt-1719000000000-42-3",
  "status": "paid",
  "amount": 122542
}
```

| Field | Kieu | Giai thich |
| --- | --- | --- |
| `order_id` | string | ID don hang trong he thong cua ban (`rar03-{iter%500}`) |
| `provider_event_id` | string | ID event cua payment provider (`evt-{requestKey}`) |
| `status` | string | Trang thai thanh toan (luon `"paid"`) |
| `amount` | number | So tien thanh toan (120000-124999 VND) |

#### Request headers

| Header | Gia tri vi du | Y nghia |
| --- | --- | --- |
| `Content-Type` | `application/json` | Dinh dang body |
| `Idempotency-Key` | `payment-webhook-1719000000000-42-3` | Key chong trung lap |
| `X-Test-Suite` | `ramping-arrival-rate` | Danh dau test suite |
| `X-Load-Profile` | `ramping-arrival-rate-practice` | Danh dau load profile |
| `X-User-ID` | `rar-user-42` | ID nguoi dung (xoay vong qua pool 500) |

#### Response expected

```text
HTTP 200 OK
Body: JSON xac nhan da xu ly webhook
```

Neu idempotency key trung lap (request goi lai trong vong 4 giay):
```text
HTTP 200 OK
Body: JSON xac nhan da xu ly (idempotent - khong xu ly lai)
Backend van tra 200 nhung khong thuc hien DB writes lan 2
```

### Flow tong quan

```text
                    K6 Ramping Arrival Rate Scheduler
                              |
                   schedule slot moi 50ms (tai peak 20/s)
                              |
                              v
                    +---- VU Pool (pre=16, max=50) ----+
                    |                                  |
                    v                                  v
               VU #3                              VU #7
                    |                                  |
        POST /api/sim/orders/       POST /api/sim/orders/
         webhooks/payment            webhooks/payment
                    |                                  |
                    v                                  v
              [Order Service]                   [Order Service]
               - Validate Idempotency-Key       - Validate Idempotency-Key
               - Check claim_ttl_ms=4000        - Check claim_ttl_ms=4000
               - DB write x2 (cpu_ms=1)         - DB write x2 (cpu_ms=1)
               - Return 200                     - Return 200
```

### common.js helpers duoc su dung

Script import 5 helper functions tu `common.js`:

| Helper | Vai tro |
| --- | --- |
| `buildRampingArrivalScenario()` | Build scenario config voi executor, stages, VU bounds, tags |
| `envInt()` | Doc env var, fallback ve default |
| `scaleSeconds()` | Scale duration theo SCALE factor |
| `userContext()` | Tao identity context cho moi iteration |
| `requestJson()` | Goi HTTP POST/GET/PATCH/DELETE, kem headers, tags, check status |
| `finishEvent()` | Ghi nhan event-level metrics (duration, total, failed) |

### finishEvent pattern

Moi case deu theo pattern giong nhau:

```javascript
export function paymentWebhookWave(data) {
  const started = Date.now();                    // 1. start timer

  const ctx = userContext(data.seed, USER_POOL); // 2. build identity
  const result = requestJson('POST', url, body, tags); // 3. call API

  finishEvent(started, result.ok, {              // 4. record event metrics
    caseId: CASE_ID,
    service: 'order-service',
    operation: 'payment_webhook_wave',
    userId: ctx.userId,
  });
}
```

Pattern nay dam bao:
- Moi event co `ramping_arrival_events_total` count increment
- Moi event co `ramping_arrival_event_duration_ms` trend record
- Neu event fail, `ramping_arrival_events_failed` counter increment
- Tag `service` va `operation` cho phep drill-down trong dashboard

---

## 8. Metrics & tags

### Metrics k6 custom

Script khai bao 4 custom metrics trong `common.js`:

| Metric | Type | Mo ta |
| --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Tong so event da bat dau (1 event = 1 iteration) |
| `ramping_arrival_events_failed` | Counter | So event that bai (check fail hoac exception) |
| `ramping_arrival_api_calls_total` | Counter | Tong so HTTP call (1 call/event o case nay) |
| `ramping_arrival_event_duration_ms` | Trend | Thoi gian hoan thanh event (tu start den finishEvent) |

### Tags tren moi HTTP request

Moi `requestJson()` call gan cac tags sau:

| Tag | Gia tri vi du | Y nghia |
| --- | --- | --- |
| `case_id` | `rar-03-payment-webhook-wave` | Dinh danh case |
| `service` | `order-service` | Service duoc goi |
| `operation` | `payment_webhook_wave_receive` | Ten operation o request level |
| `endpoint` | `POST /api/sim/orders/webhooks/payment` | Full method + path |
| `user_id` | `rar-user-42` | Identity nguoi dung |
| `name` | `payment_webhook_wave_receive` | URL name trong k6 dashboard |

### Scenario-level tags

| Tag | Gia tri | Y nghia |
| --- | --- | --- |
| `executor_family` | `ramping_arrival_rate` | Ho executor |
| `workload_shape` | `ramping_ingress_rate` | Hinh dang workload |
| `case_id` | `rar-03-payment-webhook-wave` | Case ID |
| `business_case` | `payment_provider_webhook_wave` | Business scenario |

### Bang mapping metrics -> nguon du lieu

| Ban muon biet... | Doc metric... | Tag filter |
| --- | --- | --- |
| Tong so webhook event | `ramping_arrival_events_total` | `case_id=rar-03-...` |
| So event that bai | `ramping_arrival_events_failed` | `case_id=rar-03-...` |
| Thoi gian xu ly webhook (p95) | `ramping_arrival_event_duration_ms` | `case_id=rar-03-...` |
| HTTP request duration (p95) | `http_req_duration` | `operation=payment_webhook_wave_receive` |
| So request POST 200 | `http_reqs` | `method=POST, status=200` |
| So slot bi drop | `dropped_iterations` | (built-in, khong can tag) |
| Active VU count | `vus` | (built-in, khong can tag) |

### Quan he giua cac con so

```text
ramping_arrival_api_calls_total = http_reqs  (1 call/event)
ramping_arrival_events_total     = iterations  (1 event/iteration)

http_reqs = iterations  (vi moi iteration chi co 1 HTTP call)

dropped_iterations = scheduled_slots - iterations - interrupted_iterations
                   = 545 - 545 - 0 = 0  ✅

ramping_arrival_events_failed = so event co check fail
                               = 0  (tat ca check deu pass)
```

---

## 9. Pass criteria

### Thresholds trong script

```javascript
thresholds: {
  checks:                        ['rate>0.99'],
  http_req_failed:               ['rate<0.01'],
  dropped_iterations:            [`count<=${MAX_DROPPED}`],
  ramping_arrival_events_failed: ['count<10'],
},
```

### Bang pass criteria chi tiet

| Criteria | Threshold | Y nghia | Validated |
| --- | --- | --- | ---: |
| `checks` | `rate > 0.99` | Hon 99% check pass | 100% (545/545) |
| `http_req_failed` | `rate < 0.01` | Duoi 1% HTTP fail | 0% (0/545) |
| `dropped_iterations` | `count <= 3` | Toi da 3 slot bi drop | 0 |
| `ramping_arrival_events_failed` | `count < 10` | It hon 10 event bi fail | 0 |

### Tai sao dropped_iterations <= 3 ma khong phai 0?

```text
MAX_DROPPED = 3 la mot "ngan sach drop" nho:
  - Trong thuc te, mot vai slot co the bi drop do GC pause hoac OS scheduling
  - 3/545 = 0.55% -- ngan sach drop 0.55% la chap nhan duoc
  - Neu drop > 3 -> co van de thuc su (backend cham, VU pool thieu)

Day la mot SLO (Service Level Objective) thuc te:
  Khong phai "0 drop tuyet doi" (khong tuong),
  ma la "toi da 0.55% drop" (co the dat duoc).
```

### Validation ket qua that

```text
Run ID: #102
Exit code: 0
finish_status: 200

checks_rate:           1        (100%)
checks_passes/fails:   545 / 0
http_req_failed_rate:  0
dropped_iterations:    0
ramping_arrival_events_failed_rate: 0

iterations:            545
http_reqs:             545

=> PASS — tat ca criteria deu dat, khong co drop nao.
```

---

## 10. Cach chay + output 5 buoc

### Buoc 1: Kiem tra moi truong

```powershell
# Kiem tra k6 version
k6 version
# Expected: k6 v2.0.0+

# Kiem tra load-target
curl http://localhost:80/health
# Expected: HTTP 200

# Kiem tra metrics server (optional)
curl http://localhost:18080/v1/capabilities
# Expected: HTTP 200
```

### Buoc 2: Inspect script

```powershell
cd "E:\Khoa hoc\k6"
k6 inspect "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

Expected output:

```text
executor: ramping-arrival-rate
stages: [
  { target: 8, duration: 15s },
  { target: 20, duration: 20s },
  { target: 4, duration: 15s },
  { target: 0, duration: 5s }
]
exec: paymentWebhookWave
executor_family: ramping_arrival_rate
workload_shape: ramping_ingress_rate
```

### Buoc 3: Chay test local

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

Expected output console:

```text
execution: local
  script: ...\rar-03-payment-webhook-wave.js
  output: json (http://localhost:18080)

  scenarios: (100.00%) 1 scenario, 50 max VUs, 1m25s max duration
  * payment_webhook_wave: Up to 545 iterations/s for 55s (maxVUs: 50)

running (00m55.0s), 016/016 VUs, 545 complete and 0 interrupted iterations
payment_webhook_wave ✓ [======================================] 016 VUs  55s

     checks_rate.................: 1
     checks_passes..............: 545
     checks_fails................: 0
     dropped_iterations..........: 0
     http_req_failed_rate........: 0
     http_reqs...................: 545
     iterations..................: 545
```

### Buoc 4: Kiem tra du lieu dashboard

Vao dashboard (Grafana hoac metrics server UI):

1. Filter `case_id=rar-03-payment-webhook-wave`
2. Kiem tra execution timeline: iterations phai theo hinh wave
3. Kiem tra `dropped_iterations`: phai bang 0
4. Kiem tra `http_req_duration` p95/p99
5. Kiem tra `ramping_arrival_event_duration_ms` p95

### Buoc 5: Doc ket qua va ket luan

```text
Key signals:
  - iterations = 545 (dung scheduled slots)
  - dropped_iterations = 0 (khong mat event nao)
  - HTTP status: 100% 200 (tat ca webhook duoc accept)
  - Event p95 = 6ms (xu ly rat nhanh)
  - VUs: pool on dinh, khong can expand

Ket luan: Order service co kha nang hap thu payment webhook wave
         2 -> 8 -> 20 -> 4/s ma khong mat event nao.
```

---

## 11. Dashboard 3-chart reading guide

### Chart 1: Execution Timeline (iterations + http_reqs)

Chart nay hien thi tong so iteration va HTTP request hoan thanh theo thoi gian.

**Cach doc:**

```text
Tim kiem pattern:
  - iterations_trend: tang dan tu 2/s len 8/s (0-15s)
                      tang manh len 20/s (15-35s)
                      giam xuong 4/s (35-50s)
                      giam ve 0/s (50-55s)
  - http_reqs_trend:  trung voi iterations (1 call/event)
  - Tong iterations:  545 (phai khop voi scheduled slots)
```

**Dau hieu bat thuong can tim:**

```text
- iterations trend khong theo wave shape
  -> Scheduler khong giu duoc arrival curve
  -> Co the do VU pool qua nho hoac backend qua cham

- http_reqs < iterations
  -> Mot so event khong goi duoc HTTP (exception, parse error)
  -> Kiem tra log console

- iterations < scheduled_slots nhung dropped_iterations = 0
  -> Co interrupted_iterations
  -> Kiem tra gracefulStop hoac timeout

- http_req_failed > 0 (co diem do tren chart)
  -> Mot so webhook bi tu choi (4xx/5xx)
  -> Kiem tra log server xem tai sao
```

### Chart 2: Response Time (http_req_duration + event_duration)

Chart nay hien thi phan phoi thoi gian phan hoi cua HTTP request va event.

**Cach doc:**

```text
Filter: operation=payment_webhook_wave_receive

Doc p95/p99:
  - p95 = 6ms: 95% webhook xu ly trong 6ms
  - p99 = 21ms: 99% webhook xu ly trong 21ms
  - max = 39ms: request lau nhat

So sanh p95 voi p99:
  - p99/p95 = 21/6 = 3.5x -> tail latency co nhung khong qua nghiem trong
  - Neu p99/p95 > 10x -> co outlier nghiem trong (GC, DB lock, network timeout)

So sanh event_duration voi http_req_duration:
  - event_duration p95 = 6ms, http p95 = 5.73ms
  - Chenh lech ~0.27ms = JS overhead (Date.now(), userContext(), finishEvent())
  - Neu chenh lech > 100ms -> co van de JS code (khong phai HTTP)
```

**Dau hieu bat thuong can tim:**

```text
- p95 tang dot ngot o stage peak (20/s)
  -> Backend bi ap luc o peak, can scale
  -> Co the do claim_ttl_ms=4000 lam backend kiem tra idempotency cham

- p99 >> p95 (tail latency cao)
  -> Co mot vai request bi tre (network jitter, DB lock)
  -> Neu tail latency cao + dropped=0 -> intake van OK nhung UX khong tot

- max rat cao (> 1s)
  -> Co request bi timeout hoac retry
  -> Kiem tra claim_ttl_ms co du dai khong
```

### Chart 3: VUs vs iter/s (VU pressure)

Chart nay hien thi so VU dang hoat dong va arrival rate.

**Cach doc:**

```text
Voi case nay:
  - active VU: 0-1 (sampling 1s, events < 1s -> VU idle giua cac sample)
  - iter/s (arrival rate): 2 -> 8 -> 20 -> 4 -> 0 theo wave shape
  - vus_max: 16 (preAllocatedVUs, pool khong can expand)

Y nghia:
  - active VU ~ 0: backend xu ly webhook qua nhanh, VU gan nhu khong ban
  - vus_max = 16 = preAllocatedVUs: pool giu nguyen kich thuoc ban dau
  - Neu active VU tang cao o peak -> backend cham, can nhieu VU de giu nhịp
```

**Dau hieu bat thuong can tim:**

```text
- active VU tang cao + dropped_iterations = 0
  -> Backend cham nhung VU pool du de hap thu
  -> Canh bao: neu backend cham them, drop se xuat hien

- active VU tang cao + dropped_iterations > 0
  -> VU pool khong du -> mat event
  -> Can tang preAllocatedVUs hoac maxVUs

- vus_max > preAllocatedVUs
  -> Pool da expand -> dau hieu ap luc
  -> Neu vus_max = maxVUs -> pool da cham tran -> nguy co drop cao

- vus_max = preAllocatedVUs + active VU ~ 0
  -> Pool du, backend nhanh -> he thong khoe
  -> Day la tinh huong ly tuong
```

### Executor tab check

```text
Tren dashboard executor tab:
  - case_id = rar-03-payment-webhook-wave
  - executor = ramping-arrival-rate
  - Stage curve: 2 -> 8 -> 20 -> 4 -> 0
  - preAllocatedVUs = 16
  - maxVUs = 50
  - startRate = 2, timeUnit = 1s
```

### Advanced chart reading: event_duration vs time

Mot chart quan trong khac la **event_duration theo thoi gian**:

```text
Truc X: thoi gian (0 -> 55s)
Truc Y: event_duration_ms

Mau doc ly tuong cho case nay:
  - event_duration ON DINH (4-6ms) trong toan bo 55s
  - Khong tang o stage peak (20/s)
  - Khong co outlier > 50ms

Dau hieu canh bao:
  - event_duration tang dan o stage peak
    -> Backend bi ap luc, response time tang
    -> Little's Law: can nhieu VU hon -> co the drop
  - event_duration co spike dot ngot
    -> GC pause, DB lock, network timeout
    -> Co the gay tail latency cao
  - event_duration giam dan o stage drain
    -> Backend "duoi kip" sau peak
    -> Binh thuong neu backend recover
```

### Advanced chart reading: http_req_duration percentiles over time

```text
Mot so dashboard cho phep xem p50/p95/p99 theo thoi gian
(thay vi chi xem aggregate). Cach doc:

Tai t=0-15s (stage 1, 2->8/s):
  - p50, p95, p99 gan nhu trung nhau (~5ms)
  - Backend chua bi ap luc

Tai t=15-35s (stage 2, 8->20/s):
  - p95 co the tang nhe (6-8ms)
  - p99 co the tang (15-25ms)
  - Neu p99 >> p95 (tail latency) -> canh bao

Tai t=35-50s (stage 3, 20->4/s):
  - p95/p99 giam dan ve baseline
  - Backend "tho" duoc sau peak

Tai t=50-55s (stage 4, 4->0/s):
  - Percentiles on dinh o baseline
  - Test ket thuc sach

Neu p95 TANG LIEN TUC trong stage 2:
  - Backend co the bi "slow creep" (moi request cham hon request truoc)
  - Co the do connection pool can, memory leak, hoac queue build-up
```

### Cross-referencing 3 chart cung luc

```text
De hieu toan dien he thong, doc 3 chart DONG THOI:

1. Execution Timeline: iterations co theo wave shape khong?
   -> Xac nhan arrival curve dung

2. Response Time: p95/p99 co on dinh khong?
   -> Xac nhan backend khoe manh

3. VU Pressure: active VU co tang o peak khong?
   -> Xac nhan VU pool du capacity

Ket hop 3 chart:

Tinh huong A (ly tuong):
  Timeline: wave shape dung -> arrival OK
  Response: p95 thap, on dinh -> backend nhanh
  VU: active VU thap -> du capacity
  -> KET LUAN: PASS, he thong khoe

Tinh huong B (canh bao):
  Timeline: wave shape dung -> arrival OK
  Response: p95 cao o peak -> backend cham
  VU: active VU tang o peak -> VU pool bi ap luc
  -> KET LUAN: PASS (chua drop) nhung CANH BAO (gan tran)

Tinh huong C (FAIL):
  Timeline: iterations < scheduled -> mat slot
  Response: p95 rat cao -> backend qua cham
  VU: active VU = maxVUs -> pool can
  -> KET LUAN: FAIL, can scale

Tinh huong D (false green):
  Timeline: iterations < scheduled nhung dropped=0
  Response: p95 cao
  VU: khong co data -> KHONG CO VU chay?
  -> KET LUAN: SCRIPT LOI (exec= sai, hoac dieu kien khac)
```


---

## 12. 4 output -> decision scenarios

Day la phan quan trong nhat cua tai lieu: moi output pattern tu test dan den
hanh dong cu the. Khong chi la "pass/fail" -- moi pattern la mot cau chuyen.

### Scenario A: dropped=0, checks 100%, HTTP 200 het

**Output:**

```text
iterations = 545
dropped_iterations = 0
http_req_failed_rate = 0
checks_rate = 1
ramping_arrival_events_failed = 0
event p95 = 6ms
```

**Dien giai day du:**

```text
Day la "green path". Order service xu ly webhook wave sach se:
  - Tat ca 545 webhook event deu duoc nhan
  - Khong co event nao bi drop
  - 100% HTTP 200, tat ca check pass
  - Thoi gian xu ly trung binh 5ms, p95 = 6ms
  - VU pool (pre=16) du thua cong suat

Y nghia kinh doanh:
  - Payment provider webhook wave duoc hap thu toan bo
  - Khong don hang nao bi bo sot
  - Order service dang o trang thai khoe manh
```

**Hanh dong:**

```text
1. Ghi nhan day la baseline performance
2. Lap lai test dinh ky (tuan, thang) de phat hien regression
3. Neu provider tang peak (vi du 20 -> 40/s):
   - Tang preAllocatedVUs tuong ung
   - Chay lai test de xac nhan
4. Xem xet tang claim_ttl_ms neu can (hien tai 4s)
5. Document lai ket qua, bao cao cho team
```

### Scenario B: Unexpected status (4xx/5xx)

**Output:**

```text
iterations = 545
dropped_iterations = 0
http_req_failed_rate = 0.05   (5% fail, 27/545 requests)
checks_rate = 0.95             (5% check fail)
ramping_arrival_events_failed = 27

HTTP status distribution:
  200: 518
  500: 27   (Internal Server Error)
```

**Dien giai day du:**

```text
Co 27 webhook event bi HTTP 500. Nguyen nhan co the la:
  - Order service bi loi internal (DB connection pool can, OOM)
  - Webhook handler throw exception (data validation fail)
  - claim_ttl_ms config gay race condition
  - Backend bi qua tai o stage peak (20/s)

Dac biet voi webhook payment:
  - HTTP 500 nghia la provider khong nhan duoc 200
  - Provider se RETRY webhook sau vai giay
  - Neu retry cung 500 -> provider danh dau webhook "failed"
  - Order khong duoc cap nhat -> khach hang bi tru tien nhung order pending
```

**Hanh doan:**

```text
1. Mo log server, tim stack trace cua 27 request 500
2. Kiem tra DB connection pool metric cua order service
3. Kiem tra claim_ttl_ms co gay timeout khong
4. Neu 500 chi xuat hien o stage peak (20/s):
   -> Backend khong chiu duoc concurrency o peak
   -> Scale order service (them instance, them DB pool)
5. Neu 500 rai rac (khong tap trung o peak):
   -> Co the la bug, khong phai capacity
6. Rerun test sau khi fix
7. Kiem tra provider dashboard xem co webhook retry khong
```

### Scenario C: Duplicate/idempotency conflict

**Output:**

```text
iterations = 545
dropped_iterations = 0
http_req_failed_rate = 0
checks_rate = 1
ramping_arrival_events_failed = 0

Nhung tren backend log:
  WARN: Duplicate idempotency key detected: payment-webhook-...
  WARN: Idempotent request, skipping DB write for order_id=rar03-42
  Count: 12 duplicate events detected

Backend response cho duplicate:
  HTTP 200 (idempotent - no action)
```

**Dien giai day du:**

```text
Truong hop nay xay ra khi provider gui cung mot event nhieu lan
(hoac script co 2 iteration cung requestKey). Backend nhan ra
idempotency key da ton tai trong claim_ttl_ms=4000 (4 giay).

Phan biet:
  - K6 check: van 200 -> check pass -> checks_rate = 1
  - K6 HTTP: van 200 -> http_req_failed_rate = 0
  - Backend: phat hien duplicate -> KHONG xu ly lai -> an toan

Day KHONG PHAI LA FAIL! Day la idempotency HOAT DONG DUNG:
  - Webhook goi 2 lan
  - Backend tra 200 ca 2 lan (provider hai long)
  - Backend chi xu ly 1 lan (khong lap don hang)
  - Khong bi tru inventory 2 lan, khong bi ghi nhan doanh thu 2 lan
```

**Kiem tra them:**

```text
1. Xac nhan backend log: duplicate co bi "skip DB write" khong
2. Kiem tra order status: chi co 1 lan cap nhat 'paid'
3. Kiem tra claim_ttl_ms: du dai de bat duplicate trong wave peak
   Voi peak 20/s, 4s claim TTL -> toi da 80 event trong cua so
   -> Idempotency store co du capacity cho 80 keys khong?
4. Neu claim TTL qua ngan:
   - Provider retry sau 5s nhung claim TTL 4s -> duplicate khong duoc nhan ra
   - Backend xu ly webhook 2 lan -> order cap nhat 2 lan -> SAI
   - Tang claim_ttl_ms (vi du 10000ms = 10s)
```

### Scenario D: Dropped o wave peak

**Output:**

```text
iterations = 525
dropped_iterations = 20
scheduled_slots = 545
http_req_failed_rate = 0
checks_rate = 1
event p95 = 250ms  (tang tu 6ms len 250ms)
active VU max = 45
vus_max = 50

ramping_arrival_events_failed_rate = 0
  -> 20 slot drop truoc khi start -> KHONG CO HTTP call
  -> KHONG CO event fail -> KHONG CO event metric
  -> Chi thay qua dropped_iterations
```

**Dien giai day du:**

```text
Day la "red path". 20/545 = 3.7% webhook payment bi mat! Nguyen nhan:

1. Backend order service co p95 = 250ms (gap 40x binh thuong)
   -> Co the DB lock, cache miss, hoac network latency
2. Voi p95 = 250ms, Little's Law tai peak 20/s:
   required_VUs = 20 * 0.25 = 5 VUs
   -> 5 VU can thiet... nhung do tail latency co the cao hon
3. VU pool expanded tu 16 -> 50 (cham tran)
4. Mot so slot den nhung khong co VU san sang -> DROP

Dau hieu: tat ca HTTP request deu 200 (checks 100%),
nhung 20 webhook KHONG BAO GIO DUOC GOI.
Day la diem chet nguoi cua open model:
  "HTTP green" != "contract met"
```

**Hanh dong:**

```text
1. Xac dinh root cause cua p95=250ms:
   - DB slow query? -> optimize query, add index
   - DB connection pool can? -> tang pool size
   - Network latency? -> kiem tra network giua service va DB
   - GC pause? -> kiem tra JVM/Go runtime metrics

2. Neu backend da toi uu ma p95 van cao:
   - Tang preAllocatedVUs (vi du 16 -> 32)
   - Tang maxVUs (vi du 50 -> 80)
   -> Cho phep nhieu VU dong thoi de hap thu tail latency

3. Neu tang VU van khong giai quyet duoc (nhu rar-05):
   - VU pool khong phai la root cause
   - Can xem xet lai kien truc:
     + Them queue giua provider va order service
     + Async processing: nhan webhook -> queue -> xu ly sau
     + Separate thread pool cho webhook handler

4. Chap nhan drop budget:
   - Neu 3.7% drop la chap nhan duoc (business decision)
   - Tang MAX_DROPPED tu 3 -> 20
   - Nhung phai co alert: neu drop > 20 -> on-call

5. Dieu tra xem 20 webhook bi mat la nhung order nao:
   - Kiem tra order_id cua cac iteration bi drop
   - Lien he provider lay lai callback cho cac order bi mat
   - Manual fix order status neu can
```

---

## 13. Nghich ly / misconceptions

### Nghich ly 1: "Case don gian nhat series -- nhung la case quan trong nhat"

```text
rar-03 la case co cau truc don gian nhat (1 operation, 0 branch, 0 sleep).
Nhung day cung la case co y nghia kinh doanh LON NHAT:

- Webhook payment la duong mau cua he thong e-commerce
- Mat 1 webhook payment = 1 don hang loi = 1 khach hang gian
- Provider khong quan tam backend cua ban -- ho chi quan tam HTTP 200
- Idempotency la mandatory, khong phai optional

Su don gian cua no la co chu dich:
  - Co lap OPEN MODEL INGRESS khoi branching complexity
  - Tap trung vao viec doc arrival curve va dropped_iterations
  - Xac nhan rang chi can 1 POST + db_writes=2 cung co the gay drop
    neu backend khong du capacity
  - Lam nen tang de so sanh voi cac case phuc tap hon (rar-04, rar-05, rar-07)
```

### Nghich ly 2: "preAllocatedVUs=16 nhung active VU max=0"

```text
Dashboard hien thi active VU = 0. Nhung script van chay 545 iterations!
VU pool pre=16, max=50 -- VU dau?

Giai thich:
  - Dashboard sample VU active moi 1 giay
  - Moi event hoan thanh trong 5ms
  - Trong 1 giay, VU "ban" 5ms, roi "ranh" 995ms
  - Den luc sample -> VU dang ranh -> active VU = 0
  - Nhung VU VAN THUC THI CONG VIEC trong 5ms do

Day la bai hoc:
  - active VU chart khong phai la "so VU da su dung"
  - No la "so VU dang ban TAI THOI DIEM SAMPLE"
  - Voi event rat nhanh (< 1s), active VU sample luon thap
  - Dung vus_max (16) de biet VU pool size, dung active VU chart
    de biet ap luc tai thoi diem sample
```

### Nghich ly 3: "db_writes=2 nhung p95 chi 5ms"

```text
Tai sao ghi 2 dong DB ma chi ton 5ms? Trong thuc te, DB write co the
ton 10-50ms hoac hon.

Giai thich:
  - Load-target la mock server, DB la in-memory hoac SQLite local
  - db_writes=2 la "gia lap" write, khong phai write that vao PostgreSQL
  - cpu_ms=1: chi 1ms CPU processing duoc gia lap
  - Muc dich: verify rang arrival curve duoc giu nguyen,
    khong phai benchmark DB performance

De test webhook voi DB that:
  - Tro load-target vao backend that (staging)
  - Hoac tang cpu_ms=50, db_writes=10 de mo phong DB that cham hon
  - Hoac dung external_ms de mo phong external dependency latency
```

### Nghich ly 4: "claim_ttl_ms=4000 -- 4 giay la du hay thieu?"

```text
4 giay la mot con so duoc chon co chu dich:

- Provider retry policy: thuong la 5-10 giay
- Vay 4 giay claim TTL co du de bat duplicate khong?
  - Neu provider retry sau 5s -> duplicate den sau khi claim het han
  - Backend se khong nhan ra duplicate -> xu ly 2 lan -> SAI

- Nhung 4 giay cung co y nghia:
  - Giu claim store nho (toi da ~80 keys tai peak 20/s)
  - Tranh memory leak neu co qua nhieu keys
  - Phu hop neu provider retry trong vong 1-2 giay

- Neu provider retry sau 5s: tang claim_ttl_ms len 10000 (10s)
  - Claim store: toi da ~200 keys tai peak 20/s -> van nho
  - An toan: bat duoc duplicate ngay ca khi provider retry cham
```

### Nghich ly 5: "iterations=545, nhung chi co 500 order trong pool"

```text
Tai sao 545 webhook nhung chi co 500 order ID (USER_POOL=500)?

Day la thiet ke co chu dich:
- 500 order dai dien cho "tap don hang hoat dong"
- 545 webhook trong 55s nghia la mot so order nhan duoc > 1 webhook
- Cu the: 45 order nhan 2 webhook, 455 order nhan 1 webhook
- Dieu nay mo phong thuc te: mot order co the co nhieu su kien
  thanh toan (authorize + capture + refund)

Y nghia:
- Khong phai moi webhook la mot order moi
- Mot order co the duoc cap nhat 'paid' nhieu lan (idempotent)
- Backend phai xu ly dung: order da 'paid' -> van tra 200, khong thay doi
- Day la test "realistic data distribution", khong phai "1 order = 1 webhook"

Neu muon 1 order = 1 webhook (unique):
  -> USER_POOL >= 545 (vi du USER_POOL=1000)
  -> Tat ca orderId deu unique trong toan test
  -> Khong co order nao nhan webhook 2 lan
```

### Nghich ly 6: "test nay pass 100% -- vay no co gia tri gi?"

```text
Neu test luon pass (545 iter, 0 drop, 100% checks), tai sao con can chay?

Cau tra loi:
1. Xac nhan BASELINE: ghi nhan rang voi pre=16, order service HAAP THU DUOC
   20/s peak. Day la baseline de so sanh sau nay.

2. Phat hien REGRESSION: thang sau, backend them feature moi, p95 tang
   tu 6ms len 200ms -> test se FAIL (drop > 0).
   Neu khong co baseline, ban khong biet "binh thuong" la gi.

3. Kiem tra INFRASTRUCTURE: neu chay test tren moi truong moi (new cluster,
   new DB) ma drop > 0 -> moi truong co van de.

4. Xac nhan CONFIG DUNG: inspect script, verify metrics, verify dashboard
   charts match expected values.

5. So sanh voi VARIATIONS: chay variation voi peak 30/s, pre=8, claim_ttl_ms=500
   -> so sanh ket qua de hieu impact cua tung tham so.

6. DOCUMENT EVIDENCE: co du lieu that de bao cao "order service pass webhook
   wave ingress test" cho stakeholders.

Gia tri cua test khong phai la "tim ra loi" -- con la "xac nhan dung dan".
Ca 2 deu co gia tri nhu nhau.
```

### Nghich ly 7: "chi co 1 POST request nhung van can open model"

```text
Tai sao chi 1 request don gian ma phai dung ramping-arrival-rate?

Neu dung constant-vus voi vus=1, maxDuration=55s:
  - 1 VU tu loop: POST -> cho response -> POST -> ...
  - Moi iteration ~5ms -> 200 iterations/s
  - 55s -> 11,000 iterations!!
  - KHONG mo phong duoc wave 20/s peak
  - KHONG mo phong duoc external producer

Su khac biet CO BAN:
  - Voi 1 request don, closed model tao ra qua nhieu throughput
    (vi VU khong bao gio idle, khong simulate user think time)
  - Open model tao ra DUNG arrival rate (20/s peak) doc lap voi
    toc do xu ly

So luong request KHONG phai la yeu to quyet dinh chon executor.
HINH DANG cua traffic (wave, fixed, burst) moi la yeu to quyet dinh.
```

---

## 14. Checklist

Truoc khi chay test nay, kiem tra cac dieu kien sau:

### Pre-flight

```text
[ ] k6 version >= v2.0.0
[ ] Load-target dang chay (curl http://localhost:80/health -> 200)
[ ] BASE_URL da duoc set ($env:BASE_URL = "http://localhost:80")
[ ] Script inspect pass (k6 inspect ... -> executor=ramping-arrival-rate)
[ ] Khong co script nao khac dang chay tren cung load-target
```

### Config check

```text
[ ] RAR_03_START_RATE = 2 (hoac gia tri mong muon)
[ ] RAR_03_WAVE_RATE = 20 (peak rate)
[ ] RAR_03_DURATION_SCALE = 1 (hoac scale neu can run nhanh/cham)
[ ] RAR_03_PREALLOCATED_VUS = 16 (du cho peak 20/s voi event < 10ms)
[ ] RAR_03_MAX_VUS = 50 (tran an toan)
[ ] RAR_03_MAX_DROPPED = 3 (ngan sach drop 0.55%)
[ ] RAR_03_USER_POOL = 500 (pool identity)
```

### Run validation

```text
[ ] iterations = 545 (±1) -- dung scheduled slots
[ ] dropped_iterations = 0 (hoac <= MAX_DROPPED)
[ ] http_reqs = 545 (1 call/event)
[ ] http_req_failed_rate < 0.01
[ ] checks_rate > 0.99
[ ] ramping_arrival_events_failed < 10
[ ] Event p95 < 100ms (voi load-target local)
[ ] Tat ca HTTP method = POST, status = 200
```

### Post-run

```text
[ ] Dashboard hien thi du lieu (neu dung metrics server)
[ ] Execution timeline theo dung wave shape
[ ] Khong co dau hieu idempotency conflict (neu khong muon)
[ ] VU pool khong cham tran (vus_max < maxVUs, tru khi co chu dich)
[ ] So sanh voi baseline lan chay truoc (neu co)
```

---

## 15. 4-5 variations

### Variation 1: Higher wave peak (30/s)

Muc dich: test xem order service chiu duoc peak cao den dau.

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_03_WAVE_RATE = "30"
$env:RAR_03_PREALLOCATED_VUS = "32"
$env:RAR_03_MAX_VUS = "80"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

Expected:

```text
Stage math voi WAVE_RATE=30:
  (2+8)/2 x 15  = 75
  (8+30)/2 x 20 = 380
  (30+4)/2 x 15 = 255
  (4+0)/2 x 5   = 10
  Total          = 720 slots

Tang preAllocatedVUs vi:
  Little's Law: 30 * 0.005 = 0.15 VU -> van it
  Nhung de an toan cho tail latency, pre=32 la hop ly
  max=80 cho phep pool expand neu can

Neu dropped > 0: backend khong chiu duoc 30/s peak
  -> Xem xet scale order service
  -> Hoac tang maxVUs them nua
```

### Variation 2: Duplicate provider_event_id

Muc dich: kiem tra idempotency behavior khi provider gui cung event nhieu lan.
Day la variation quan trong nhat vi duplicate la **khong tranh khoi** trong
production.

**Cach 1: Giam USER_POOL de order_id xoay vong nhanh hon**

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_03_USER_POOL = "100"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

Voi USER_POOL=100 va 545 iterations:
- Moi order_id xuat hien 5-6 lan
- provider_event_id van unique (vi gan voi requestKey)
- Nhung order_id trung lap -> test idempotency o tang order

**Cach 2: Modify script de lap provider_event_id co chu dich**

```javascript
// Trong script, thay dong:
provider_event_id: `evt-${ctx.requestKey}`,
// Thanh:
provider_event_id: `evt-${ctx.iter % 100}`,  // Chi co 100 event ID
```

Voi thay doi nay:
- Co 100 provider_event_id duy nhat
- 545 iterations -> moi event ID xuat hien 5-6 lan
- Backend se thay duplicate thuc su (cung provider_event_id)

Expected behavior voi duplicate that:

```text
- Backend van tra 200 cho tat ca request (ca duplicate)
- checks_rate = 1 (k6 khong biet do la duplicate)
- http_req_failed_rate = 0
- Backend log: "Idempotent request detected, skipping processing"
- DB: chi co 100 event duoc xu ly (first write wins)
- So sanh: ramping_arrival_events_total = 545 (all started)
           nhung DB chi co 100 rows (chi 100 duoc xu ly)

Kiem tra claim store:
  - Tai peak 20/s: neu moi event ID ton tai trong 4s
  - Toi da 80 keys trong claim store tai mot thoi diem
  - Claim store memory OK
```

**Cach 3: Chay 2 script cung luc voi cung event IDs**

```powershell
# Terminal 1
$env:BASE_URL = "http://localhost:80"
$env:RAR_03_USER_POOL = "100"
k6 run "...\rar-03-payment-webhook-wave.js"

# Terminal 2 (cung luc)
$env:BASE_URL = "http://localhost:80"
$env:RAR_03_USER_POOL = "100"
k6 run "...\rar-03-payment-webhook-wave.js"
```

Cach nay mo phong 2 instance cua cung mot service nhan webhook tu
cung provider -- tinh huong thuong gap khi co nhieu pod/container.

Expected voi 2 script:

```text
- Ca 2 script deu tra 200, checks=100%
- Backend thay duplicate tu 2 nguon khac nhau (2 instance)
- Claim store phai global (Redis) de ca 2 instance thay cung keys
- Neu claim store local (in-memory) -> duplicate khong duoc nhan ra
  -> DAY LA BUG THUC TE: neu claim store khong global, duplicate
     tu instance khac se bi xu ly 2 lan
```

### Variation 3: claim_ttl_ms experiment

Muc dich: test impact cua claim TTL len idempotency behavior.

**Experiment 3a: claim_ttl_ms=500 (rat ngan)**

```text
URL: /api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=500

Cua so idempotency: 0.5 giay
Tai peak 20/s: ~10 keys trong claim store
Claim store size: rat nho (memory-efficient)

Rui ro:
- Provider retry policy thuong la 5s+ -> duplicate se KHONG duoc nhan ra
- Neu cung mot event den 2 lan trong 0.5s -> OK (bat duoc)
- Neu cung mot event den 2 lan sau 1s -> MISS (khong bat duoc)

Ket qua thuc te neu duplicate cach nhau 1s:
- Lan 1: xu ly webhook -> order 'paid'
- Lan 2 (sau 1s): key het han -> xu ly lai -> order van 'paid' nhung DB write 2 lan
- He qua: accounting ghi nhan 2 giao dich -> sai so sach
```

**Experiment 3b: claim_ttl_ms=10000 (dai)**

```text
URL: /api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=10000

Cua so idempotency: 10 giay
Tai peak 20/s: ~200 keys trong claim store
Claim store size: gap 2.5x so voi default

Loi ich:
- Bat duoc duplicate trong 10s
- An toan cho provider retry policy (thuong < 10s)
- Phu hop production

Chi phi:
- 200 keys * ~200 bytes/key = 40KB -> khong dang ke
- Nhieu keys -> lookup cham hon? -> thuc te khong dang ke (hash map O(1))
- Can dam bao claim store duoc clean up sau 10s
```

**Experiment 3c: claim_ttl_ms=0 (disable idempotency)**

```text
URL: /api/sim/orders/webhooks/payment?cpu_ms=1&db_writes=2&claim_ttl_ms=0

Idempotency: TAT
Claim store: KHONG SU DUNG

Rui ro:
- MOI request deu duoc xu ly nhu moi
- Duplicate provider_event_id -> 2 lan xu ly
- Khong co co che bao ve

KHONG BAO GIO DUNG TRONG PRODUCTION!
Chi dung de test: "neu khong co idempotency, he thong co crash khong?"
```

So sanh cac claim_ttl_ms:

| claim_ttl_ms | Cua so bat duplicate | Keys tai peak 20/s | An toan cho retry < 5s? | Memory |
| ---: | --- | ---: | --- | --- |
| 500 | Rat ngan (0.5s) | ~10 | KHONG | Thap |
| 4000 (default) | Trung binh (4s) | ~80 | Gan du | Thap |
| 10000 | Dai (10s) | ~200 | CO | Thap (40KB) |
| 60000 | Rat dai (60s) | ~1200 | CO | Trung binh (240KB) |
| 0 (disable) | Khong co | 0 | KHONG | Khong ton

### Variation 4: Smoke test (1/10 scale)

Muc dich: verify script hoat dong truoc khi chay full duration.

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_03_DURATION_SCALE = "0.1"

k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js"
```

Expected:

```text
Stage math voi SCALE=0.1:
  Stage 1: 1.5s tu 2->8/s  (thay vi 15s)
  Stage 2: 2.0s tu 8->20/s  (thay vi 20s)
  Stage 3: 1.5s tu 20->4/s  (thay vi 15s)
  Stage 4: 0.5s tu 4->0/s   (thay vi 5s)
  Total: 5.5s (thay vi 55s)
  Scheduled slots: ~54 (thay vi 545)

Smoke test cho phep:
  - Xac nhan script syntax dung
  - Xac nhan load-target responding
  - Xac nhan metrics duoc push (neu dung metrics server)
  - Thay loi som truoc khi chay full 55s
```

### Variation 5: Different payment statuses

Muc dich: test webhook voi nhieu loai status khac nhau (paid, refunded, failed).

```javascript
// Modify script de chon status theo iter:
const statuses = ['paid', 'refunded', 'pending', 'failed'];
const status = statuses[ctx.iter % statuses.length];
```

Expected:

```text
- K6 check: van expected 200 cho tat ca status
- Backend xu ly khac nhau tuy status:
  + paid: cap nhat order status = 'paid'
  + refunded: cap nhat order status = 'refunded', trigger refund flow
  + pending: giu nguyen order status, chi log
  + failed: cap nhat order status = 'payment_failed', notify khach
- Neu co test rieng cho tung status -> verify backend flow dung cho moi status
```

---

## 16. Anti-patterns

### Anti-pattern 1: Dung closed model de test webhook ingress

```text
SAI: Dung constant-vus hoac ramping-vus cho case nay.

Tai sao sai:
  - Provider la external producer -- arrival rate doc lap
  - Closed model throughput phu thuoc VU loop duration
  - Khong the mo phong dung wave shape cua provider
  - Backend cham -> throughput tu giam -> test van pass -> mat event that

DUNG: ramping-arrival-rate voi startRate + stages mo phong dung provider wave.
```

### Anti-pattern 2: Khong co idempotency key

```text
SAI: Bo qua Idempotency-Key header trong request.

Tai sao sai:
  - Provider co the retry cung mot webhook
  - Khong co idempotency -> backend xu ly webhook 2 lan
  - Order cap nhat 2 lan, inventory tru 2 lan
  - Du lieu sai, accounting sai

DUNG: Luon gui Idempotency-Key header voi gia tri unique cho moi lan goi.
      Backend phai ho tro idempotency (claim_ttl_ms > provider retry interval).
```

### Anti-pattern 3: preAllocatedVUs qua thap cho peak

```text
SAI: preAllocatedVUs = 2 cho peak 20/s.

Tai sao sai:
  - Du Little's Law noi chi can 0.1 VU
  - Nhung VU khoi tao mat thoi gian (cold start)
  - Neu backend co tail latency (p99 = 200ms):
    20 * 0.2 = 4 VUs can thiet -> 2 la khong du
  - VU pool expand mat thoi gian -> drop trong khi cho
  - Drop xay ra o nhung giay dau tien cua peak

DUNG: preAllocatedVUs phai du cho Little's Law VOI P99, khong phai avg.
      Voi p99 = 200ms, pre = 20 * 0.2 * 2 (buffer) = 8 VUs.
```

### Anti-pattern 4: Khong doc dropped_iterations

```text
SAI: Chi nhin checks_rate va http_req_failed_rate de danh gia pass/fail.

Tai sao sai:
  - checks=100% + http_failed=0% KHONG DAM BAO contract met
  - dropped_iterations > 0 nghia la co slot KHONG DUOC START
  - Nhung slot khong duoc start -> khong co HTTP call -> khong co check
  - Checks va HTTP chi danh gia cac event DA CHAY, khong danh gia event BI MAT

Vi du that: rar-05
  checks=100%, http_failed=0%, dropped=20 -> FAIL!
  Mot minh checks va HTTP la "false green"

DUNG: dropped_iterations la PRIMARY pass/fail signal.
      Phai kiem tra dropped TRUOC, roi moi kiem tra checks va HTTP.
```

### Anti-pattern 5: Khong hieu su khac biet giua event_duration va http_req_duration

```text
SAI: Cho rang event_duration va http_req_duration la nhu nhau.

Tai sao sai:
  - event_duration = toan bo thoi gian tu start den finishEvent()
  - http_req_duration = thoi gian HTTP request
  - Chenh lech = JS code execution time (userContext, log, finishEvent)
  - Trong case multi-call (rar-04): event co 3 HTTP call -> event_duration >> http_req_duration

DUNG: event_duration de biet end-to-end latency cua 1 webhook xu ly.
      http_req_duration de biet latency cua tung HTTP call.
      Chenh lech giua 2 metric la JS overhead.
```

### Anti-pattern 6: Khong test idempotency behavior

```text
SAI: Chi test webhook voi provider_event_id unique. Khong test duplicate.

Tai sao sai:
  - Trong production, provider CHAC CHAN se gui duplicate
  - Neu khong test idempotency -> khong biet backend xu ly duplicate dung khong
  - Co the backend crash hoac sai data khi gap duplicate

DUNG: Them variation test voi duplicate provider_event_id.
      Xac nhan backend:
      - Tra 200 cho duplicate (khong 4xx/5xx)
      - Khong xu ly duplicate (idempotent)
      - Claim TTL du dai de bat duplicate trong khoang thoi gian retry
```

---

## 17. Real validation data

### Summary tu validation run that

```text
Run ID: #102
Script: rar-03-payment-webhook-wave.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
```

### Bang metrics chinh

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` |
| `checks_passes / checks_fails` | `545 / 0` |
| `http_req_failed_rate` | `0` |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `545` |
| `iterations_rate` | `9.91/s` |
| `http_reqs` | `545` |
| `http_reqs_rate` | `9.91/s` |
| `vus_max` | `0` |
| `ramping_arrival_event_duration_ms avg / med / p95 / p99 / max` | `5.19 / 5 / 6 / 21 / 39 ms` |
| `http_req_duration avg / med / p95 / p99 / max` | `5.05 / 4.40 / 5.73 / 19.94 / 38.33 ms` |

### Request breakdown

```text
payment_webhook_wave_receive POST 200 count=545
```

### Dashboard series verification

```text
iterations:        points=55, sum=545, min=1, max=20, truncated=false
http_reqs:         points=545, sum=545, min=1, max=1, truncated=false
dropped_iterations: points=0, truncated=false
vus:               points=55, min=0, max=0, truncated=false
```

### Stage math reconciliation verified

| Stage | Computed | Observed | Match |
| --- | ---: | ---: | --- |
| 1 (2->8/s, 15s) | 75 | 75 | Exact |
| 2 (8->20/s, 20s) | 280 | 280 | Exact |
| 3 (20->4/s, 15s) | 180 | 180 | Exact |
| 4 (4->0/s, 5s) | 10 | 10 | Exact |
| **Total** | **545** | **545** | **Exact** |

### Verdict

```text
PASS — default ramping-arrival-rate case giu duoc arrival curve:
  - checks sach (100%)
  - HTTP failed 0%
  - dropped_iterations = 0
  - ramping_arrival_events_failed = 0
  - Stage math exact match (545 slots -> 545 iterations)
  - Event p95 = 6ms, HTTP p95 = 6.36ms
  - VU pool on dinh, khong can expand

Order service hap thu payment webhook wave thanh cong o peak 20/s.
```

---

## 18. Reference

- **Script:** `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-03-payment-webhook-wave.js`
- **Common helpers:** `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
- **Validation report:** `E:\Khoa hoc\k6\docs\practice\ramping-arrival-rate\08_validation-and-chart-analysis.md` (section rar-03)
- **Run guide:** `E:\Khoa hoc\k6\RUN_GUIDE.md`
- **Series overview:** `E:\Khoa hoc\k6\docs\practice\ramping-arrival-rate\00_overview.md`
- **Comparison case (CAR open model):** `E:\Khoa hoc\k6\docs\practice\constant-arrival-rate\01_storefront-rps-contract.md`
