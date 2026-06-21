
# Case 02: Login Burst Recovery

> **Script:** `rar-02-login-burst-recovery.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 24 arrivals/s
> **Focus:** Auth login/me/refresh wave sau notification hoặc app-open burst.

---

## 1. Tinh huong thuc te

### Boi canh kinh doanh

Mot notification push duoc gui di hang loat vao 9:00 AM -- "Flash sale gio vang! Giam
50% tat ca mat hang!". Hieu ung tuc thi:

```text
09:00:00.000  Push notification den 500,000 devices
09:00:01.500  Nguoi dung tap vao notification -> app mo
09:00:01.800  App yeu cau auth token (login hoac refresh)
09:00:02.000  Auth service bat dau nhan luong request khong lo
09:00:05.000  Burst dat dinh: hang ngan user login cung luc
09:00:20.000  Burst giam dan, user bắt đầu browse san pham
09:00:35.000  Traffic auth tro lai binh thuong
```

Day la **ingress burst** -- luong request tu ben ngoai do vao auth service theo hinh
dang cong (curve), khong phai flat rate. No khong do backend quyet dinh, cung khong
do so user "dang ngoi trong app" quyet dinh. No do **notification producer** va
**mobile app lifecycle** quyet dinh.

### Ba giai doan cua auth burst

Mot auth burst dien hinh trai qua 3 giai doan ro ret:

**Giai doan 1 -- Pre-burst (t=0 den t=15s):**

```text
User bat dau tap vao notification.
Moi giay co vai nguoi mo app, app check session.
Neu session con han -> dung refresh token.
Neu session het han -> login lai.
Traffic tang dan tu 1/s len 6/s.

Day la giai doan "rom ram" truoc khi burst that su.
So luong request con nho, auth service van trong trang thai idle.
```

**Giai doan 2 -- Burst peak (t=15s den t=30s):**

```text
Hang loat user dong loat mo app hoac chuyen tu background sang foreground.
App bundle yeu cau login + /me + refresh trong cung mot app-open cycle.
Traffic nhay vot tu 6/s len 24/s trong 15 giay.

Day la giai doan "sap server" -- la noi auth service duoc kiem nghiem that su.
24 arrivals/s nghia la cu moi ~42ms lai co mot user moi "go cua".
Neu auth cham (>42ms/event), hang doi bat dau xep hang.
```

**Giai doan 3 -- Recovery + drain (t=30s den t=50s):**

```text
Da so user da login xong, app chuyen sang browse products.
Auth request giam dan: 24/s -> 5/s -> 0/s.
User da co token session tiep tuc dung app ma khong goi auth nua.
Auth service tro ve trang thai nhan roi.
```

### Cau hoi kinh doanh

Business khong hoi "auth service xu ly duoc bao nhieu user cung luc?". Ho hoi:

```text
"Auth service co hap thu login burst 1 -> 6 -> 24 -> 5/s ma khong fail/drop khong?"
```

Day la cau hoi ve **ingress capacity curve** -- mot duong cong voi dinh, khong phai
mot flat rate. Noi cach khac:

```text
Khong phai: "Chiu duoc 24/s trong 50s lien tuc khong?"
Ma la:     "Chiu duoc duong cong: 1 -> 6 -> 24 -> 5 -> 0 khong?"
```

Diem yeu cua auth service trong burst:

```text
1. Login la write-ish path (db_rows=1, cpu_ms=2) -- database co the la bottleneck
2. /me la read path nhung co memory_kb=4 -- memory allocation cham hon CPU don thuan
3. Refresh token la write path (db_writes=1) -- ghi db trong luc burst de gay lock contention
4. Tat ca 3 nhanh deu can query/ghi db -- auth DB la single point of congestion
5. Token generation (JWT signing) la CPU-bound -- khong cache duoc
```

Neu auth service khong hap thu duoc burst nay:

```text
- User thay spinner quay mai -> tuong app bi loi -> tat app -> uninstall
- Login fail -> user khong vao duoc flash sale -> mat doanh thu
- Refresh token fail -> user dang browse bi da ra ngoai -> mat session
- /me fail -> app khong hien thi duoc ten/avatar -> UX te -> user roi bo
- Gateway timeout tra ve 502/504 -> CDN cache error page -> hang nghin user thay loi
```

### Vi sao day la ingress curve, khong phai fixed user pool?

Day la diem khac biet quan trong nhat giua ramping-arrival-rate va constant-vus:

```text
constant-vus (closed model):
  - 50 VUs lien tuc goi auth trong 50s
  - Moi VU: login -> /me -> refresh -> login -> ...
  - Khi backend cham -> VU loop cham -> throughput tu giam
  - Test bao "pass" nhung thuc te burst that thi service sap

ramping-arrival-rate (open model):
  - Lich arrival doc lap: 1 -> 6 -> 24 -> 5 -> 0/s
  - VU chi la worker pool xu ly arrival slot
  - Khi backend cham -> can nhieu VU hon de giu arrival schedule
  - Neu khong du VU -> dropped_iterations -> test FAIL
```

Ly do auth traffic la ingress curve chu khong phai fixed user count:

```text
1. Nguon goc traffic: notification push -> app open -> auth request
   Day la EXTERNAL trigger, khong lien quan den backend performance.

2. Toc do arrival: quyet dinh boi mobile OS notification delivery +
   user reaction time, KHONG boi auth service response time.

3. Nguoi dung khong "cho auth xong roi moi mo app tiep" --
   ho tap vao notification cung luc, doc lap voi nhau.

4. So luong nguoi dung CO THE bi gioi han (600 user pool),
   nhung TOC DO ho den lai do notification delivery curve quyet dinh.

5. Backend cham khong lam "it nguoi mo app hon" --
   no chi lam nhieu nguoi thay spinner lau hon.
```

---

## 2. 2 yeu cau cot loi

Case nay co **2 yeu cau cot loi** ma chi `ramping-arrival-rate` moi thoa man
duoc dong thoi.

### Yeu cau (a): MO PHONG DUNG INGRESS BURST CURVE

**Y nghia**: K6 phai tao ra luong arrival slot theo dung duong cong
`1 -> 6 -> 24 -> 5 -> 0/s`, bat ke backend dang nhanh hay cham. Day la dieu kien
tien quyet de test auth burst contract.

**Vi du cu the**:

```text
Config: startRate=1, stages:
  15s target=6 (pre-burst ramp)
  15s target=24 (burst peak)
  15s target=5 (recovery)
  5s target=0 (drain)

Timeline 50 giay:
  t=0.0s:  slot #0   duoc schedule (rate ~1/s)
  t=1.0s:  slot #1   duoc schedule
  t=2.0s:  slot #2   duoc schedule (rate tang dan...)
  ...
  t=7.5s:  slot #26  duoc schedule (rate ~3.5/s giua 1->6)
  ...
  t=15.0s: slot #52  duoc schedule (ket thuc pre-burst, rate=6/s)
  t=15.5s: slot #55  duoc schedule (rate ~6.6/s, vua vao burst)
  ...
  t=22.5s: slot #187 duoc schedule (rate ~15/s, giua 6->24)
  ...
  t=30.0s: slot #277 duoc schedule (dinh burst, rate=24/s)
  t=30.5s: slot #289 duoc schedule (rate ~23.4/s, bat dau recovery)
  ...
  t=45.0s: slot #495 duoc schedule (rate=5/s, cuoi recovery)
  t=45.5s: slot #497 duoc schedule (rate ~4.5/s, vao drain)
  ...
  t=50.0s: slot #507 duoc schedule (rate=0/s, ket thuc)

Tong: ~507.5 slots duoc schedule theo duong cong.
```

Diem quan trong: cac slot duoc schedule **dung theo duong cong**, khong phu thuoc
vao viec slot truoc da xong hay chua. Giong nhu:

```text
Dong nguoi xep hang vao san van dong:
  - Cong mo luc 9:00, 1 nguoi/giay (pre-burst)
  - Den 9:15, toc do tang len 6 nguoi/giay
  - 9:30 dinh diem: 24 nguoi/giay
  - 9:45 giam dan: 5 nguoi/giay
  - 10:00 dong cong: 0 nguoi/giay

Du nhan vien soat ve cham -> nguoi VAN DEN theo lich.
Neu thieu nhan vien -> nguoi bo ve (= dropped_iterations).
Khong ai giam toc do den chi vi nhan vien cham ca.
```

**Kiem chung voi so lieu that tu run thuc te**:

```text
startRate=1, stages: 15s->6, 15s->24, 15s->5, 5s->0
scheduled_slots = 52.5 + 225 + 217.5 + 12.5 = 507.5
iterations thuc te = 507
dropped_iterations = 0

=> N_sched ~= N_done + N_drop = 507 + 0 = 507
=> Contract giu duoc ~100% (507/507.5, sai lech 0.5 la boundary micro-timing)
```

### Yeu cau (b): PHAT HIEN CONTRACT BREACH QUA dropped_iterations

**Y nghia**: Khi auth service khong du capacity de xu ly burst dinh 24/s, test phai
**bao loi ro rang** qua `dropped_iterations` (mat arrival slot), khong duoc "im lang
pass" nhu closed model.

**Vi du cu the**:

```text
Tinh huong: Auth DB bi lock 200ms do qua nhieu login write cung luc

Voi constant-vus (closed model):
  - VU loop login -> /me -> refresh lap lai
  - Khi DB lock, moi VU loop cham hon
  - Throughput tu giam, nhung KHONG bao loi
  - Test pass -> False negative

Voi ramping-arrival-rate (open model):
  - Arrival slot van den dung lich (1 -> 6 -> 24 -> 5 -> 0/s)
  - Moi event ton nhieu thoi gian hon (login 200ms thay vi 2ms)
  - Can nhieu VU hon de giu arrival schedule
  - VU pool can -> slot khong co worker -> dropped_iterations++
  - Test FAIL -> phat hien duoc contract breach
```

**Kiem chung voi so lieu that tu cac case khac trong series**:

Case `rar-05` la vi du dien hinh ve dropped_iterations:

```text
rar-05 report job ingress ramp:
  startRate=1, stages: 15s->3, 20s->8, 15s->2, 5s->0
  scheduled_slots = 220
  iterations thuc te = 199
  dropped_iterations = 20
  event p95 = 9.01s
  Threshold: dropped_iterations <= 0 -> FAIL

  => Contract breach duoc phat hien!
  => 20 slot bi mat o giai doan peak (3->8/s)
```

Trong khi do, rar-02 mac dinh:

```text
rar-02 login burst recovery:
  iterations = 507, dropped_iterations = 0
  event p95 = 23ms
  Threshold: dropped_iterations <= 3 -> PASS

  => Auth burst contract duoc giu vung o default config.
```

### Tai sao ca 2 yeu cau phai thoa man DONG THOI?

```text
Neu CHI co (a) ma khong co (b):
  - Arrival curve dung nhung khong co co che bao breach
  - Giong nhu bieu do nhiet do chinh xac nhung khong co canh bao sot

Neu CHI co (b) ma khong co (a):
  - Co bao loi nhung arrival curve khong dung
  - Khong test duoc dung ingress burst contract
  - Giong nhu canh bao chay nhung cam bien dat sai vi tri

Ca 2 cung co -> ramping-arrival-rate la executor DUY NHAT thoa man
cho traffic co hinh dang cong (curve-shaped ingress).
```

---

## 3. Vi sao dung `ramping-arrival-rate`?

### So sanh 5 executor

Bang duoi day so sanh tat ca executor ma k6 cung cap, phan tich vi sao moi cai
**khong phu hop** cho case auth ingress burst:

| Executor | Model | Cach hoat dong | Vi sao KHONG phu hop cho auth burst? |
| --- | --- | --- | --- |
| **ramping-arrival-rate** | Open | Schedule iteration theo arrival rate thay doi qua cac stage. VU la worker pool. | **PHU HOP**: Mo phong dung ingress curve (pre-burst -> peak -> recovery). Drop bao contract breach o peak stage. |
| constant-arrival-rate | Open | Schedule iteration theo rate/timeUnit CO DINH. | Chi giu duoc MOT flat rate. Khong mo phong duoc curve 1->6->24->5->0. Dung cho RPS contract co dinh (vd: "chịu 20/s lien tuc"), khong dung cho burst. |
| constant-vus | Closed | Giu N VU chay lien tuc. Moi VU loop: goi auth -> cho -> goi tiep. | Backend cham -> VU loop cham -> throughput tu giam. Khong phat hien contract breach o burst peak. KHONG test duoc ingress curve. |
| shared-iterations | Closed | Chia N iterations cho M VUs. VU nao xong truoc nhan iteration tiep. | Tong iteration co dinh, nhung rate phu thuoc VU speed. Khong co schedule. Khong test duoc "1->24/s curve". |
| per-vu-iterations | Closed | Moi VU chay dung K iterations. Khong chia se. | Count co dinh nhung rate khong kiem soat. Dung de regression test (input giong nhau qua cac release), khong phai burst contract. |
| ramping-vus | Closed | Tang/giam so VU theo stage. Throughput phu thuoc VU count va loop time. | VU count thay doi theo stage, nhung throughput van phu thuoc latency. Khong giu duoc arrival rate co dinh o tung stage. |

### Phan tich sau: vi sao constant-arrival-rate khong du cho auth burst?

Day la mot nham lan pho bien: "auth burst chi can test o peak 24/s la du". Su that:

```text
constant-arrival-rate: rate=24/s, duration=50s
  -> 24 × 50 = 1200 arrivals flat
  -> Test pass neu chiu duoc 24/s LIEN TUC trong 50s

Nhung thuc te production:
  - Khong ai do vao auth service 24/s LIEN TUC trong 50s
  - Burst chi keo dai 15s, truoc do la 1-6/s, sau do la 5->0/s
  - Test 24/s flat la OVER-PROVISIONING -- yeu cau nhieu VU hon muc can thiet
  - Dinh VU o 24/s flat (can nhieu worker) khac voi dinh VU o 24/s burst
    (chi can nhieu worker trong 15s, sau do giai phong)
```

**ramping-arrival-rate giai quyet dung van de nay**:

```text
ramping-arrival-rate: startRate=1, stages:
  15s->6:   VU demand = ceil(6 × 0.023) = 1 VU
  15s->24:  VU demand = ceil(24 × 0.023) = 1 VU (event chi 23ms!)
  15s->5:   VU demand = ceil(5 × 0.023) = 1 VU
  5s->0:    VU demand = ceil(0 × 0.023) = 0 VU

  -> VU pool chi can preAllocatedVUs=16 la du thua cho toan bo curve
  -> Neu dung constant-arrival-rate 24/s flat trong 50s:
     cung chi can ceil(24 × 0.023) = 1 VU
  -> Nhung constant-arrival-rate khong test duoc RECOVERY curve
     (backend co bi giat khi traffic giam dot ngot tu 24->5/s khong?)
```

### Auth traffic la ingress curve, khong phai fixed user count

| Dac tinh | Auth burst | Constant-VUs approach | Ramping-arrival-rate approach |
| --- | --- | --- | --- |
| Nguon traffic | Notification push -> app open | Gia lap: VU loop lien tuc | Mo phong: arrival curve dung nhu thuc te |
| Hinh dang traffic | Curve: thap -> cao -> thap | Flat (VU count co dinh) | Curve: 1->6->24->5->0/s |
| Phu thuoc backend | KHONG -- user den doc lap | CO -- throughput = VUs/latency | KHONG -- arrival schedule doc lap |
| Drop khi thieu capacity | Nguoi dung thay spinner | Khong drop, throughput tu giam | dropped_iterations tang |
| Test duoc recovery? | Can xem hanh vi sau burst | Khong co khai niem recovery | Co drain stage 5->0/s |
| PreAllocatedVUs y nghia | So worker san sang | So VU co dinh toan bo test | So worker duoc khoi tao truoc, co the mo rong den maxVUs |

### Loi ich cu the cua ramping-arrival-rate cho case nay

```text
1. Mo phong dung hanh vi nguoi dung:
   - Khong phai 50 user login lien tuc
   - Ma la 500+ nguoi login theo curve (507 iteration ~ 507 lan login khac nhau)

2. Phat hien chinh xac stage gay van de:
   - Neu drop xay ra: no xay ra o stage NAO?
   - Pre-burst? Burst peak? Recovery?
   - Chi dinh huong duoc VU can thiet theo TUNG stage

3. Test duoc hanh vi recovery:
   - Backend co "met" sau burst khong?
   - Recovery 24->5/s co tao ra bat thuong khong?
   - Drain 5->0/s co giai phong resource dung cach khong?

4. VU pool linh hoat:
   - preAllocatedVUs=16: worker khoi tao truoc, san sang nhan burst
   - maxVUs=50: ceiling an toan, nhung khong can dung den o default
   - Neu event cham hon du kien (vd DB lock) -> co the mo rong VU pool
```

---

## 4. Config mapping

### Bang env var day du

| Tham so | Default | Y nghia | Vi sao chon gia tri nay? |
| --- | ---: | --- | --- |
| `RAR_02_START_RATE` | 1 | Arrival rate ban dau (arrivals/s) | Mo phong vai nguoi mo app dau tien ngay khi notification gui di. |
| `RAR_02_PRE_RATE` | 6 | Pre-burst peak rate | 6/s la nhịp tang truoc khi burst that su. Tuong duong 360 users/phut cham vao auth. |
| `RAR_02_BURST_RATE` | 24 | Burst peak rate | 24/s la dinh diem: 1440 users/phut. Day la con so business yeu cau auth phai chiu duoc. |
| `RAR_02_RECOVERY_RATE` | 5 | Recovery rate sau burst | 5/s la giai doan nguoi dung bat dau browse san pham, chi con vai nguoi login moi. |
| `RAR_02_DURATION_SCALE` | 1 | He so scale stage duration | scale=1 -> 15s moi stage. scale=2 -> 30s moi stage (burst lau hon). Dung de stress test burst keo dai. |
| `RAR_02_PREALLOCATED_VUS` | 16 | Worker khoi tao san sang | 16 VU du de xu ly 24/s voi event 23ms. VU du thua dam bao khong co spawn delay o burst. |
| `RAR_02_MAX_VUS` | 50 | Worker ceiling toi da | 50 VU la gioi han an toan. Neu auth cham 200ms (gap 10 lan) -> van co the mo rong de giu schedule. |
| `RAR_02_MAX_DROPPED` | 3 | Drop budget cho phep | 3/507 = 0.6% drop rate. Neu drop > 3 -> co van de that su, khong phai nhieu boundary. |
| `RAR_02_USER_POOL` | 600 | So business identity (user ao) | 600 user du cho 507 iteration (moi user dung ~0.845 lan). Moi user co userId, password, refresh token rieng. |

### Stage math: giai thich 507.5 scheduled slots

`ramping-arrival-rate` dung **linear interpolation** giua cac stage target. Cong
thuc tinh so slot trong mot stage:

```text
slots = duration × (rate_start + rate_end) / 2
```

Ap dung cho 4 stage:

| Stage | Duration | Rate start -> end | Cong thuc | Area (slots) |
| --- | ---: | --- | --- | ---: |
| 1 Pre-burst | 15s | 1 -> 6/s | 15 × (1+6)/2 | 52.5 |
| 2 Burst peak | 15s | 6 -> 24/s | 15 × (6+24)/2 | 225 |
| 3 Recovery | 15s | 24 -> 5/s | 15 × (24+5)/2 | 217.5 |
| 4 Drain | 5s | 5 -> 0/s | 5 × (5+0)/2 | 12.5 |
| **Total** | **50s** | | | **507.5** |

**Thuc te kiem chung**:

```text
Run thuc te: iterations = 507
Chenh lech: 507.5 - 507 = 0.5 slot

0.5 slot la sai so boundary micro-timing -- hoan toan binh thuong.
ramping-arrival-rate khong bao gio chinh xac tuyet doi den tung slot
vi stage transition co do tre nho trong k6 scheduler.

Ket luan: 507 iterations xac nhan stage math formula la chinh xac.
```

**Tai sao khong phai la 24 × 15 = 360 slots o burst stage?**

```text
24/s chi la RATE CUOI cua burst stage, khong phai rate xuyen suot.
Rate bat dau tu 6/s (cuoi pre-burst) va TANG DAN len 24/s.

Trung binh: (6+24)/2 = 15/s trong 15s = 225 slots.

Neu rate giu co dinh 24/s trong suot 15s:
  -> slots = 24 × 15 = 360
  -> Day la constant-arrival-rate, khong phai ramping!

Su khac biet 225 vs 360 the hien ro:
  - Ramping: tang DAN, trung binh 15/s
  - Constant: giu NGUYEN 24/s
```

### Script config mapping

Code that tu script `rar-02-login-burst-recovery.js`:

```js
const CASE_ID = 'rar-02-login-burst-recovery';
const SCALE = envInt('RAR_02_DURATION_SCALE', 1);
const START_RATE = envInt('RAR_02_START_RATE', 1);
const PRE_RATE = envInt('RAR_02_PRE_RATE', 6);
const BURST_RATE = envInt('RAR_02_BURST_RATE', 24);
const RECOVERY_RATE = envInt('RAR_02_RECOVERY_RATE', 5);
const PREALLOCATED_VUS = envInt('RAR_02_PREALLOCATED_VUS', 16);
const MAX_VUS = envInt('RAR_02_MAX_VUS', 50);
const MAX_DROPPED = envInt('RAR_02_MAX_DROPPED', 3);
const USER_POOL = envInt('RAR_02_USER_POOL', 600);

export const options = {
  scenarios: {
    login_burst_recovery: buildRampingArrivalScenario('loginBurstRecovery', START_RATE, [
      { target: PRE_RATE, duration: scaleSeconds(15, SCALE) },
      { target: BURST_RATE, duration: scaleSeconds(15, SCALE) },
      { target: RECOVERY_RATE, duration: scaleSeconds(15, SCALE) },
      { target: 0, duration: scaleSeconds(5, SCALE) },
    ], '1s', PREALLOCATED_VUS, MAX_VUS, {
      case_id: CASE_ID,
      business_case: 'login_burst_after_notification',
    }),
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    dropped_iterations: [`count<=${MAX_DROPPED}`],
    ramping_arrival_events_failed: ['count<10'],
  },
};
```

Diem can luu y ve `buildRampingArrivalScenario`:

```text
- Executor tu dong set la 'ramping-arrival-rate'
- timeUnit='1s' nghia la rate tinh theo arrivals/s
- preAllocatedVUs=16: worker san sang, tranh spawn delay khi burst bat dau
- maxVUs=50: ceiling cao, nhung default run chi can 1 active VU
- extraTags: case_id va business_case de dinh danh tren dashboard
```

---

## 5. Identity model deep-dive

### VU la anonymous worker, KHONG phai user

Day la hieu lam co ban nhat ve open-model executors. Trong `ramping-arrival-rate`:

```text
VU (Virtual User) = MOT worker thread, chi la "nhan vien xu ly".
VU KHONG co identity co dinh. VU KHONG dai dien cho mot nguoi dung cu the.

Mot VU co the xu ly event cho:
  - rar-user-1 (iteration 1)
  - rar-user-601 (iteration 601, vi userPool=600)
  - rar-user-42 (iteration 42)
  - ... bat ky user nao, tuy thuoc vao slot duoc gan
```

So do vong doi VU:

```text
Vu #3 (trong so 16 preAllocated VUs):

t=0.000s: Khoi tao, vao pool, trang thai IDLE
t=0.000s: Slot #0  duoc schedule -> scheduler gan VU #3 -> VU #3 chay
          Event: POST /auth/login voi userId=rar-user-1
t=0.023s: Event #0 xong -> VU #3 quay lai pool, IDLE
t=0.050s: Slot #1  duoc schedule -> scheduler gan VU #3 -> VU #3 chay
          Event: GET /auth/me voi userId=rar-user-2
t=0.073s: Event #1 xong -> VU #3 quay lai pool
t=0.100s: Slot #2  duoc schedule -> scheduler gan VU #3 -> VU #3 chay
          Event: POST /auth/refresh voi userId=rar-user-3
t=0.123s: Event #2 xong -> VU #3 quay lai pool
...
t=49.950s: Slot #507 duoc schedule -> scheduler gan VU #3 -> chay event cuoi
t=49.973s: Event #507 xong -> VU #3 quay lai pool
t=50.000s: Test ket thuc -> VU #3 bi huy

Tong: VU #3 da xu ly ~507/16 ≈ 32 events cho 32 user khac nhau.
```

### userId = rar-user-N, duoc tao tu iter%userPool

Code path tu `common.js`:

```js
export function userContext(seed = 'ramping-arrival', userPool = 1000) {
  const iteration = exec.scenario.iterationInTest;  // slot index TOAN CUC
  const pool = Math.max(1, userPool);
  const userNumber = (iteration % pool) + 1;        // user luan phien theo slot
  return {
    seed,
    vuId: exec.vu.idInTest,                         // CHI la worker id
    iter: iteration,
    scenarioIter: exec.scenario.iterationInInstance,
    userId: `rar-user-${userNumber}`,               // business user tu slot
    requestKey: `${seed}-${iteration}-${exec.vu.idInTest}`,
    abVariant: iteration % 2 === 0 ? 'b' : 'a',
  };
}
```

**Phan tich**:

```text
userNumber = (iteration % 600) + 1

iteration 0   -> userNumber = 1   -> userId = rar-user-1
iteration 1   -> userNumber = 2   -> userId = rar-user-2
...
iteration 599 -> userNumber = 600 -> userId = rar-user-600
iteration 600 -> userNumber = 1   -> userId = rar-user-1 (lap lai)
iteration 601 -> userNumber = 2   -> userId = rar-user-2 (lap lai)

Voi 507 iteration:
  - Moi user trong pool 600 duoc dung TOI DA 1 lan
  - 93 user (600-507=93) khong bao gio duoc dung
  - Day la y do: tranh tinh huong cung mot user login 2 lan
    trong cung test (session da ton tai -> bo qua login -> sai flow)
```

### Auth token gan voi userId, KHONG gan voi VU

```text
Trong script, moi request deu gan voi mot userId cu the:

- Login:    POST { username: "rar-user-42", password: "pass-rar-user-42" }
- /me:      GET  + Authorization: Bearer rar-user-42
- Refresh:  POST { refresh_token: "refresh-rar-user-42" }

Moi request gui X-User-ID header = rar-user-42 de backend dinh danh.

Auth state (token, session) gan voi userId, KHONG gan voi VU.
VU #3 co the xu ly login cho rar-user-1, sau do xu ly /me cho rar-user-7,
sau do xu ly refresh cho rar-user-3.
```

### He qua quan trong cua identity model

```text
1. preAllocatedVUs=16 KHONG co nghia "16 user login cung luc"
   -> La 16 worker san sang xu ly 507 user khac nhau

2. userPool=600 > iterations=507
   -> Moi user dung toi da 1 lan, khong co reusable session
   -> Moi login la "first time" login, giong nhu notification lan dau

3. userId doc lap voi vuId
   -> Khong the debug bang cach "VU #3 luon la user-5"
   -> Phai doc roi theo userId o request-level metrics

4. abVariant = iteration % 2
   -> 50% iteration dung variant 'a', 50% dung 'b'
   -> Dung de A/B test header nhung khong anh huong auth flow
```

---

## 6. Open model deep-dive

### Co che: rate curve -> VU demand

Trong open model, VU khong tu quyet dinh "khi nao chay". Scheduler moi la nguoi
quyet dinh:

```text
Schedule (ramping-arrival-rate):
  1. Tinh toan arrival slot theo curve rate(t)
  2. Khi den gio cua slot N -> tim VU idle trong pool
  3. Neu co VU idle -> gan slot cho VU do -> VU chay event
  4. Neu KHONG co VU idle:
     a. Neu so VU hien tai < maxVUs -> spawn them VU moi (co spawn delay)
     b. Neu so VU hien tai = maxVUs -> slot bi DROP (= dropped_iterations++)
  5. VU chay event xong -> quay lai pool -> san sang cho slot tiep theo
```

### Rate curve va VU demand theo tung stage

Cong thuc Little's Law cho moi stage:

```text
VU_can = ceil(rate_tai_thoi_diem × W_eff)

Trong do:
  rate = arrival rate tai thoi diem do (thay doi theo stage)
  W_eff = thoi gian trung binh moi event (event duration)
```

**Ap dung cho rar-02 default (event p95=23ms, dung p95 de conservative)**:

| Stage | Rate range | Rate trung binh | W_eff | VU can | VU co san (pre=16) | Du thua |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 Pre-burst | 1 -> 6/s | 3.5/s | 0.023s | ceil(6×0.023)=1 | 16 | 15 VU |
| 2 Burst peak | 6 -> 24/s | 15/s | 0.023s | ceil(24×0.023)=1 | 16 | 15 VU |
| 3 Recovery | 24 -> 5/s | 14.5/s | 0.023s | ceil(24×0.023)=1 | 16 | 15 VU |
| 4 Drain | 5 -> 0/s | 2.5/s | 0.023s | ceil(5×0.023)=1 | 16 | 15 VU |

**Nhan xet quan trong**:

```text
Auth login event chi ton 23ms (p95) -> mot VU co the xu ly ~43 events/s.
Ngay ca o dinh burst 24/s, 1 VU la du de giu toan bo arrival schedule.

Vay tai sao preAllocatedVUs=16, khong phai 1?

Ly do:
1. Headroom cho spawn delay: VU moi can thoi gian khoi tao (hang tram ms)
   -> 16 VU san sang dam bao khong co delay khi burst bat dau
2. Margin an toan cho tail latency: p95=23ms nhung p99=24ms, max=101ms
   -> Mot event bi cham 101ms co the block 1 VU trong 101ms
   -> 16 VUs dam bao 15 VU khac van xu ly binh thuong
3. Chuan bi cho worse-case scenario:
   - Neu backend cham gap 10 (230ms/event): ceil(24×0.230) = 6 VU can
   - Neu backend cham gap 50 (1.15s/event): ceil(24×1.15) = 28 VU can
   - maxVUs=50 van du bao phu
```

### Tai sao /me voi memory_kb=4 nang hon login

```text
login:    POST /api/sim/auth/login?cpu_ms=2&db_rows=1
          - CPU: 2ms (rat nhe)
          - DB: 1 row read (don gian)
          - Workload: CPU + DB read

/me:      GET /api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4
          - CPU: 1ms (nhe hon login)
          - DB: 1 row read (giong login)
          - Memory: 4KB allocation
          - Workload: CPU + DB read + MEMORY ALLOCATION

Memory allocation (4KB) la operation dat do bat ngo:
  - Can OS system call (malloc/mmap)
  - Co the trigger garbage collection
  - Memory fragmentation co the gay cham dot ngot
  - Khong duoc do bang cpu_ms hoac db_rows thong thuong

Day la ly do /me branch co the cham hon login branch trong mot so run,
mac du cpu_ms thap hon.
```

### VU demand o peak stage: so sanh login vs /me vs refresh

| Branch | Weight | Endpoint | Cost model | Relative weight |
| --- | ---: | --- | --- | ---: |
| Login | 60% | POST .../login | cpu_ms=2, db_rows=1 | Light |
| Me | 25% | GET .../me | cpu_ms=1, db_rows=1, memory_kb=4 | Medium (memory) |
| Refresh | 15% | POST .../refresh | cpu_ms=1, db_writes=1 | Light (write) |

Muc do anh huong den VU demand:

```text
Login (60% cua 24/s = 14.4 events/s):
  - 14.4 × 0.023s = 0.33 VU can

Me (25% cua 24/s = 6 events/s):
  - 6 × 0.023s = 0.14 VU can

Refresh (15% cua 24/s = 3.6 events/s):
  - 3.6 × 0.023s = 0.08 VU can

Tong VU can o burst peak (conservative): 0.33 + 0.14 + 0.08 = 0.55 VU
Lam tron len: ceil(24 × 0.023) = 1 VU (dung cong thuc Little's Law don gian)

=> 1 VU xu ly du toan bo 3 nhanh o peak 24/s.
=> preAllocatedVUs=16 la CUC KY AN TOAN.
```

### So sanh: neu dung constant-arrival-rate o peak 24/s

```text
constant-arrival-rate: rate=24/s, timeUnit=1s, duration=50s
  -> 24 × 50 = 1200 scheduled slots (gap 2.36 lan so voi 507.5)
  -> VU can = ceil(24 × 0.023) = 1 VU (van chi can 1 VU)
  -> Nhung test 1200 slots la KHONG DUNG voi thuc te
  -> Thuc te chi co 507.5 arrivals trong 50s curve

constant-arrival-rate khong mo phong duoc:
  - Giai doan pre-burst (1->6/s): backend cold start
  - Giai doan recovery (24->5/s): backend co bi "met" sau burst?
  - Giai doan drain (5->0/s): giai phong resource

=> constant-arrival-rate la OVER-TESTING ve so luong slot
   va UNDER-TESTING ve hanh vi curve.
```

---

## 7. Service/API flow

### 3 nhanh auth voi weightedPick

Auth burst co 3 operation, phan bo theo weight:

```js
const choice = weightedPick([
  { name: 'login', weight: 60 },
  { name: 'me', weight: 25 },
  { name: 'refresh', weight: 15 },
], ctx.iter);
```

**Co che weightedPick** (tu `common.js`):

```js
export function weightedPick(items, n) {
  const total = items.reduce((sum, item) => sum + item.weight, 0); // 60+25+15=100
  const pick = n % total;  // pick trong [0, 99] theo iteration index
  let cursor = 0;
  for (const item of items) {
    cursor += item.weight;
    if (pick < cursor) return item.name;
  }
  return items[items.length - 1].name;
}
```

**Phan phoi voi 507 iteration thuc te**:

| Branch | Weight | Expected count | Actual count | Distribution |
| --- | ---: | ---: | ---: | --- |
| Login | 60% | 304.2 | 307 | 60.6% |
| Me | 25% | 126.75 | 125 | 24.7% |
| Refresh | 15% | 76.05 | 75 | 14.8% |
| **Total** | **100%** | **507** | **507** | **100%** |

### Chi tiet tung nhanh

**Branch 1: Login (60%)**

```js
result = requestJson('POST', `${BASE_URL}/api/sim/auth/login?cpu_ms=2&db_rows=1`, {
  username: ctx.userId,
  password: `pass-${ctx.userId}`,
}, {
  caseId: CASE_ID,
  service: 'auth-service',
  operation: 'login_burst_login',
  endpoint: 'POST /api/sim/auth/login',
  userId: ctx.userId,
});
```

Dac tinh:

```text
- Method: POST
- Endpoint: /api/sim/auth/login
- Backend cost: cpu_ms=2, db_rows=1
- Payload: { username: "rar-user-42", password: "pass-rar-user-42" }
- Tags: service=auth-service, operation=login_burst_login
- Expected status: 200
- Day la WRITE-ISH path (db read + CPU validation)
```

**Branch 2: Me (25%)**

```js
result = requestJson('GET', `${BASE_URL}/api/sim/auth/me?cpu_ms=1&db_rows=1&memory_kb=4`, null, {
  caseId: CASE_ID,
  service: 'auth-service',
  operation: 'login_burst_me',
  endpoint: 'GET /api/sim/auth/me',
  userId: ctx.userId,
  headers: { Authorization: `Bearer ${ctx.userId}` },
});
```

Dac tinh:

```text
- Method: GET
- Endpoint: /api/sim/auth/me
- Backend cost: cpu_ms=1, db_rows=1, memory_kb=4
- Payload: null (query params chua backend cost)
- Headers: Authorization: Bearer rar-user-42
- Tags: service=auth-service, operation=login_burst_me
- Expected status: 200
- Day la READ path + memory allocation (4KB)
- Authorization header la bat buoc -- backend validate token
```

**Branch 3: Refresh (15%)**

```js
result = requestJson('POST', `${BASE_URL}/api/sim/auth/refresh?cpu_ms=1&db_writes=1`, {
  refresh_token: `refresh-${ctx.userId}`,
}, {
  caseId: CASE_ID,
  service: 'auth-service',
  operation: 'login_burst_refresh',
  endpoint: 'POST /api/sim/auth/refresh',
  userId: ctx.userId,
});
```

Dac tinh:

```text
- Method: POST
- Endpoint: /api/sim/auth/refresh
- Backend cost: cpu_ms=1, db_writes=1
- Payload: { refresh_token: "refresh-rar-user-42" }
- Tags: service=auth-service, operation=login_burst_refresh
- Expected status: 200
- Day la WRITE path (db write)
- DB write trong burst co the la bottleneck neu DB lock contention
```

### Common request headers

Moi request deu duoc gui kem cac header chuan tu `common.js`:

```js
const params = {
  headers: {
    'Content-Type': 'application/json',
    'X-Test-Suite': 'ramping-arrival-rate',
    'X-Load-Profile': 'ramping-arrival-rate-practice',
    ...(tags.userId ? { 'X-User-ID': tags.userId } : {}),
    ...(tags.headers || {}),
  },
  tags: { ... },
};
```

Bang header day du:

| Header | Gia tri | Muc dich |
| --- | --- | --- |
| `Content-Type` | `application/json` | Dinh dang payload |
| `X-Test-Suite` | `ramping-arrival-rate` | Dinh danh test suite tren backend |
| `X-Load-Profile` | `ramping-arrival-rate-practice` | Dinh danh load profile |
| `X-User-ID` | `rar-user-N` (vd: rar-user-42) | Dinh danh business user |
| `Authorization` | `Bearer rar-user-N` | Chi branch /me |

### finishEvent: ghi nhan event-level metrics

Sau khi branch hoan thanh, `finishEvent` duoc goi de ghi nhan:

```js
finishEvent(started, result.ok, {
  caseId: CASE_ID,
  service: 'auth-service',
  operation: `login_burst_${choice}`,
  userId: ctx.userId,
});
```

Co che tu `common.js`:

```js
export function finishEvent(startedAt, ok, tags = {}) {
  const metricTags = {
    case_id: tags.caseId,
    service: tags.service,
    operation: tags.operation,
    user_id: tags.userId,
  };
  rampingArrivalEventsTotal.add(1, metricTags);       // Counter: so event
  rampingArrivalEventDurationMs.add(                   // Trend: thoi gian event
    Date.now() - startedAt, metricTags
  );
  if (!ok) {
    rampingArrivalEventsFailed.add(1, metricTags);     // Counter: event fail
  }
}
```

Dieu nay co nghia:

```text
- Moi iteration (507) -> goi finishEvent 1 lan
- Event duration = thoi gian tu luc vao export function den luc finishEvent
- Event duration BAO GOM: JS xu ly + HTTP goi + check + finishEvent
- Event failed CHI KHI check status that bai (khong bao gom HTTP timeout/error
  vi requestJson da co check status rieng)
```

---

## 8. Metrics & tags

### Custom metrics (tu common.js)

| Metric | Loai | Mo ta | Tag quan trong |
| --- | --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Tong so event (iteration) da hoan thanh | case_id, service, operation, user_id |
| `ramping_arrival_events_failed` | Counter | Tong so event that bai (check fail) | case_id, service, operation, user_id |
| `ramping_arrival_api_calls_total` | Counter | Tong so HTTP call da goi | case_id, service, operation, endpoint, user_id |
| `ramping_arrival_event_duration_ms` | Trend | Thoi gian hoan thanh moi event (ms) | case_id, service, operation, user_id |

### k6 built-in metrics

| Metric | Loai | Y nghia trong rar-02 |
| --- | --- | --- |
| `iterations` | Counter | Tong so iteration da hoan thanh. Phai ~= 507.5 |
| `dropped_iterations` | Counter | Iteration bi drop do thieu VU. Phai <= 3 |
| `http_reqs` | Counter | Tong so HTTP request. Phai = iterations (1 call/event) |
| `http_req_failed` | Rate | Ti le HTTP request that bai (status >= 400 hoac error). Phai < 1% |
| `http_req_duration` | Trend | Thoi gian HTTP response (ms) |
| `vus` | Gauge | So VU active tai thoi diem sample |
| `vus_max` | Gauge | So VU toi da duoc cap phat |
| `checks` | Rate | Ti le check pass. Phai > 99% |

### Tags tren moi request

| Tag | Gia tri trong rar-02 | Muc dich |
| --- | --- | --- |
| `case_id` | `rar-02-login-burst-recovery` | Loc theo case tren dashboard |
| `service` | `auth-service` | Loc theo service |
| `operation` | `login_burst_login` / `login_burst_me` / `login_burst_refresh` | Loc theo operation |
| `endpoint` | `POST /api/sim/auth/login` / ... | Loc theo endpoint cu the |
| `user_id` | `rar-user-N` | Loc theo user identity |
| `name` | `tags.operation` (default) | Ten hien thi tren dashboard (url + name) |
| `executor_family` | `ramping_arrival_rate` | Loc theo ho executor (scenario-level tag) |
| `workload_shape` | `ramping_ingress_rate` | Loc theo hinh dang workload (scenario-level tag) |
| `business_case` | `login_burst_after_notification` | Loc theo business scenario |

### Cach doc metrics tren dashboard

```text
1. ramping_arrival_events_total:
   - Tong bang iterations (507)
   - Neu KHAC iterations -> co event khong goi finishEvent (bug script)

2. ramping_arrival_api_calls_total:
   - Tong bang http_reqs (507)
   - Trong rar-02, moi event = 1 API call -> bang iterations

3. ramping_arrival_events_failed:
   - Tong bang checks_fails
   - Loc theo operation de biet branch nao bi fail

4. ramping_arrival_event_duration_ms:
   - So sanh voi http_req_duration:
     event_duration ≈ http_duration + JS overhead (~1-2ms)
   - Trong run thuc te: event avg=6.18ms, http avg=6.07ms -> JS overhead ~0.11ms

5. dropped_iterations:
   - La PRIMARY signal cho open-model contract breach
   - Khong co tag -- la counter cua scenario
   - Phai doc cung voi vus_max de hieu VU pressure
```

---

## 9. Pass criteria

### Thresholds (tu script)

```js
thresholds: {
  checks: ['rate>0.99'],                              // (a) >99% check pass
  http_req_failed: ['rate<0.01'],                     // (b) <1% HTTP fail
  dropped_iterations: [`count<=${MAX_DROPPED}`],      // (c) drop <= 3
  ramping_arrival_events_failed: ['count<10'],        // (d) <10 event fail
},
```

### Giai thich tung threshold

**(a) checks rate > 0.99**

```text
Y nghia: It nhat 99% cac check phai pass.
Check la: `${tags.operation} status 200` -- tuc la HTTP status phai la 200.

Neu checks < 0.99:
  - Auth endpoint tra ve 4xx (bad request) hoac 5xx (server error)
  - Kiem tra backend logs
  - Kiem tra user pool (userId co hop le?)
  - Kiem tra payload format (username/password/refresh_token dung dinh dang?)
```

**(b) http_req_failed rate < 0.01**

```text
Y nghia: It hon 1% HTTP request bi fail (status >= 400 hoac network error).

Neu http_req_failed >= 0.01:
  - Auth service dang tra ve loi
  - Co the do DB connection pool can
  - Co the do rate limiter kick in
  - Co the do request timeout
```

**(c) dropped_iterations count <= 3**

```text
Y nghia: Toi da 3 arrival slot bi mat (khong co VU xu ly).

Neu dropped_iterations > 3:
  - VU pool khong du capacity cho arrival curve
  - Thu tang RAR_02_PREALLOCATED_VUS hoac RAR_02_MAX_VUS
  - Kiem tra event duration co bat thuong (p95/p99 cao?)
  - Xem drop xay ra o stage nao (pre-burst? burst? recovery?)

Day la THRESHOLD QUAN TRONG NHAT cho open-model test.
Dung la "primary signal" ma khong executor nao khac co.
```

**(d) ramping_arrival_events_failed count < 10**

```text
Y nghia: It hon 10 event bi danh dau failed (check that bai).

Neu ramping_arrival_events_failed >= 10:
  - Co nhieu hon 10 event ma check status khong pass
  - Co the la mot branch cu the bi fail (vd: refresh token loi)
  - Kiem tra operation-level metrics de xac dinh branch nao
```

### Default local validation result

```text
Run thuc te (local cloud):
  iterations = 507
  http_reqs = 507
  checks = 100% (507/507 passes)
  http_req_failed = 0%
  dropped_iterations = 0
  ramping_arrival_events_failed = 0
  event p95 = 23 ms
  http p95 = 23.25 ms

=> PASS — Tat ca 4 threshold deu pass.
```

---

## 10. Cach chay + output 5 buoc

### Buoc 1: Kiem tra preflight

```powershell
# Kiem tra k6 version
k6 version
# Expected: k6.exe v2.0.0+

# Kiem tra load-target health
curl http://localhost:80/health
# Expected: HTTP 200

# Kiem tra metrics server (neu dung cloud local)
curl http://localhost:18080/v1/capabilities
# Expected: HTTP 200 + JSON capabilities list
```

### Buoc 2: Static inspect

```powershell
k6 inspect "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Expected output chinh:

```text
executor: ramping-arrival-rate
stages: [
  { target: 6, duration: 15s },
  { target: 24, duration: 15s },
  { target: 5, duration: 15s },
  { target: 0, duration: 5s }
]
executor_family: ramping_arrival_rate
workload_shape: ramping_ingress_rate
```

### Buoc 3: Chay default (local khong cloud)

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Output mong doi:

```text
iterations: 507
http_reqs: 507
checks: 100%
http_req_failed: 0%
dropped_iterations: 0
vus_max: 1 (hoac 16, tuy vao sample timing)
```

### Buoc 4: Chay voi cloud local (day du metrics + dashboard)

```powershell
cd "E:\Khoa hoc\k6"
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
.\run-with-summary.ps1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Output mong doi:

```text
Run ID: #101 (hoac so run tiep theo)
Script: rar-02-login-burst-recovery.js
Exit code: 0
summary_pushed: true
finish_status: 200

Summary:
  iterations: 507
  dropped_iterations: 0
  checks_rate: 1
  http_req_failed_rate: 0
  vus_max: 16
  event p95: ~23ms
  http p95: ~23ms
```

### Buoc 5: Doc dashboard + phan tich

Sau khi chay voi cloud, mo dashboard de kiem tra:

```text
1. Mo dashboard (Grafana hoac metrics server UI)
2. Loc case_id = rar-02-login-burst-recovery
3. Kiem tra 3 chart chinh (xem Section 11)
4. Doi chieu summary voi dashboard series
5. Ghi nhan: PASS / FAIL / CANH BAO
```

### Cac bien moi truong co the tune

```powershell
# Thay doi peak burst
$env:RAR_02_BURST_RATE = "36"

# Keo dai burst stage
$env:RAR_02_DURATION_SCALE = "2"

# Giam VU pool (de test drop)
$env:RAR_02_PREALLOCATED_VUS = "4"
$env:RAR_02_MAX_VUS = "8"

# Tang drop budget
$env:RAR_02_MAX_DROPPED = "10"

# Giam user pool
$env:RAR_02_USER_POOL = "100"
```

---

## 11. Dashboard 3-chart reading guide

### Chart 1: Response time (theo operation)

Chart nay hien thi `http_req_duration` hoac `ramping_arrival_event_duration_ms`,
phan loai theo `operation` tag.

**Cach doc**:

```text
3 duong (neu ve rieng theo operation):
  - login_burst_login: POST, write-ish, db_rows=1, cpu_ms=2
  - login_burst_me: GET, Authorization header, memory_kb=4
  - login_burst_refresh: POST, write, db_writes=1

Can phan biet:
  - login vs refresh: ca 2 deu la POST, nhung login doc DB con refresh ghi DB
    Refresh CO THE cham hon login trong mot so run do write lock
  - /me: GET nhung co memory_kb=4 -> co the co tail latency do GC

Diem can luu y:
  - p95/p99 cua moi branch rieng biet
  - Neu /me p95 >> login p95 -> memory allocation la bottleneck
  - Neu refresh p95 >> login p95 -> DB write la bottleneck
  - Neu ca 3 deu cham -> auth DB chung la bottleneck
```

**Du lieu that tu run**:

```text
Run #101:
  login_burst_login:  POST 200 count=307, avg~6ms
  login_burst_me:     GET  200 count=125, avg~6ms
  login_burst_refresh: POST 200 count=75,  avg~6ms

Ca 3 branch khong co su khac biet dang ke o default run
vi backend rat nhe (2ms CPU, 1 DB row).
```

### Chart 2: Execution timeline (iterations/s + dropped)

Chart nay hien thi iteration completion rate va dropped_iterations theo thoi gian.

**Cach doc**:

```text
Timeline 50 giay:

Giay 0-15 (pre-burst):
  - Iter/s tang dan: 1 -> 6/s
  - Duong cong iteration completion bam sat arrival curve
  - dropped_iterations = 0
  - VUs = 0 hoac 1 (event qua nhanh, sample interval 1s bo qua)

Giay 15-30 (burst peak):
  - Iter/s tang manh: 6 -> 24/s
  - Day la giai doan QUAN TRONG NHAT de kiem tra
  - Xem duong iter completion co flat khong (bao hoa) hay con tang
  - Neu iter completion flat trong khi arrival van tang -> sap drop
  - dropped_iterations tang -> VU pool can
  - VUs co the tang neu event duration tang

Giay 30-45 (recovery):
  - Iter/s giam dan: 24 -> 5/s
  - Kiem tra dropped_iterations co giam ve 0 khong
  - VUs giai phong dan

Giay 45-50 (drain):
  - Iter/s giam ve 0
  - dropped_iterations = 0 (khong con arrival slot)
  - VUs idle, chuan bi ket thuc test
```

**Dau hieu canh bao**:

```text
1. dropped_iterations xuat hien o giay 15-17 (dau burst):
   -> VU spawn delay. Tang preAllocatedVUs.

2. dropped_iterations xuat hien o giay 20-25 (giua burst):
   -> VU pool can. Tang maxVUs hoac giam event duration.

3. Iter/s khong dat duoc 24/s o burst stage:
   -> Co the do dropped_iterations, hoac do arrival schedule bi gioi han
      (nhung ramping-arrival-rate khong tu gioi han -> kha nang la do drop)

4. Iter/s giam DOT NGOT giua burst stage:
   -> Kha nang backend crash hoac timeout hang loat
   -> Kiem tra http_req_failed rate
```

### Chart 3: VUs vs iterations/s

Chart nay cho thay moi quan he giua so VU active va iteration completion rate.

**Cach doc cho rar-02**:

```text
Run thuc te: vus_max=16, active VU max=1

Vus_max = 16 phan anh PREALLOCATED_VUS (worker da duoc khoi tao).
Active VU max = 1 co nghia TAI THOI DIEM SAMPLE, chi co 1 VU dang busy.

KHONG doc la: "chi can 1 VU".
Doc la: "1 VU active tai bat ky thoi diem sample nao".

Thuc te:
  - 16 VU da duoc khoi tao (preAllocated)
  - Tai moi thoi diem, scheduler chi can gan 1 VU cho 1 slot
    (vi event chi ton 23ms, xong rat nhanh)
  - 15 VU con lai IDLE trong pool
  - Sample interval 1s -> chi chup duoc 1 VU dang busy

Dieu nay cho thay DAY LA DEFAULT HEALTHY:
  - preAllocatedVUs du thua nhieu
  - Khong co spawn delay
  - Pool luon san sang cho bat ky burst nao
```

**So sanh voi case khac (rar-05)**:

```text
rar-05: pre=25, max=80, active VU max=45, vus_max=45

Active VU max=45 >> preAllocatedVUs=25 -> pool da mo rong.
Vus_max=45 < maxVUs=80 -> van con room de mo rong nhung...
dropped_iterations=20 -> mac du con room, scheduler khong kip spawn VU
do event duration qua dai (9.01s p95).
```

**Diem can luu y ve VU chart**:

```text
1. vus_max trong summary KHONG PHAI LA maxVUs config.
   Trong rar-02: vus_max=16 = preAllocatedVUs (pool da cap phat).
   Trong rar-05: vus_max=45 = so VU thuc te da dung.

2. active VU chart co do phan giai 1s.
   Event 23ms -> VU busy 23ms, idle 977ms -> sample de bo qua.
   Ket qua: active VU samples = 0 hoac 1.
   KHONG doc la "khong co VU nao chay".

3. VU pressure chi hien ro khi event duration > sample interval.
   Neu event > 1s -> VU active sample se capture duoc.
   Neu event < 1s -> VU co the "an" giua cac sample.
```

---

## 12. 4 output -> decision scenarios

### Scenario 1: PASS hoan hao (default healthy)

**Output**:

```text
iterations = 507
dropped_iterations = 0
checks_rate = 1.0
http_req_failed_rate = 0
ramping_arrival_events_failed = 0
event p95 = 23ms
http p95 = 23.25ms
vus_max = 16
active VU max = 1 (hoac 0)
```

**Ket luan**: Auth burst contract pass o default config.

**Decision**: Production-ready cho burst 1->6->24->5->0/s. Khong can thay doi gi.

**Luu y**: Day la ket qua DEFAULT. Neu production co burst cao hon (vi du 48/s),
can rerun voi `RAR_02_BURST_RATE=48`.

---

### Scenario 2: dropped_iterations o burst stage (VU pressure)

**Output**:

```text
iterations = ~480 (thap hon 507)
dropped_iterations = 27 (>3 threshold)
checks_rate = 1.0
http_req_failed_rate = 0
event p95 = 80ms (cao hon default)
active VU max = 50 (bang maxVUs)
vus_max = 50
```

**Phan tich**:

```text
27 slot bi drop, tap trung o burst stage (giay 15-30).
Event p95 = 80ms (gap 3.5 lan default 23ms).
VU pool da dat ceiling (maxVUs=50).

Root cause: Event cham hon du kien (80ms vs 23ms).
VU demand o peak: ceil(24 × 0.080) = ceil(1.92) = 2 VU.
Nhung VU pool da can (50/50), scheduler khong spawn them duoc.

Ly do event cham hon:
  - Co the auth DB bi lock
  - Co the backend CPU bi gioi han
  - Co the memory_kb=4 gay GC pause
```

**Decision options**:

```text
Option A: Tang maxVUs.
  $env:RAR_02_MAX_VUS = "100"
  -> Cho phep mo rong pool gap doi
  -> Nhung neu event cham do backend CPU can -> khong giai quyet duoc goc

Option B: Giam burst rate.
  $env:RAR_02_BURST_RATE = "16"
  -> Giam ap luc, VU demand: ceil(16 × 0.080) = 2 VU (van du)
  -> Nhung business yeu cau 24/s, khong the giam

Option C: Dieu tra backend.
  -> Tai sao event p95 = 80ms thay vi 23ms?
  -> DB cham? CPU cham? Memory allocation?
  -> Fix backend TRUOC, roi rerun test

Option D: Chap nhan drop + dieu chinh threshold.
  $env:RAR_02_MAX_DROPPED = "30"
  -> Neu business OK voi ~5% drop rate
  -> Nhung day la "chua chay, khong phai chua benh"
```

**Khuyen nghi**: Option C (fix backend) truoc, sau do Option A (tang VU) neu van drop.

---

### Scenario 3: login fail/status mismatch

**Output**:

```text
checks_rate = 0.85 (< 0.99 threshold -> FAIL)
http_req_failed_rate = 0.15
ramping_arrival_events_failed = 76

Breakdown:
  login_burst_login: 307 requests, 60 fails (status 401/500)
  login_burst_me: 125 requests, 10 fails (status 401)
  login_burst_refresh: 75 requests, 6 fails (status 401)
```

**Phan tich**:

```text
Login branch co nhieu fail nhat (60/307 = 19.5%).
Status 401 = Unauthorized -> sai username/password.
Status 500 = Internal Server Error -> backend crash.

Co the:
  - User pool bi corruption? (username hoac password sai)
  - Backend auth DB khong co user data?
  - Backend khong handle duoc write load o burst?
```

**Decision**:

```text
1. Kiem tra backend auth DB health
2. Verify user data: username=rar-user-N, password=pass-rar-user-N
3. Kiem tra backend logs o thoi diem burst (giay 15-30)
4. Giam burst rate de isolate: RAR_02_BURST_RATE=6
   -> Neu con fail -> van de la backend, khong phai load
   -> Neu het fail -> van de la load capacity
```

---

### Scenario 4: Burst-stage VU pressure (spawn delay)

**Output**:

```text
dropped_iterations = 8 (>3 threshold)
Nhung dropped_iterations CHI xuat hien o giay 15-18 (dau burst).
Tu giay 18 tro di, dropped_iterations = 0.

active VU max = 24
vus_max = 50
event p95 = 23ms (binh thuong)
```

**Phan tich**:

```text
8 slot bi drop o dau burst, khong phai giua hay cuoi burst.
Event p95 binh thuong (23ms) -> backend khong cham.
VU max = 50, active VU max = 24 -> VU pool con room.

Root cause: SPAWN DELAY.
Khi burst bat dau (tu 6/s nhay len 24/s trong 15s),
scheduler can nhieu VU hon. Nhung VU spawn ton thoi gian.
preAllocatedVUs=16 da dung het, can spawn them 8 VU tu 16->24.
8 VU moi spawn mat ~100-300ms moi cai -> mot vai slot bi drop
trong thoi gian cho VU spawn.

Day la SPAWN DELAY, khong phai VU CAPACITY.
```

**Decision**:

```text
Fix: Tang preAllocatedVUs de tranh spawn delay.

$env:RAR_02_PREALLOCATED_VUS = "30"

Voi 30 preAllocatedVUs:
  - 30 VU san sang ngay tu dau
  - Khong can spawn them khi burst bat dau
  - Khong co spawn delay -> khong drop

Neu van drop sau khi tang preAllocatedVUs:
  -> spawn delay KHONG PHAI root cause
  -> Co the la VU capacity that su
  -> Tang maxVUs va kiem tra lai
```

**Tong ket 4 scenario**:

| Scenario | Drop pattern | Event p95 | VU status | Root cause | Fix |
| --- | --- | ---: | --- | --- | --- |
| 1. PASS hoan hao | 0 | 23ms | Active=1, max=16 | Khong co | Khong can |
| 2. Drop o burst | 27 (5.3%) | 80ms | Active=50, max=50 | Backend cham | Fix backend + tang maxVUs |
| 3. Login fail | 0 | 6ms | Active=1 | Backend data/status loi | Fix backend auth |
| 4. Spawn delay | 8 (dau burst) | 23ms | Active=24, max=50 | preAllocated qua thap | Tang preAllocatedVUs |

---

## 13. Nghich ly / misconceptions

### Nghich ly: "login rate cao hon constant-arrival-rate auth nhung can it VU hon"

Day la mot nghich ly thuong gap khi so sanh `ramping-arrival-rate` va
`constant-arrival-rate`.

```text
constant-arrival-rate auth case (car-02?):
  rate = 6/s, timeUnit=1s, event p95 ~ ?ms
  VU can: ceil(6 × W_eff)

ramping-arrival-rate auth case (rar-02):
  peak rate = 24/s (gap 4 lan!)
  VU can o peak: ceil(24 × 0.023) = 1 VU

Tai sao 24/s chi can 1 VU nhung 6/s lai can nhieu VU hon?
```

**Giai thich**:

```text
Cau tra loi nam o EVENT DURATION, khong phai arrival rate.

rar-02 (ramping):
  - Event chi la 1 HTTP call don gian: login hoac /me hoac refresh
  - Backend cost: cpu_ms=2, db_rows=1 (rat nhe)
  - Event p95 = 23ms
  - VU can = ceil(rate × event_duration) = ceil(24 × 0.023) = 1 VU

constant-arrival-rate case (neu co event dai hon):
  - Event CO THE gom nhieu HTTP call
  - Backend cost cao hon (external API call, async wait)
  - Event p95 co the > 100ms
  - VU can = ceil(6 × 0.5) = 3 VU (vi du)

Cong thuc Little's Law:
  VU_can = ceil(arrival_rate × event_duration)

Ramping-arrival-rate VOI event ngan (23ms):
  24/s × 0.023s = 0.55 -> 1 VU

Constant-arrival-rate VOI event dai (500ms):
  6/s × 0.5s = 3 -> 3 VU

=> KHONG PHAI executor nao "can it VU hon".
=> La EVENT DURATION quyet dinh VU demand.
```

### Misconception 1: "preAllocatedVUs = so user dang login"

**SAI**. preAllocatedVUs chi la so worker thread duoc khoi tao truoc. 16 VU khong
co nghia la 16 user -- co the la 16 worker xu ly 507 user khac nhau.

### Misconception 2: "vus_max trong summary la maxVUs config"

**SAI**. vus_max la so VU thuc te da duoc cap phat (sample). Trong rar-02,
vus_max=16 = preAllocatedVUs, khong phai maxVUs=50. Chi khi VU pool can phai mo
rong thi vus_max moi > preAllocatedVUs.

### Misconception 3: "active VU = 0 -> khong co VU chay"

**SAI**. Active VU la sample tai thoi diem chart bucket (1s). Event ton 23ms ->
VU busy 23ms, idle 977ms -> sample de bo qua. Progress output van hien thi dung
so VU da dung.

### Misconception 4: "dropped_iterations = 0 -> backend hoan toan khoe"

**SAI**. Dropped_iterations chi bao hieu "arrival schedule duoc giu", khong bao
hieu "backend khoe". Checks van co the fail, http van co the fail, event p95 van
co the cao. dropped_iterations la CAN nhung KHONG DU.

### Misconception 5: "ramping-arrival-rate = 'nhieu constant-arrival-rate noi tiep'"

**SAI mot phan**. Dung la ramping-arrival-rate thay doi rate theo stage, nhung
no khong phai la "nhieu constant-arrival-rate noi tiep". Su khac biet:

```text
constant-arrival-rate:
  - Rate CO DINH trong suot duration
  - Stage math: slots = rate × duration (tuyen tinh)

ramping-arrival-rate:
  - Rate THAY DOI lien tuc giua cac target (linear interpolation)
  - Stage math: slots = duration × (rate_start + rate_end)/2
  - Giua 2 target, rate thay doi MOI GIAY
```

### Misconception 6: "burst rate 24/s la rate xuyen suot burst stage"

**SAI**. 24/s la RATE CUOI cua burst stage, khong phai rate xuyen suot. Rate bat
dau tu 6/s (cuoi pre-burst) va tang dan len 24/s. Trung binh burst stage la
(6+24)/2 = 15/s.

---

## 14. Checklist

Truoc khi chay rar-02, kiem tra:

```text
[ ] k6 version >= v2.0.0
[ ] Load-target health check: curl http://localhost:80/health -> 200
[ ] Metrics server (neu dung cloud): curl http://localhost:18080/v1/capabilities -> 200
[ ] Script inspect pass: k6 inspect ...\rar-02-login-burst-recovery.js
[ ] BASE_URL da set: $env:BASE_URL = "http://localhost:80"
[ ] Khong co script nao khac dang chay (tranh conflict port/resource)
```

Sau khi chay, kiem tra:

```text
[ ] iterations = 507 (±2)
[ ] dropped_iterations = 0 (hoac <= 3)
[ ] checks_rate > 0.99
[ ] http_req_failed_rate < 0.01
[ ] ramping_arrival_events_failed < 10
[ ] http_reqs = iterations (507, vi 1 call/event)
[ ] event p95 <= 30ms (default backend nhe)
[ ] http p95 <= 30ms
[ ] 3 branch counts: login ~304, me ~127, refresh ~76
[ ] Dashboard: execution timeline matches arrival curve
[ ] Dashboard: response time khong co spike dot ngot
[ ] Dashboard: VU chart khong vuot qua maxVUs
```

Truoc khi production, kiem tra them:

```text
[ ] Burst rate khop voi production forecast
[ ] User pool du lon (>= so luong nguoi dung du kien)
[ ] maxVUs du headroom (it nhat 2x VU demand)
[ ] Drop budget <= business SLO
[ ] Da test voi nhieu DURATION_SCALE (1, 2, 4)
[ ] Da test voi BURST_RATE cao hon (+50%, +100%)
[ ] Auth DB da duoc warm-up (khong cold start)
[ ] Rate limiter da duoc configure (neu co)
```

---

## 15. 4-5 variations voi code

### Variation 1: Higher burst (48/s peak)

Muc dich: Test auth service o burst gap doi.

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_02_BURST_RATE = "48"
$env:RAR_02_PREALLOCATED_VUS = "32"
$env:RAR_02_MAX_VUS = "100"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Stage math moi:

| Stage | Duration | Rate | Slots |
| --- | ---: | --- | ---: |
| Pre-burst | 15s | 1 -> 6/s | 52.5 |
| Burst peak | 15s | 6 -> 48/s | (6+48)/2 × 15 = 405 |
| Recovery | 15s | 48 -> 5/s | (48+5)/2 × 15 = 397.5 |
| Drain | 5s | 5 -> 0/s | 12.5 |
| **Total** | **50s** | | **867.5** |

VU demand o peak: ceil(48 × 0.023) = ceil(1.10) = 2 VU (neu event van 23ms).

Neu backend cham hon o 48/s (vi DB lock):
  - Neu event p50=100ms: ceil(48 × 0.100) = ceil(4.8) = 5 VU
  - preAllocatedVUs=32 van du thua

---

### Variation 2: Longer burst (duration scale x3)

Muc dich: Test auth service chiu burst keo dai (45s thay vi 15s).

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_02_DURATION_SCALE = "3"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Stage math moi:

| Stage | Duration | Rate | Slots |
| --- | ---: | --- | ---: |
| Pre-burst | 45s | 1 -> 6/s | 157.5 |
| Burst peak | 45s | 6 -> 24/s | 675 |
| Recovery | 45s | 24 -> 5/s | 652.5 |
| Drain | 15s | 5 -> 0/s | 37.5 |
| **Total** | **150s** | | **1522.5** |

Y nghia: Burst keo dai gap 3, tong arrival gap 3. Test xem backend co bi "met"
sau burst keo dai khong. Neu co memory leak hoac connection pool can -> se hien
ra o recovery stage.

---

### Variation 3: Tighter VU (test drop scenario)

Muc dich: Co tinh tao ra dropped_iterations de hieu hanh vi.

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_02_PREALLOCATED_VUS = "2"
$env:RAR_02_MAX_VUS = "4"
$env:RAR_02_MAX_DROPPED = "100"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Du kien: Voi preAllocatedVUs=2, maxVUs=4, event 23ms:

```text
VU demand o peak = ceil(24 × 0.023) = 1 VU
Voi 4 maxVUs -> van du? Co ve the...

Nhung neu backend cham bat thuong (p99=101ms):
  ceil(24 × 0.101) = ceil(2.42) = 3 VU
  Van trong gioi han 4 maxVUs -> 0 drop
```

De THUC SU tao drop, can tang event duration:

```powershell
# Su dung backend cham hon bang cach goi API voi tham so cao hon
# Hoac chinh script de dung cpu_ms=50, db_rows=10
# (Can chinh script, khong chi dung env var)
```

Day la bai hoc: de tao dropped_iterations, can event duration CAO, khong chi
VU pool thap.

---

### Variation 4: Smoke test (chi 1 iteration)

Muc dich: Kiem tra script chay dung, khong loi syntax, truoc khi chay full.

```powershell
$env:BASE_URL = "http://localhost:80"
k6 run --iterations 1 "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Tuy nhien, voi `ramping-arrival-rate`, `--iterations` khong hoan toan tuong thich
vi executor tu quyet dinh so iteration. Thay vao do, dung short stage duration:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_02_DURATION_SCALE = "0.1"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js"
```

Voi scale=0.1: moi stage con 1.5s (15×0.1), drain 0.5s. Tong ~5s, ~5 iterations.

---

### Variation 5: Single-operation-only (test tung branch rieng)

Muc dich: Isolate tung auth operation de tim bottleneck.

Sua script tam thoi (hoac tao ban sao):

```js
// Test CHI login (100%)
const choice = 'login';

// Hoac test CHI /me
const choice = 'me';

// Hoac test CHI refresh
const choice = 'refresh';
```

Chay tung ban:

```powershell
# Chi test login
$env:BASE_URL = "http://localhost:80"
k6 run "...\rar-02-login-burst-recovery-login-only.js"

# Chi test refresh
k6 run "...\rar-02-login-burst-recovery-refresh-only.js"
```

Phan tich:

```text
Neu login-only: event p95 = ?ms
Neu /me-only: event p95 = ?ms (co memory_kb=4)
Neu refresh-only: event p95 = ?ms (co db_writes=1)

So sanh 3 p95 -> branch nao cham nhat?
Branch cham nhat LA BOTTLENECK khi chay mixed (3 branch cung luc).
```

---

## 16. Anti-patterns

### Anti-pattern 1: Dung constant-vus de test auth burst

```text
SAI: constant-vus voi vus=50, duration=50s.
  VUs loop login -> /me -> refresh lien tuc.
  Khong mo phong duoc ingress curve 1->6->24->5->0.
  Backend cham -> throughput tu giam -> false negative.

DUNG: ramping-arrival-rate voi startRate=1, stages: 15s->6, 15s->24, 15s->5, 5s->0.
```

### Anti-pattern 2: Chi nhin checks va http_req_failed, bo qua dropped_iterations

```text
SAI: "checks=100%, http failed=0% -> test pass!"
  Rar-05 la vi du: checks=100%, http failed=0%, nhung dropped=20 -> FAIL.

DUNG: dropped_iterations la PRIMARY pass/fail signal cho open-model test.
  Luon kiem tra dropped_iterations TRUOC, roi moi den checks va http.
```

### Anti-pattern 3: Dung preAllocatedVUs = maxVUs (khong co room mo rong)

```text
SAI: preAllocatedVUs=50, maxVUs=50.
  VU pool khong the mo rong khi can.
  Neu event duration tang dot ngot -> drop ngay lap tuc.
  Bo di kha nang "tu phuc hoi" cua open model.

DUNG: preAllocatedVUs < maxVUs (vd: 16 < 50).
  Pool co the mo rong gap 3 khi can.
  Cho phep test "tu dieu chinh" khi backend cham.
```

### Anti-pattern 4: Scale test bang cach tang userPool nhung khong tang VU

```text
SAI: userPool=6000 (gap 10) nhung preAllocatedVUs=16 (giu nguyen).
  userPool khong anh huong den VU demand.
  VU demand = arrival_rate × event_duration.
  userPool chi anh huong den identity da dang, khong anh huong performance.

DUNG: Hieu ro userPool la business parameter, khong phai performance parameter.
  Tang VU khi can scale performance, khong phai khi tang user count.
```

### Anti-pattern 5: Bo qua spawn delay khi set preAllocatedVUs qua thap

```text
SAI: preAllocatedVUs = ceil(peak_rate × event_p95).
  Voi rar-02: ceil(24 × 0.023) = 1. Set preAllocatedVUs=1.
  Du 1 VU la du de xu ly toan bo load...
  NHUNG: VU spawn ton thoi gian. Khi burst bat dau, scheduler phai spawn
  VU tu 1 -> so can thiet. Spawn delay gay drop o dau burst.

DUNG: preAllocatedVUs > VU_can toi thieu. Co margin cho spawn delay + tail latency.
  Voi rar-02: preAllocatedVUs=16 (gap 16 lan VU can).
```

### Anti-pattern 6: Khong test recovery behaviour

```text
SAI: Chi quan tam burst peak (15s o 24/s), bo qua recovery (24->5->0).
  Backend co the pass peak nhung crash o recovery.
  Ly do: resource giai phong dot ngot, connection pool reset,
  memory fragmentation sau high load.

DUNG: Doc ca 4 stage. Recovery va drain quan trong khong kem burst peak.
  Neu event p95 TANG trong recovery -> backend "met" sau burst.
```

---

## 17. Real validation data

### Run information

```text
Run ID: #101
Date: 2026-06-21
Script: rar-02-login-burst-recovery.js
Exit code: 0
summary_pushed: true
finish_status: 200
Target base: http://localhost:80
Metrics server: http://localhost:18080
Token: student-token-1234567890
```

### Summary metrics

| Metric | Value |
| --- | ---: |
| `checks_rate` | `1` (100%) |
| `checks_passes` / `checks_fails` | `507 / 0` |
| `http_req_failed_rate` | `0` (0%) |
| `dropped_iterations` | `0` |
| `ramping_arrival_events_failed_rate` | `0` |
| `iterations` | `507` |
| `iterations_rate` | `10.35/s` |
| `http_reqs` | `507` |
| `http_reqs_rate` | `10.35/s` |
| `vus_max` | `1` (active sample) / `16` (envelope) |
| `ramping_arrival_event_duration_ms avg` | `6.18 ms` |
| `ramping_arrival_event_duration_ms med` | `3 ms` |
| `ramping_arrival_event_duration_ms p95` | `23 ms` |
| `ramping_arrival_event_duration_ms p99` | `24 ms` |
| `ramping_arrival_event_duration_ms max` | `101 ms` |
| `http_req_duration avg` | `6.07 ms` |
| `http_req_duration med` | `2.76 ms` |
| `http_req_duration p95` | `23.10 ms` |
| `http_req_duration p99` | `23.73 ms` |
| `http_req_duration max` | `101.03 ms` |

### Request breakdown (theo operation)

| Operation | Method | Status | Count | Percentage |
| --- | --- | --- | ---: | ---: |
| `login_burst_login` | POST | 200 | 307 | 60.6% |
| `login_burst_me` | GET | 200 | 125 | 24.7% |
| `login_burst_refresh` | POST | 200 | 75 | 14.8% |
| **Total** | | | **507** | **100%** |

### Dashboard series check

```text
iterations:          points=49, sum=507, min=1, max=23, truncated=false
http_reqs:           points=507, sum=507, min=1, max=1, truncated=false
dropped_iterations:  points=0, truncated=false
vus:                 points=49, min=0, max=1, truncated=false
```

### Stage math reconciliation

| Stage | Duration | Rate curve | Computed slots | Observed |
| --- | ---: | --- | ---: | ---: |
| 1 Pre-burst | 15s | 1 -> 6/s | 52.5 | -- |
| 2 Burst peak | 15s | 6 -> 24/s | 225 | -- |
| 3 Recovery | 15s | 24 -> 5/s | 217.5 | -- |
| 4 Drain | 5s | 5 -> 0/s | 12.5 | -- |
| **Total** | **50s** | | **507.5** | **507** |

### Verdict

```text
PASS — default ramping-arrival-rate case giu duoc arrival curve:
  - checks sach (507/507 = 100%)
  - HTTP failed = 0%
  - dropped_iterations = 0
  - event p95 = 23ms, http p95 = 23.25ms
  - iterations = 507, khop voi stage math (507.5 theoretical)
  - 3 branch phan bo dung weight: login 60.6%, me 24.7%, refresh 14.8%
  - VU pool du thua (pre=16, max=50, active max=1)
  - Khong co spawn delay, khong drop, khong failed event

Ket luan: Auth service o default config co kha nang hap thu
login burst 1 -> 6 -> 24 -> 5 -> 0/s ma khong fail/drop.
```

### Comparison voi cac case khac trong RAR series

| Case | Peak rate | Iterations | Dropped | Event p95 | VU active max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| rar-01 | 28/s | 705 | 0 | 5ms | 1 | PASS |
| **rar-02** | **24/s** | **507** | **0** | **23ms** | **1** | **PASS** |
| rar-03 | 20/s | 545 | 0 | 6ms | 0 | PASS |
| rar-04 | 12/s | 317 | 0 | 112ms | 1 | PASS |
| rar-05 | 8/s | 199 | 20 | 9.01s | 45 | FAIL |
| rar-06 | 36/s | 949 | 0 | 4ms | 1 | PASS |
| rar-07 | 32/s | 1035 | 0 | 86ms | 6 | PASS |

Rar-02 nam o giua bang: peak cao (24/s), event p95 trung binh (23ms), VU nhe
(1 active), pass de dang. Day la mot case "healthy by default" -- auth service
o kich ban notification push thong thuong khong co van de.

---

## Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Validation data: `./08_validation-and-chart-analysis.md` (Section rar-02)
- Source script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-02-login-burst-recovery.js`
- Shared helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
- Executor reference: https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/
- Little's Law: https://en.wikipedia.org/wiki/Little%27s_law
