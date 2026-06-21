# Case 05: Report Job Ingress Ramp

> **Script:** `rar-05-report-job-ingress-ramp.js`
> **Executor:** `ramping-arrival-rate` | **Open model** | **Peak:** 8 arrivals/s
> **Focus:** report dashboard reads + async job create/status, default target `http://localhost:8088`.
> **Designation:** **THE STAR TEACHING CASE** -- deliberately designed to FAIL.
> **Parallel reference:** `car-05` (constant-arrival-rate failing case, same async report pattern at fixed 6/s)

---

## 1. Tinh huong thuc te

### Boi canh doanh nghiep

Backoffice users mo dashboard bao cao vao dau gio lam viec. Day la thoi diem traffic cao nhat trong ngay vi tat ca nhan vien cung dang nhap va xem bao cao cung luc.

```text
08:00 AM -- 200 nhan vien sales dang nhap he thong bao cao
         -- 60% mo dashboard xem bao cao doanh so hom qua (nhe, nhanh)
         -- 40% trigger async export report (tao job + cho + poll status)
         -- Traffic tang dan tu 1/s (truoc gio lam) -> 3/s (dang nhap)
            -> 8/s (cao diem tao job) -> 2/s (giam dan) -> 0/s (het gio)
```

Hai loai nguoi dung -- hai loai tai hoan toan khac nhau:

```text
1. Dashboard viewer (60%):
   - Mo dashboard, xem bao cao co san
   - 1 HTTP GET -> response ~2ms
   - VU duoc giai phong gan nhu ngay lap tuc
   - Nhe nhu long hong

2. Async job submitter (40%):
   - Tao job export bao cao (POST)
   - Cho job san sang (wait ~140ms)
   - Poll trang thai job (GET)
   - 2 HTTP calls + 1 wait
   - VU bi giu it nhat 144ms
   - Nang gap ~70 lan so voi dashboard
```

### Vi sao day la van de kho?

Thoat nhin, peak chi 8 arrivals/s -- mot con so rat khiem ton. Case 06 trong cung series dat peak 36/s. Vay ma case 05 lai la case FAIL, con case 06 lai PASS. Nghich ly nay nam o ban chat async cua traffic:

```text
Dashboard event: 1 GET, 2ms -> VU quay vong nhanh
Async job event: POST (2ms) + wait(140ms) + GET (2ms) = 144ms VU bi giu

Tai peak 8/s voi 40% async:
  - 3.2 async jobs duoc tao MOI GIAY
  - Moi async job giu VU 0.144s+
  - 3.2 x 0.144 = 0.46 VU-giay moi giay
  - Nhung day la con so DANH NGHIA (voi W=144ms co dinh)
  - Thuc te, khi nhieu async job chay dong thoi:
    + Backend bi qua tai -> moi job lau hon -> W tang
    + W_p95 thuc te = 9.01s (khong phai 144ms!)
    + 3.2 x 9.01 = 28.8 VU-giay moi giay
    + preAllocatedVUs=25 -> khong du!
```

### Cau hoi kinh doanh

```text
Report service co giu duoc report ingress ramp 1 -> 3 -> 8 -> 2/s
voi drop budget BANG 0 khong?
```

"Drop budget bang 0" la yeu cau khac nghiet nhat: khong mot arrival nao bi bo loi. Moi async job duoc tao PHAI duoc phuc vu. Day la hop dong SLO cua team platform: "He thong bao cao khong duoc phep tu choi bat ky request nao trong gio cao diem."

### Mapping voi CAR-05

Case nay la ban sao ramping-arrival-rate cua CAR-05. Ca hai deu:

| Dac diem | CAR-05 | RAR-05 |
| --- | --- | --- |
| Service | Report API | Report API |
| Branches | dashboard 70% + async 30% | dashboard 60% + async 40% |
| Async pattern | POST + wait(0.14s) + GET | POST + wait(0.14s) + GET |
| Drop budget | 0 (strict) | 0 (strict) |
| Target shape | Fixed 6/s | Ramp 1->3->8->2->0/s |
| Teaching purpose | Fixed-rate capacity failure | Peak-stage capacity failure |

Su khac biet cot loi: CAR-05 co rate CO DINH 6/s trong 45s, con RAR-05 co rate BIEN THIEN theo duong ramp. Trong CAR-05, drop xay ra deu trong suot qua trinh. Trong RAR-05, drop TAP TRUNG o giai doan peak 8/s.

### Tai sao goi day la "STAR TEACHING CASE"?

Trong toan bo series ramping-arrival-rate, day la case duoc thiet ke de CO TINH FAIL. Khong phai fail vi HTTP 500, khong phai fail vi check sai. Fail vi:

```text
checks = 100%           <- tat ca HTTP response deu dung status code
http_req_failed = 0%    <- khong request nao bi loi mang/protocol
ramping_arrival_events_failed = 0  <- khong event nao ket thuc voi ok=false

nhung

dropped_iterations = 20 > maxDropped = 0  <- TEST FAIL
```

Day la nghich ly cot loi cua open model ma case nay day: **"Tat ca request deu OK nhung test van FAIL"**. Sinh vien nao hieu duoc nghich ly nay thi da nam duoc ban chat cua ramping-arrival-rate.

```text
Trong closed model (constant-vus, ramping-vus):
  - Tat ca request OK -> test pass
  - Khong co khai niem "drop"

Trong open model (ramping-arrival-rate):
  - Hop dong la ARRIVAL RATE, khong phai HTTP status
  - Neu arrival khong start duoc (drop) -> breach contract
  - Checks=100% la can nhung KHONG DU
```

Case nay se duoc dung lam "case study chinh" khi giang day open model, vi no phoi bay toan bo nghich ly, nguyen nhan goc, va day cach doc `dropped_iterations` nhu tin hieu contract breach chu khong phai "loi HTTP".

---

## 2. Hai yeu cau cot loi

### Yeu cau (a): 8 report job arrivals/s tai peak, zero drop

**Y nghia**: Dac biet tai giai doan peak 8/s, he thong kiem thu phai start DUNG so luong arrivals duoc schedule. Khong duoc phep "tu giam toc" vi async path cham.

**Vi du cu the**:

```text
Scenario: Team ops muon biet report service co handle duoc load gio cao diem khong.

Truong hop A (open model -- ramping-arrival-rate):
  startRate=1, stages: 15s->3, 20s->8, 15s->2, 5s->0
  preAllocatedVUs=25, maxVUs=80
  Backend cham -> VU pool cang -> mot so slot bi drop
  Ket qua: iterations=199 (thieu 20 so voi 219 scheduled)
  -> Ket luan: He thong KHONG du nang luc o peak 8/s

Truong hop B (closed model -- ramping-vus):
  stages: 15s->25, 20s->50, 15s->25, 5s->0
  Backend cham -> moi VU hoan thanh it iteration hon -> throughput tu giam
  Ket qua: khong co drop, nhung throughput thuc te thap hon 8/s
  -> Ket luan: SAI! Test khong phat hien duoc he thong khong chiu noi 8/s.
     Day la "silent degradation" -- nguy hiem nhat.
```

### Yeu cau (b): Zero dropped iterations du co async wait

**Y nghia**: Async job branch co `sleep(0.14s)` giu VU. Du vay, VU pool phai du lon de khong slot nao bi drop. Day la bai toan sizing VU cho open model voi bimodal event duration.

**Vi sao day la yeu cau kho?**

```text
Dashboard event: 1 GET request, hoan thanh trong ~2-5ms -> W_dashboard ~ 2-5ms
Async job event: POST create (2ms) + wait(140ms) + GET status (2ms) -> W_async ~ 144ms

Day la bimodal distribution: 60% events rat nhanh, 40% events cham hon ~70 lan.

Cong thuc VU can thiet (Little's Law):
  required_vus = lambda x W_avg
               = ? x (0.6 x 0.003 + 0.4 x 0.144)
               = ? x (0.0018 + 0.0576)
               = ? x 0.0594
               
Tai peak 8/s: required_vus = 8 x 0.0594 = 0.48 VU <- TREN LY THUYET, qua it!

Nhung thuc te: Default run voi preAllocatedVUs=25, maxVUs=80 van DROP 20 iterations.
Vi sao?

Vi Little's Law dung W_avg (trung binh), nhung VU pool exhaustion xay ra do TAIL LATENCY.
Khi p95 event duration = 9010ms (9.01 giay!), mot so VU bi giu hang giay.
Trong luc do, arrival scheduler van ban 8 slots/s.
Neu nhieu async job bi ket cung luc -> VU pool can kiet -> drop.

Cong thuc dung phai la:
  required_vus_for_no_drop >= lambda x W_p95 (khong phai W_avg)
  >= 8 x 9.01
  >= 72.1 VU

Va thuc te maxVUs=80, active VU max observed=45, drop=20.
-> Van chua du vi W_p95 thuc te con cao hon, va arrival distribution khong deu.
```

### Hai yeu cau mau thuan voi nhau

```text
Yeu cau (a): Giu arrival rate co dinh theo ramp, khong tu giam toc.
Yeu cau (b): Khong duoc drop arrivals nao.

Nhung khi async path cham:
  - Neu giu arrival rate (a) -> can nhieu VU -> neu khong du VU -> drop -> vi pham (b)
  - Neu muon 0 drop (b) -> can VU pool khong lo -> phai giam arrival rate -> vi pham (a)

Day la mau thuan cot loi: open model yeu cau CA HAI cung luc.
Giai phap chi co the la: DU VU HOAC TOI UU ASYNC PATH.
"Tang VU" la giai phap tam thoi. "Toi uu async path" la giai phap ban chat.
```

---

## 3. Vi sao dung `ramping-arrival-rate`?

### Report job submissions theo duong ramp

Trong thuc te, traffic khong phai la hang so. No bien thien theo thoi gian trong ngay:

```text
07:55 - 08:10: Traffic tang dan tu 1/s -> 3/s (nhan vien bat dau dang nhap)
08:10 - 08:30: Traffic cao diem 8/s (tat ca dang xem bao cao + tao job)
08:30 - 08:45: Traffic giam dan 2/s (ket thuc gio cao diem)
08:45 - 08:50: Traffic ve 0 (het gio)
```

`ramping-arrival-rate` la executor DUY NHAT mo hinh hoa duoc kich ban nay mot cach chinh xac:

| Executor | Mo hinh hoa duoc ramp? | Giữ arrival rate doc lap voi backend? | Co tin hieu drop? | Phu hop? |
| --- | --- | --- | --- | --- |
| **ramping-arrival-rate** | Co (startRate + stages) | Co (open model) | Co (dropped_iterations) | **DUNG** |
| constant-arrival-rate | Khong (rate co dinh) | Co | Co | Chi test duoc 1 muc rate |
| ramping-vus | Co (stages) | Khong (closed model) | Khong | Sai ban chat |
| constant-vus | Khong | Khong | Khong | Hoan toan sai |
| shared-iterations | Khong co duration | Khong | Khong | Khong phu hop |

### Vi sao constant-arrival-rate khong du?

```text
constant-arrival-rate chi test DUY NHAT 1 muc rate trong suot thoi gian chay.
Neu chi test 8/s co dinh -> bo qua giai doan ramp-up va cool-down.
Trong thuc te, nhieu system fail o giai doan RAMP (khi dang scale up),
khong phai o giai doan steady-state.

Vi du: Neu system can "warm up" connection pool, scale out pods, hoac
initialize cache trong giai doan ramp-up, thi test voi constant-arrival-rate
(rate co dinh ngay tu dau) se bo qua van de nay.
```

### Vi sao ramping-vus "doi" trong case nay?

Day la mot trong nhung sai lam pho bien nhat. Hay xem xet 3 kich ban:

```text
Kich ban 1: Backend khoe, dashboard + async job deu nhanh
  ramping-vus (stages: 15s->25, 20s->50):
    W_avg ~ 5ms -> throughput ~ 50/0.005 = 10000 events/s -> du suc
    Ket luan: "pass" -> dung, nhung khong noi len duoc gi ve capacity that
  ramping-arrival-rate (startRate=1, stages: 15s->3, 20s->8):
    W_avg ~ 5ms -> required_vus ~ 0.04 -> 25 VU du rat nhieu
    Ket luan: "pass" -> dung

Kich ban 2: Backend hoi cham, async job ~500ms
  ramping-vus:
    W_avg ~ 0.6x5ms + 0.4x500ms = 203ms
    throughput = 50/0.203 ~ 246 events/s
    Ket luan: "246/s > 8/s -> pass" -> SAI! Day la test closed model,
    khong kiem tra duoc lieu system co handle 8 arrivals/s khi co external traffic khong
  ramping-arrival-rate:
    W_avg ~ 203ms -> required_vus ~ 1.6 -> 25 VU van du
    Ket luan: "pass" -> dung

Kich ban 3: Backend rat cham, async job ~9s (nhu default run thuc te)
  ramping-vus:
    W_avg ~ 0.6x5ms + 0.4x9000ms = 3603ms
    throughput = 50/3.603 ~ 13.9 events/s
    Ket luan: "13.9/s > 8/s -> van pass?" -> SIEU SAI!
    Vi 13.9/s la throughput CUA 50 VU TRONG CLOSED MODEL.
    Production co 8 arrivals/s tu ben ngoai, moi arrival can VU rieng.
    25 VU khong du cho 8/s voi W_p95=9s.
  ramping-arrival-rate:
    drop=20 -> FAIL ro rang
    Ket luan: "KHONG du capacity cho peak 8/s" -> DUNG!
```

**Ghi nho**: Khi test ingress/arrival contract, LUON dung open model executor. Closed model executor (constant-vus, ramping-vus) se "giau" capacity issue bang cach tu giam throughput.

### Async latency khong duoc phep throttle ingress

Trong production thuc te:

```text
Nguoi dung khong tu dong "cham lai" khi server cham.
Ho van click, van gui request voi cung toc do.
Neu server cham -> request queue day -> gateway tu choi request moi.

Day chinh xac la dieu ramping-arrival-rate mo phong:
  - startRate=1, stages xac dinh arrival curve
  - scheduler van tao arrivals dung theo lich trinh
  - Neu khong du VU -> drop (tuong duong gateway tu choi)
  - Day la hanh vi THAT cua production, khong phai artifact cua test
```

Nguyen tac thiet ke:

```text
"Async latency is the system's problem, not the caller's problem.
 The caller should not slow down because the system is slow.
 If the system can't handle the ingress rate, it must be scaled up --
 not silently degrade the caller's experience."
```

---

## 4. Config mapping

### Bang tham so day du

| Tham so | Default | Y nghia | Ghi chu |
| --- | ---: | --- | --- |
| `RAR_05_BASE_URL` | `http://localhost:8088` | Report API target rieng | Khac voi `http://localhost:80` cua cac case khac |
| `RAR_05_START_RATE` | 1 | Rate dau run (arrivals/s) | Mo phong traffic truoc gio lam viec |
| `RAR_05_NORMAL_RATE` | 3 | Dashboard normal traffic | Giai doan nhan vien dang nhap |
| `RAR_05_JOB_RATE` | 8 | Job ingress peak | Giai doan cao diem tao job |
| `RAR_05_COOLDOWN_RATE` | 2 | Cooldown traffic | Giai doan giam tai |
| `RAR_05_DURATION_SCALE` | 1 | He so scale stage duration | 1 = goc, 0.5 = nhanh gap doi |
| `RAR_05_PREALLOCATED_VUS` | 25 | Worker warm san | 25 VU san sang ngay tu T=0 |
| `RAR_05_MAX_VUS` | 80 | Worker ceiling | Toi da 80 VU duoc spawn |
| `RAR_05_READY_AFTER_MS` | 120 | Wait truoc status poll | Thoi gian gia lap job processing |
| `RAR_05_MAX_DROPPED` | 0 | **Zero-drop budget** | **STRICTEST CONTRACT** |
| `RAR_05_USER_POOL` | 300 | User identity pool | 300 user xoay vong |

### Stage breakdown

```text
4 giai doan, tong 55 giay:

Giai doan 1 - Normal dashboard (15s): 1/s -> 3/s
  - Mo phong nhan vien bat dau dang nhap
  - Rate tang dan, chua co nhieu async job

Giai doan 2 - Job ingress peak (20s): 3/s -> 8/s
  - DAY LA GIAI DOAN QUAN TRONG NHAT
  - Cao diem tao job, 40% la async
  - Drop tap trung o day

Giai doan 3 - Cooldown (15s): 8/s -> 2/s
  - Traffic giam dan
  - Cac async job ton dong duoc xu ly not

Giai doan 4 - Drain (5s): 2/s -> 0/s
  - Traffic ve 0
  - Dam bao khong con arrival moi
```

### Stage math -- tinh toan scheduled slots

Moi giai doan co rate thay doi tuyen tinh. So slot duoc tinh bang dien tich hinh thang:

```text
Giai doan 1 (15s, 1->3/s): (1+3)/2 x 15 = 30 slots
Giai doan 2 (20s, 3->8/s): (3+8)/2 x 20 = 110 slots  <-- PEAK
Giai doan 3 (15s, 8->2/s): (8+2)/2 x 15 = 75 slots
Giai doan 4 (5s,  2->0/s): (2+0)/2 x 5  = 5 slots
                              ---------------
                              Total = 220 slots
```

**Xac nhan so lieu thuc te**:

```text
Default run: 199 completed + 20 dropped = 219
Target: 220 slots
Chenh lech: 1 slot (~0.45%)
Giai thich: Boundary micro-timing trong giai doan drain
             (slot cuoi cung co the chua kip schedule khi test ket thuc)
             
-> 219 ~ 220: Khop ✅
```

### Y nghia cua maxDropped=0

```text
maxDropped=0 la HOP DONG NGHIEM NGAT NHAT trong toan bo series.

So sanh voi cac case khac:
  - rar-01: maxDropped=5 (chap nhan 5 drop)
  - rar-02: maxDropped=3
  - rar-03: maxDropped=3
  - rar-04: maxDropped=5
  - rar-05: maxDropped=0  <-- ZERO TOLERANCE
  - rar-06: maxDropped=3
  - rar-07: maxDropped=0 (strict, nhung la case nhe)

Chi can 1 drop -> threshold vi pham -> test FAIL.
Day la SLO cua team platform: "Khong duoc phep mat bat ky request nao."
```

---

## 5. Identity model deep-dive

### VU = anonymous worker trong open model

Trong ramping-arrival-rate, VU khong co identity rieng. VU la nhung worker vo danh, duoc dispatcher gan cho bat ky arrival event nao dang cho:

```text
VU #1 co the xu ly event cho user-1 (iter 0),
sau do user-301 (iter 300), roi user-101 (iter 100), v.v.

Dieu nay dung voi ban chat open model:
  - Identity khong thuoc ve VU, ma thuoc ve arrival event
  - VU chi la "container" chay event
  - Khong co state duoc carry qua giua cac iteration
```

### userContext hoa user identity

```js
// Tu common.js: userContext()
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

**Cach identity hoat dong trong case 05**:

| Thanh phan | Cong thuc | Vi du | Y nghia |
| --- | --- | --- | --- |
| `userId` | `rar-user-${(iter % 300) + 1}` | `rar-user-1` den `rar-user-300` | User identity xoay vong qua 300 user |
| `vuId` | `exec.vu.idInTest` | `1`, `15`, `23`, `41` | VU nao dang xu ly event |
| `iter` | `exec.scenario.iterationInTest` | `0`, `1`, ..., `218` | So thu tu iteration toan cuc |
| `requestKey` | `${seed}-${iter}-${vuId}` | `1718900000-42-15` | Unique key cho tracing |
| `abVariant` | `iter % 2 === 0 ? 'b' : 'a'` | `a`, `b` | A/B test variant |

### Vi sao dung userPool=300?

```text
300 user identity la con so du lon de:
  1. Tranh overlap identity qua nhieu (moi user trung binh xuat hien < 1 lan)
  2. Mo phong da dang nguoi dung thuc te
  3. Tag userId tren request giup phan biet user trong log/backend
  4. Khong gay ra cache hit khong thuc te (neu backend cache theo user)

Voi 199-216 iterations:
  - Moi user trung binh xuat hien 199/300 = 0.66 lan
  - Gan nhu KHONG CO user nao xuat hien 2 lan
  - Backend thay 199-216 user KHAC NHAU -> khong co cache warming artifact
```

### Async job ID tracking

Moi async_job event tao 1 job ID duy nhat. Job ID duoc server sinh ra, sau do dung de poll status:

```js
// Tu rar-05-report-job-ingress-ramp.js (async_job branch)
const create = requestJson('POST', `${TARGET_URL}/api/sim/report/jobs?cpu_ms=2&db_writes=1&external_ms=20&ready_after_ms=${READY_AFTER_MS}`, {
  report_type: 'sales-hourly',
  requested_by: ctx.userId,
}, {
  caseId: CASE_ID,
  service: 'report-service',
  operation: 'report_job_ramp_create',
  endpoint: 'POST /api/sim/report/jobs',
  userId: ctx.userId,
}, 202);

const jobId = create.ok ? responseJson(create.response, 'data.job_id', '') : '';
if (jobId) {
  wait((READY_AFTER_MS + 20) / 1000);
  const status = requestJson('GET', `${TARGET_URL}/api/sim/report/jobs/${jobId}?...`, ...);
}
```

**Trace cho 1 async_job event**:

```text
Event #42:
  vuId=15, userId=rar-user-43, iter=42
  POST /api/sim/report/jobs?cpu_ms=2&db_writes=1&external_ms=20&ready_after_ms=120
    -> 202 Accepted, jobId="job-sim-042"
  wait(0.14s)  <-- VU #15 bi giu 140ms
  GET /api/sim/report/jobs/job-sim-042?cpu_ms=0&db_rows=0
    -> 200 OK, status="completed"
  finishEvent()

Tong event_duration = time(POST) + wait(0.14) + time(GET) + processing
                     ~ 2ms + 140ms + 2ms = 144ms (danh nghia)
                     Co the den 9000ms+ (thuc te, do backend qua tai)
```

### So sanh identity model voi CAR-05

| Thanh phan | CAR-05 | RAR-05 |
| --- | --- | --- |
| User prefix | `arrival-user-` | `rar-user-` |
| User pool | 250 | 300 |
| Identity bound to | Iteration | Iteration |
| Branch selection | `weightedPick([{dashboard,70},{async_job,30}], ctx.iter)` | `weightedPick([{dashboard,60},{async_job,40}], ctx.iter)` |
| jobId extraction | `responseJson(create.response, 'data.job_id', '')` | `responseJson(create.response, 'data.job_id', '')` |
| Wait duration | `(READY_AFTER_MS + 20) / 1000` | `(READY_AFTER_MS + 20) / 1000` |

---

## 6. Open model deep-dive -- THE CRITICAL SECTION

### Mo hinh toan hoc

```text
lambda(t) = arrival rate tai thoi diem t (bien thien theo stage)
lambda_peak = 8/s (giai doan 2)
T = tong duration = 55s
N_sched = tich phan lambda(t) dt tren 55s = 220 slots

W = event duration (bien ngau nhien, bimodal)
W_dashboard ~ 2-5ms
W_async_job ~ 144ms danh nghia, thuc te den 9000ms+ p95

VU pool: preAllocated=25, max=80
```

### Vi sao 0.14s sleep + 40% async mix = VU pressure?

Day la CAU HOI TRUNG TAM cua case nay. Hay phan tich tung buoc:

**Buoc 1: Moi async job giu VU it nhat 144ms**

```text
Mot async_job event dien hinh:
  T=0.000s: VU bat dau event
  T=0.002s: POST hoan thanh (2ms)
            -> lay duoc jobId
  T=0.002s: BAT DAU wait(0.14)
            -> VU "ngu" 140ms, khong lam gi
            -> NHUNG VAN BI TINH LA "BUSY"
            -> Scheduler thay VU nay ban -> tao slot moi -> can VU khac
  T=0.142s: KET THUC wait -> GET status
  T=0.144s: GET hoan thanh (2ms) -> finishEvent()
            -> VU duoc giai phong

Tong event_duration = 144ms
Trong do: http_req_duration = 4ms (CHI 2.8%!)
          wait_time = 140ms (97.2% thoi gian!)

-> 140ms/144ms = 97.2% thoi gian VU ban la do wait, KHONG PHAI HTTP!
-> Dung http_req_duration de sizing -> sai 1 bac magnitude (4ms vs 144ms = 36x)
```

**Buoc 2: Tai peak 8/s, async arrival rate la 3.2/s**

```text
8 arrivals/s x 40% async = 3.2 async_job events duoc tao MOI GIAY

Neu moi async_job giu VU 0.144s:
  3.2 x 0.144 = 0.46 VU-giay moi giay
  -> Ve nguyen tac, chi can ~1 VU la du! (0.46 < 1)

NHUNG day la voi W=144ms CO DINH.
Thuc te, khi nhieu async job chay dong thoi:
  - Backend bi qua tai -> W tang
  - W_p95 thuc te co the dat 9.01s (gap 62.5 lan so voi 144ms danh nghia!)
```

**Buoc 3: Hieu ung queueing -- tail latency khuyech dai VU demand**

```text
Neu W khong co dinh ma la bien ngau nhien:
  - Dashboard: 2-5ms (rat nhanh, distribution hep)
  - Async job: 144ms - 9000ms+ (rat cham, distribution rat rong)

Khi nhieu async job chay dong thoi:
  - Cac async job xep hang trong backend (DB queue, CPU queue)
  - Moi job lau hon -> VU bi giu lau hon
  - VU bi giu lau -> it VU ranh hon
  - It VU ranh -> dispatcher phai spawn them VU (neu con room)
  - Neu da dat maxVUs -> slot moi bi drop

Day la vong luan quan: nhieu async job -> backend cham -> VU giu lau -> can them VU -> nhieu VU -> backend cang cham
```

**Buoc 4: Tai sao 8/s peak (thap hon case 06 36/s) nhung drop nhieu hon?**

```text
rar-06: 36/s peak, drop=0
rar-05: 8/s peak, drop=20

Nghich ly nay duoc giai thich boi BAN CHAT cua traffic:

rar-06: Traffic DON GIAN (1 GET/call, khong async, khong sleep)
  - Moi event: 1 GET, ~1-5ms
  - Khong co wait/sleep
  - W_avg = W_p95 ~ 5ms (it tail latency)
  - required_vus = 36 x 0.005 = 0.18 VU -> 25 VU qua du

rar-05: Traffic PHUC TAP (2 branches, 40% async + sleep)
  - 60% event: 1 GET, ~2-5ms
  - 40% event: POST + wait(0.14s) + GET, W_p95 = 9010ms
  - W_avg ~ 3603ms
  - required_vus = 8 x 3.603 = 28.8 VU -> 25 VU co ve du
  - NHUNG required_vus cho p95 = 8 x 9.01 = 72.1 VU -> 80 VU co ve du
  - Van drop 20 vi W_p95 thuc te con higher o peak overlap

-> BAI HOC: Arrival rate cao khong nhat thiet la kho.
   Su ket hop async + sleep + tail latency moi la ke thu that su.
```

### Bimodal event duration distribution

```text
Event duration distribution (conceptual):

Dashboard (60%):  ||||||||||||||||||||||||||||||||||||||||||||||  (2-5ms)
                  0ms                                           10ms

Async job (40%):                                                  ||  (144ms-9000ms)
                                                                 100ms        10000ms
                                                                              (p95 thuc te)

Phan phoi bimodal: 2 "dinh" tach biet
  - Dinh 1 o ~2-5ms (dashboard)
  - Dinh 2 o ~144ms-9000ms+ (async_job)
  - Khoang cach giua 2 dinh: 30-3000 lan
```

**Vi sao bimodal nguy hiem cho VU pool?**

```text
Voi phan phoi unimodal (tat ca event ~cung duration):
  - Tat ca VU ban khoang thoi gian nhu nhau
  - VU pool quay vong deu dan
  - Little's Law voi W_avg du doan chinh xac

Voi phan phoi bimodal (2 nhom duration rat khac nhau):
  - Nhom nhanh (dashboard): VU quay vong nhanh, luon san sang
  - Nhom cham (async_job): VU bi giu lau, "ket" trong pool
  - Khi nhieu async_job chay cung luc -> pool can VU nhanh
  - Dashboard event moi khong tim duoc VU (du chi can 1-5ms) -> DROP

  Van de khong phai la THIEU VU tong the, ma la VU bi "chiem dung" boi nhom cham.
  Day goi la "head-of-line blocking" trong VU pool.
```

**Minh hoa bang so**:

```text
Thoi diem T=30s (giai doan peak 8/s): da schedule ~108 slots
  Dashboard expected: 108 x 0.6 = 65 events, moi event 5ms -> 65 VU can trong 5ms
  Async expected:     108 x 0.4 = 43 events, moi event 9010ms -> 43 VU can trong 9010ms

Tai T=30.000s: 65 dashboard event da xong (chi mat 5ms)
               43 async_job VAN DANG CHAY (nhieu cai da chay hon 9s)
Tai T=30.001s: scheduler ban them 1 slot (dang o rate 8/s -> ~8 slots/s)
               8 VU can ngay, nhung 43 VU dang ban voi async_job
               Neu pool chi co 80 VU max -> 43 dang ban, con 37 VU trong
               -> 8 slots can 8 VU -> OK
               
Tai T=32.000s: da co them ~16 async_job duoc schedule (32s x 8/s x 0.4 = ~102 async total)
               ~60 async_job van dang chay (do duration dai + arrival chong lan)
               Dashboard van den deu, nhung it VU ranh hon
               maxVUs=80 da gan dat -> dispatcher bat dau drop slot
               
Day la co che "VU pool exhaustion under bimodal latency".
Khong can W_avg lon, chi can mot nhom event giu VU du lau.
```

### Vuot qua gioi han preAllocatedVUs

```text
preAllocatedVUs=25: VU pool khoi dau voi 25 VU san sang.

Khi scheduler tao slot vuot qua kha nang cua 25 VU:
  1. Dispatcher spawn them VU (den toi da maxVUs=80)
  2. Moi VU moi ton tai nguyen (RAM, CPU, connection)
  3. Thoi gian spawn VU moi co the cham -> slot tam thoi khong co VU -> drop

Default run: active VUs tang tu 25 -> 45 (vuot preAllocated 80%)
           vus_max dat 45 (chua dat maxVUs=80 nhung drop da xay ra)
           -> Drop xay ra KHONG PHAI vi da can maxVUs,
              ma vi dispatcher khong spawn kip VU moi.
```

### Cong thuc drop -- vi sao 20?

```text
Cong thuc uoc luong drop:
  N_drop = max(0, N_sched - N_capacity)

Trong do:
  N_sched = 220
  N_capacity = tong so slot VU pool co the xu ly trong 55s

Voi preAllocatedVUs=25, maxVUs=80:
  VU pool trung binh active = ?
  Thoi gian trung binh 1 VU xu ly 1 event = W_avg = ?

  Voi W_avg danh nghia = 0.6 x 0.003 + 0.4 x 0.144 = 0.0594s
  N_capacity = 55 / 0.0594 x 25 = 23148 slots -> du suc!

  NHUNG voi W_p95 thuc te = 9.01s:
  Tai peak, required_vus = 8 x 9.01 = 72.1
  Nhung dispatcher chi duy tri duoc ~45 active VUs (do spawn cham + VU giai phong)
  -> Thieu ~27 VU o peak
  -> 27 VU thieu x (20s peak / 55s total) x 8 slots/s ~ 78 slots thieu -> nhung thuc te chi drop 20

  Con so chinh xac phu thuoc vao distribution cua event duration
  va thoi diem cac async_job start/ket thuc.
  Nhung 20/220 = 9.1% drop rate la tin hieu ro: capacity thieu ~9% o peak.
```

### Event trace chi tiet

**Trace cho 1 async_job event thuc te (default run)**:

```text
T=0.000s: VU #15 bat dau event #42
T=0.002s: POST /api/sim/report/jobs hoan thanh (http_req_duration=2ms)
          job_id = "job-sim-042" -> parse duoc
T=0.002s: BAT DAU wait(0.14)
          -> VU #15 van "busy", khong nhan event moi
          -> Scheduler tao slot moi -> can VU khac
T=0.142s: KET THUC wait -> BAT DAU GET job status
T=0.144s: GET /api/sim/report/jobs/job-sim-042 hoan thanh (http_req_duration=2ms)
T=0.144s: finishEvent() -> VU #15 duoc giai phong

Tong event_duration = 144ms
Trong do: http_req_duration = 2ms + 2ms = 4ms (CHI 2.8% !)
          wait_time = 140ms (97.2% thoi gian)

-> 140ms/144ms = 97.2% thoi gian VU ban la do wait, khong phai HTTP!
-> Dung http_req_duration de sizing -> sai 1 bac magnitude (4ms vs 144ms = 36x)
```

**Phan biet quan trong**:

```text
http_req_duration:     thoi gian HTTP request hoan thanh (~2ms cho POST, ~2ms cho GET)
event_duration:         thoi gian tu start den khi toan bo callback xong
                       = http_req_duration + wait_time + processing_time
                       ~ 2ms + 140ms + 2ms = 144ms (danh nghia)
                       ~ 9000ms+ (thuc te, do backend qua tai + queueing)

W_effective = event_duration (KHONG phai http_req_duration)

Sai lam pho bien: Dung http_req_duration de sizing VU.
Dung: Phai dung event_duration vi wait/sleep cung giu VU.
```

---

## 7. Service/API flow

### Branch map

| Branch | Weight | Flow | So HTTP calls | Expected status | W dien hinh |
| --- | ---: | --- | ---: | --- | ---: |
| `dashboard` | 60% | `GET /api/sim/report` | 1 | `200` | ~2-5ms |
| `async_job` | 40% | `POST /api/sim/report/jobs` -> `wait(0.14s)` -> `GET /api/sim/report/jobs/:id` | 2 | `202`, `200` | ~144ms+ (danh nghia) |

### Weighted branch selection

```js
// Tu rar-05-report-job-ingress-ramp.js
const choice = weightedPick([
  { name: 'dashboard', weight: 60 },
  { name: 'async_job', weight: 40 },
], ctx.iter);
```

`weightedPick` dung iteration counter de chon branch. Vi iteration la deterministic theo thu tu, branch cung deterministic:

```text
iter 0:  (0 % 100) = 0  < 60 -> dashboard
iter 1:  (1 % 100) = 1  < 60 -> dashboard
...
iter 59: (59 % 100) = 59 < 60 -> dashboard
iter 60: (60 % 100) = 60 >= 60 -> async_job (60-99)
...
iter 99: (99 % 100) = 99 >= 60 -> async_job
iter 100: (100 % 100) = 0 < 60 -> dashboard (lap lai)
```

Cu 100 iteration: 60 dashboard + 40 async_job -> dung ti le 60:40.

### Chi tiet tung HTTP request

**Dashboard (GET /api/sim/report)**:

```http
GET /api/sim/report?cpu_ms=0&db_rows=1&gzip_kb=0 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: ramping-arrival-rate
X-Load-Profile: ramping-arrival-rate-practice
X-User-ID: rar-user-42

Response 200 OK:
{
  "data": { ... }
}
```

Tag tren request:
```text
case_id: rar-05-report-job-ingress-ramp
service: report-service
operation: report_job_ramp_dashboard
endpoint: GET /api/sim/report
user_id: rar-user-42
```

**Async job -- Create (POST /api/sim/report/jobs)**:

```http
POST /api/sim/report/jobs?cpu_ms=2&db_writes=1&external_ms=20&ready_after_ms=120 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: ramping-arrival-rate
X-Load-Profile: ramping-arrival-rate-practice
X-User-ID: rar-user-43

{
  "report_type": "sales-hourly",
  "requested_by": "rar-user-43"
}

Response 202 Accepted:
{
  "data": {
    "job_id": "job-sim-043",
    "status": "processing",
    "ready_after_ms": 120
  }
}
```

Tag tren request:
```text
case_id: rar-05-report-job-ingress-ramp
service: report-service
operation: report_job_ramp_create
endpoint: POST /api/sim/report/jobs
user_id: rar-user-43
```

**Async job -- Status (GET /api/sim/report/jobs/:id)**:

```http
GET /api/sim/report/jobs/job-sim-043?cpu_ms=0&db_rows=0 HTTP/1.1
Host: localhost:8088
Content-Type: application/json
X-Test-Suite: ramping-arrival-rate
X-Load-Profile: ramping-arrival-rate-practice
X-User-ID: rar-user-43

Response 200 OK:
{
  "data": {
    "job_id": "job-sim-043",
    "status": "completed"
  }
}
```

Tag tren request:
```text
case_id: rar-05-report-job-ingress-ramp
service: report-service
operation: report_job_ramp_status
endpoint: GET /api/sim/report/jobs/:id
user_id: rar-user-43
```

### Expected HTTP reqs vs iterations

```text
Dashboard branch (60%): 1 HTTP call/event
Async_job branch (40%): 2 HTTP calls/event

So HTTP calls trung binh moi event:
  0.6 x 1 + 0.4 x 2 = 0.6 + 0.8 = 1.4

Default run:
  iterations = 199
  http_reqs expected = 199 x 1.4 = 278.6 ~ 279
  http_reqs actual = 278 ✅

Rerun:
  iterations = 216
  http_reqs expected = 216 x 1.4 = 302.4 ~ 302
  http_reqs actual = 296 (gan dung, chenh lech ~2%)
```

### Ready_after_ms va wait logic

```text
ready_after_ms = 120: Server gia lap job can 120ms de "san sang"
wait time = (READY_AFTER_MS + 20) / 1000 = (120 + 20) / 1000 = 0.14s

+20ms la buffer margin:
  - Job co the can them thoi gian de hoan thanh sau khi "ready"
  - Tranh poll status qua som (se nhan duoc "processing" thay vi "completed")

Day la pattern pho bien trong async API testing:
  1. Tao job (POST) -> nhan jobId
  2. Doi job ready (wait/sleep)
  3. Poll status (GET)
  
Van de: wait() giu VU trong suot thoi gian cho.
Trong production, viec cho nay thuong duoc thuc hien BOI CLIENT (browser),
khong phai boi server thread. Nhung trong k6 script, wait() = sleep() = giu VU.
```

### Query params -- simulated latency

Moi endpoint deu co query params gia lap do tre:

| Endpoint | cpu_ms | db_writes | db_rows | external_ms | gzip_kb | ready_after_ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GET /api/sim/report | 0 | -- | 1 | -- | 0 | -- |
| POST /api/sim/report/jobs | 2 | 1 | -- | 20 | -- | 120 |
| GET /api/sim/report/jobs/:id | 0 | -- | 0 | -- | -- | -- |

```text
Dashboard: cpu_ms=0, db_rows=1, gzip_kb=0 -> rat nhe, response gan nhu ngay lap tuc
Create job: cpu_ms=2, db_writes=1, external_ms=20 -> gia lap CPU + DB + external API
Status poll: cpu_ms=0, db_rows=0 -> nhe nhat, chi check status
```

---

## 8. Metrics and tags

### Custom metrics (tu common.js)

| Metric | Loai | Mo ta |
| --- | --- | --- |
| `ramping_arrival_events_total` | Counter | Tong so event da hoan thanh (~= iterations) |
| `ramping_arrival_events_failed` | Counter | So event ket thuc voi ok=false |
| `ramping_arrival_api_calls_total` | Counter | Tong so HTTP calls (~= http_reqs) |
| `ramping_arrival_event_duration_ms` | Trend | Thoi gian tu start den finish cua moi event |

### Built-in k6 metrics

| Metric | Y nghia trong case 05 |
| --- | --- |
| `iterations` | So event da hoan thanh (199 default) |
| `http_reqs` | Tong HTTP requests (278 default) |
| `http_req_duration` | Thoi gian HTTP request/response |
| `http_req_failed` | Ty le HTTP request bi loi |
| `checks` | Ty le check pass |
| `dropped_iterations` | **PRIMARY SIGNAL** -- so slot khong co VU |
| `vus` | So VU active tai moi thoi diem |
| `vus_max` | So VU active toi da trong run |

### Vi sao http_reqs > iterations?

```text
http_reqs = 278, iterations = 199

278 / 199 = 1.397 ~ 1.4

Moi iteration:
  - 60%: 1 HTTP call (dashboard)
  - 40%: 2 HTTP calls (async_job)
  - Trung binh: 0.6 x 1 + 0.4 x 2 = 1.4 HTTP calls

Day la dac diem cua multi-call event trong open model.
http_reqs LUON lon hon iterations khi co branch nhieu calls.
```

### Tag strategy

Moi HTTP request duoc gan 5 tag:

```text
case_id:  rar-05-report-job-ingress-ramp  -- nhan dang case
service:  report-service                   -- ten service
operation: report_job_ramp_{dashboard|create|status}  -- loai operation
endpoint: GET /api/sim/report | POST /api/sim/report/jobs | GET /api/sim/report/jobs/:id
user_id:  rar-user-{1..300}               -- user identity
```

Moi custom event metric duoc gan 3 tag:

```text
case_id:  rar-05-report-job-ingress-ramp
service:  report-service
operation: report_job_ramp_{dashboard|async_job}  -- branch cua event
user_id:  rar-user-{1..300}
```

### Cach doc dropped_iterations

`dropped_iterations` LA TIN HIEU QUAN TRONG NHAT trong case nay:

```text
dropped_iterations = 20 (default run)

Y nghia: 20 arrivals da duoc scheduler tao slot, nhung KHONG TIM DUOC VU
de chay. 20 event chua tung bat dau -> khong co HTTP request nao duoc tao
cho chung -> khong co log, khong co trace, khong co gi ca.

Trong production, day la:
  - Request bi drop o load balancer vi upstream full
  - User thay timeout/connection refused
  - KHONG CO server-side log nao ca
  -> Kho debug nhat trong tat ca cac loai loi
```

### Check cac tag breakdown tren dashboard

Khi xem dashboard, tach theo operation tag:

```text
report_job_ramp_dashboard:
  - 1 HTTP call/event
  - Expected ~60% cua http_reqs
  - Default: ~139 requests (199 x 0.6 x 1 = 119.4... thuc te la 139 vi branch distribution)

report_job_ramp_create:
  - 1 HTTP call/async_job event
  - Expected ~40% cua http_reqs / 2
  - Default: ~80 requests

report_job_ramp_status:
  - 1 HTTP call/async_job event
  - Expected = report_job_ramp_create
  - Default: ~80 requests
```

---

## 9. Pass criteria

### Thresholds

```js
thresholds: {
  checks:                        ['rate>0.99'],     // >99% checks pass
  http_req_failed:               ['rate<0.01'],     // <1% HTTP errors
  dropped_iterations:            [`count<=0`],      // ZERO drops
  ramping_arrival_events_failed: ['count<5'],       // <5 event failures
}
```

### THE KEY LESSON

```text
checks = 100%            <- TAT CA HTTP response deu dung status code
http_req_failed = 0%     <- KHONG request nao bi loi mang/protocol
ramping_arrival_events_failed = 0  <- KHONG event nao ket thuc voi ok=false

NHUNG

dropped_iterations = 20 > 0  <- TEST FAIL

KET LUAN: checks=100% + http_req_failed=0% KHONG DU DE PASS.
         dropped_iterations LA TIN HIEU QUYET DINH.
```

### Tai sao day la bai hoc quan trong nhat?

```text
Thoi quen tu closed model testing:
  - "Neu khong co HTTP 500, khong co timeout -> test pass"
  - "Neu checks 100% -> moi thu hoat dong dung"
  - "dropped_iterations? Chua bao gio thay metric nay -> bo qua"

Trong open model, dropped_iterations KHONG phai la "HTTP error".
No la "slot duoc schedule nhung khong co VU de chay".
Event chua tung bat dau -> khong co HTTP request nao duoc tao.
Vi vay http_req_failed=0% la dung (khong request nao fail).
Nhung test van FAIL vi contract la ARRIVALS, khong phai RESPONSES.
```

### So sanh 3 loai "fail"

| Loai fail | Metric | Xay ra khi | Nghia nghiep vu |
| --- | --- | --- | --- |
| HTTP fail | `http_req_failed` | Request gui di nhung server tra loi | Server nhan request nhung xu ly hong |
| Check fail | `checks` | Response khong thoa dieu kien | Server tra loi nhung sai noi dung |
| **Drop iteration** | `dropped_iterations` | Slot duoc schedule nhung khong co VU | **Server khong bao gio nhan duoc request** |

```text
Drop iteration la te nhat vi:
  - User gui request -> khong den duoc server
  - Khong co HTTP response nao de check
  - Khong co log server nao de debug
  - User chi thay timeout/connection refused

Trong production, day la "request bi drop o load balancer vi upstream full".
```

### Bai hoc

```text
Khi test voi ramping-arrival-rate:
  1. Luon doc dropped_iterations TRUOC KHI doc checks/http_req_failed
  2. Neu dropped > threshold -> FAIL, bat ke checks/http_req_failed the nao
  3. Drop la tin hieu CAPACITY, khong phai tin hieu CORRECTNESS
  4. Test open model = test capacity contract, khong phai correctness contract
```

---

## 10. Cach chay and output 5 buoc

### Buoc 1: Run default

```powershell
cd "E:\Khoa hoc\k6"
$env:RAR_05_BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

Hoac qua load target chung:

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_05_BASE_URL = "http://localhost:80"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

### Buoc 2: Rerun voi VU pool lon hon (kiem tra capacity hypothesis)

```powershell
$env:BASE_URL = "http://localhost:80"
$env:RAR_05_PREALLOCATED_VUS = "60"
$env:RAR_05_MAX_VUS = "120"
$env:RAR_05_BASE_URL = "http://localhost:80"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
Remove-Item Env:RAR_05_PREALLOCATED_VUS, Env:RAR_05_MAX_VUS -ErrorAction SilentlyContinue
```

### Buoc 3: Doc output summary

**Default run output**:

```text
     checks.........................: 100.00% ✓ 278 / 278
     http_req_failed...............: 0.00%   ✓ 0 / 278
     dropped_iterations............: 20      ✗ 20 > 0  <- PRIMARY FAIL SIGNAL
     ramping_arrival_events_failed.: 0       ✓ 0 < 5
     iterations....................: 199
     http_reqs.....................: 278
     vus_max.......................: 45
     ramping_arrival_event_duration_ms: avg=3603.52ms p(95)=9010.00ms
     http_req_duration.............: avg=7.61ms p(95)=8510.00ms
```

**Rerun output (pre=60, max=120)**:

```text
     checks.........................: 100.00% ✓ 296 / 296
     http_req_failed...............: 0.00%   ✓ 0 / 296
     dropped_iterations............: 3       ✗ 3 > 0  <- STILL FAIL
     ramping_arrival_events_failed.: 0       ✓ 0 < 5
     iterations....................: 216
     http_reqs.....................: 296
     vus_max.......................: 63
     ramping_arrival_event_duration_ms: p(95)=9250.00ms
     http_req_duration.............: p(95)=8890.00ms
```

### Buoc 4: Phan tich request breakdown

**Default run request breakdown**:

```text
report_job_ramp_dashboard  GET 200  count=139  (60% cua ~232 requests don, nhung co drop)
report_job_ramp_create     POST 202 count=80   (40% async jobs, 1 call/job)
report_job_ramp_status     GET 200  count=80   (40% async jobs, 1 call/job)
                                   ----
                          Total:    299 (nhung thuc te 278, chenh lech do drop)
```

**Rerun request breakdown**:

```text
report_job_ramp_dashboard  GET 200  count=148  (tang do it drop hon)
report_job_ramp_create     POST 202 count=74   (40% cua 216 iter = 86.4, 74 do drop)
report_job_ramp_status     GET 200  count=74
                                   ----
                          Total:    296 ✅ (216 x 1.37 ~ 296)
```

### Buoc 5: Decision

```text
Default run: dropped_iterations=20 > maxDropped=0 -> FAIL
  -> He thong KHONG du capacity cho peak 8/s voi async wait
  -> Can dieu tra: VU pool size? Backend performance? Script design?

Rerun: dropped_iterations=3 > maxDropped=0 -> STILL FAIL
  -> Tang VU tu 25/80 len 60/120 GIAM drop 85% (20->3) nhung KHONG TRIET DE
  -> Van de khong chi la VU count, ma la THIET KE SCRIPT
  -> sleep(0.14s) trong open model la nguyen nhan goc
```

---

## 11. Dashboard 3-chart reading guide

### Chart 1: Active VUs

**Default run**:

```text
Active VUs chart:
  - Khoi dau: 25 VUs (preAllocated)
  - Giai doan 1 (0-15s): 25-28 VUs (normal traffic, du VU)
  - Giai doan 2 (15-35s): TANG MANH 28 -> 45 (peak 8/s, async job chong lan)
  - Giai doan 3 (35-50s): GIAM DAN 45 -> 30 (cooldown, async job ton dong)
  - Giai doan 4 (50-55s): 30 -> 0 (drain, VU duoc giai phong)
  
  Active VU max = 45 (vuot preAllocated=25 nhung CHUA dat maxVUs=80)
  -> VU pool da duoc mo rong tu 25 len 45 de chiu ap luc async wait
  -> Nhung van khong du -> drop xay ra
```

**Rerun (pre=60, max=120)**:

```text
Active VUs chart:
  - Khoi dau: 60 VUs (preAllocated)
  - Giai doan 1 (0-15s): 60-61 VUs (du VU ngay tu dau)
  - Giai doan 2 (15-35s): TANG 61 -> 62 (chi tang them 1-2 VU nua)
  - Giai doan 3 (35-50s): GIAM DAN 62 -> 60
  - Giai doan 4 (50-55s): 60 -> 0
  
  Active VU max = 62, vus_max = 63
  -> VU pool gan nhu khong can mo rong them (60 -> 62)
  -> Nhung van drop 3 -> sleep() van gay ap luc du nhieu VU
```

**Y nghia**:

```text
VU pool expansion: preAllocated -> active VU max
  - Default: 25 -> 45 (tang 80%)
  - Rerun: 60 -> 62 (tang 3.3%)
  
Khi preAllocated da du lon, VU pool gan nhu khong can expand.
Nhung sleep() trong script VAN gay drop vi:
  - Moi async event giu VU 0.14s+
  - 8/s peak x 0.4 async x 0.14s+ = it nhat 0.45 VUs bi giu lien tuc
  - Voi tail latency (p95=9s), mot so VU bi giu hang giay
  - Du preAllocated lon, drop van co the xay ra o thoi diem nhieu async overlap
```

### Chart 2: Execution timeline (iterations vs time)

**Default run**:

```text
Execution timeline:
  - Scheduled curve (duong mau xanh): 220 slots theo ramp 1->3->8->2->0/s
  - Completed curve (duong mau cam): 199 iterations
  - Gap giua scheduled va completed: 20 dropped iterations
  
  Vung lech lon nhat: giai doan 2 (15-35s, peak 8/s)
  -> Drop tap trung o peak stage
  -> Khop voi du doan: peak la giai doan kho nhat
```

**Rerun (pre=60, max=120)**:

```text
Execution timeline:
  - Scheduled curve: 220 slots
  - Completed curve: 216 iterations
  - Gap: 3 dropped iterations
  
  Vung lech: nho hon nhieu, nhung van ton tai o giai doan peak
  -> Tang VU GIAM drop nhung KHONG LOAI BO duoc hoan toan
```

**Cach doc**:

```text
1. Tim khoang cach giua duong scheduled va completed
2. Xac dinh vung lech lon nhat -> giai doan nao gay drop nhieu nhat
3. Doi chieu voi VU chart: tai vung lech, VU co dat max khong?
4. Neu VU dat max + van lech -> can tang maxVUs HOAC giam event duration
5. Neu VU chua dat max nhung van lech -> dispatcher khong spawn kip -> can tang preAllocatedVUs
```

### Chart 3: Response time (event duration vs HTTP duration)

**Default run**:

```text
Response time trends:
  - event_duration p95 = 9010ms (9.01s) <- FULL event flow
  - http_req_duration p95 = 8510ms (8.51s) <- HTTP calls only
  
  Chenh lech: 9010 - 8510 = 500ms (processing + wait overhead)
  
  Nhung http_req_duration p95 CAO BAT THUONG (8.51s)!
  Moi HTTP call chi ~2ms -> sao p95 lai 8.51s?
  
  Giai thich: http_req_duration p95 do CHO RESPONSE,
  khong phai do xu ly. Khi nhieu concurrent request,
  request xep hang o server -> thoi gian cho lau.
  
  Event duration p95 = 9.01s bao gom CA wait (sleep) VA http time.
  http_req_duration p95 = 8.51s bao gom CA thoi gian cho response.
```

**Rerun (pre=60, max=120)**:

```text
Response time trends:
  - event_duration p95 = 9250ms (9.25s) <- TANG nhe so voi default
  - http_req_duration p95 = 8890ms (8.89s) <- TANG so voi default
  
  NGHICH LY: Tang VU gap 2.4 lan (25->60 pre) nhung p95 LAI TANG!
  
  Giai thich: Nhieu VU hon -> it drop hon -> nhieu request den server hon
  -> Server chiu tai nhieu hon -> moi request cham hon -> p95 tang!
  
  Day la hieu ung "self-limiting": khi ban them VU, backend chiu them tai,
  moi event lau hon, nen VU pool van khong du.
```

### Executor tab verification

Tren dashboard, vao tab "Executor" de xac nhan:

```text
case_id: rar-05-report-job-ingress-ramp
business_case: report_job_ingress_ramp
executor: ramping-arrival-rate
startRate: 1
stages: [{target:3,duration:15s}, {target:8,duration:20s}, {target:2,duration:15s}, {target:0,duration:5s}]
preAllocatedVUs: 25 (hoac 60 neu rerun)
maxVUs: 80 (hoac 120 neu rerun)
Base URL: http://localhost:8088 (hoac http://localhost:80 neu rerun)
```

---

## 12. 4 output -> decision scenarios

### Scenario A: Default run -- FAIL

**Config**: preAllocatedVUs=25, maxVUs=80, maxDropped=0, ready_after_ms=120

**Output**:

| Metric | Value | Threshold | Result |
| --- | ---: | ---: | --- |
| iterations | 199 | -- | -- |
| dropped_iterations | **20** | <=0 | **FAIL** |
| http_reqs | 278 | -- | -- |
| checks | 100% | >99% | Pass |
| http_req_failed | 0% | <1% | Pass |
| events_failed | 0 | <5 | Pass |
| event_duration p95 | 9.01s | -- | -- |
| http_req_duration p95 | 8.51s | -- | -- |
| active VU max | 45 | -- | -- |
| vus_max | 45 | -- | -- |

**Decision**: **FAIL**. 20 arrivals bi drop, vuot threshold maxDropped=0.

**Phan tich**:

```text
Dau hieu:
  - checks=100%, http_req_failed=0%, events_failed=0
    -> Tat ca request duoc phuc vu deu OK
    -> KHONG CO LOI NAO trong qua trinh xu ly
  - Nhung dropped_iterations=20 > 0
    -> 20 arrivals khong bao gio duoc phuc vu
    -> Day la CAPACITY failure, khong phai CORRECTNESS failure

Hanh dong:
  1. Xac nhan VU pool da du lon chua -> active VU max=45, maxVUs=80 -> con room
     Nhung dispatcher khong spawn du nhanh -> preAllocated qua thap
  2. Tang preAllocatedVUs tu 25 len 60 -> rerun
  3. Dieu tra event_duration p95=9.01s:
     - Tai sao cao the? Async job queue? Backend qua tai?
     - Co the giam ready_after_ms? Toi uu async path?
  4. Xem xet chap nhan drop budget > 0 neu SLO cho phep
```

---

### Scenario B: Rerun voi pre=60, max=120 -- STILL FAIL

**Config**: preAllocatedVUs=60, maxVUs=120, maxDropped=0, ready_after_ms=120

**Output**:

| Metric | Value | vs Default | Threshold | Result |
| --- | ---: | ---: | ---: | --- |
| iterations | 216 | +17 | -- | -- |
| dropped_iterations | **3** | -17 (85% giam) | <=0 | **FAIL** |
| http_reqs | 296 | +18 | -- | -- |
| checks | 100% | -- | >99% | Pass |
| http_req_failed | 0% | -- | <1% | Pass |
| events_failed | 0 | -- | <5 | Pass |
| event_duration p95 | 9.25s | +0.24s | -- | -- |
| http_req_duration p95 | 8.89s | +0.38s | -- | -- |
| active VU max | 62 | +17 | -- | -- |
| vus_max | 63 | +18 | -- | -- |

**Decision**: **STILL FAIL**. 3 arrivals van bi drop du da tang VU gap 2.4 lan.

**Phan tich sau**:

```text
Tang VU tu 25/80 len 60/120:
  - Drop GIAM 85% (20 -> 3)
  - Nhung KHONG LOAI BO hoan toan
  - event_duration p95 TANG (9.01s -> 9.25s)
  
NGUYEN NHAN GOC KHONG PHAI LA THIEU VU:
  - sleep(0.14s) trong script la nguon goc cua VU pressure
  - Trong open model, bat ky sleep nao cung giu VU idle
  - Du co 1000 VU, neu 1000 async job cung chay 1 luc -> tat ca VU bi giu
  
Giai phap dung:
  1. Xoa sleep() trong script -> async job chi con POST + GET (khong wait)
  2. Hoac giam ready_after_ms xuong (vi du 10ms thay vi 120ms)
  3. Hoac tach async job ra scenario rieng voi drop budget rieng
  4. Hoac chap nhan drop budget = 5 (xem Scenario C)
```

---

### Scenario C: Chap nhan drop budget = 5 -- PASS (relaxed SLO)

**Config**: preAllocatedVUs=60, maxVUs=120, **maxDropped=5**, ready_after_ms=120

**Output**:

| Metric | Value | Threshold | Result |
| --- | ---: | ---: | --- |
| iterations | 216 | -- | -- |
| dropped_iterations | **3** | <=5 | **PASS** |
| checks | 100% | >99% | Pass |
| http_req_failed | 0% | <1% | Pass |

**Decision**: **PASS**. 3 drops nam trong budget 5, SLO duoc dap ung.

**Phan tich**:

```text
Day la cach tiep can thuc te nhat cho nhieu to chuc:
  - Khong phai moi service deu can SLO 100% arrivals
  - 3/220 = 1.4% drop rate co the chap nhan duoc
  - Trade-off: chap nhan drop nho de tranh qua dau tu VU

Nhung PHAI清醒:
  - Day la "ha SLO", khong phai "sua van de"
  - Drop van xay ra -> user van bi anh huong (du it)
  - Neu SLO yeu cau zero-drop (vi du: thanh toan, dat hang) -> khong the dung cach nay
```

---

### Scenario D: Xoa sleep() -- Hypothetical PASS

**Config**: preAllocatedVUs=25, maxVUs=80, maxDropped=0, **bo sleep() trong async branch**

**Output (du doan)**:

| Metric | Gia tri du doan | Giai thich |
| --- | ---: | --- |
| iterations | ~220 | Gan target slots |
| dropped_iterations | **0** | Khong con sleep giu VU |
| event_duration p95 | ~5-10ms | Chi con POST + GET, khong wait |
| active VU max | ~1-2 | VU quay vong cuc nhanh |

**Decision**: **PASS**. Khong con drop, tat ca arrivals duoc phuc vu.

**Phan tich**:

```text
Day la MINH CHUNG cho thay sleep() la nguyen nhan GOC:
  - Khi bo sleep, event_duration giam tu 9010ms -> ~5ms (giam 1800x!)
  - VU khong con bi giu -> quay vong nhanh -> khong drop
  - Du chi can 1-2 VU la du cho 8/s peak

Nhung trong thuc te, VIEc BO SLEEP co y nghia gi?
  - sleep(0.14s) mo phong viec CHO JOB READY
  - Trong production, client THAT se cho (browser giu connection)
  - Neu bo sleep -> test khong con mo phong dung hanh vi nguoi dung
  
Giai phap tot hon:
  - Dung 2 scenario rieng: 1 cho dashboard, 1 cho async job
  - Scenario async job co the dung shared-iterations (closed model)
    hoac constant-arrival-rate voi rate thap hon + drop budget cao hon
  - Hoac dung `async` pattern (neu k6 ho tro) de khong giu VU khi wait
```

### Tong hop 4 scenarios

| Scenario | Config | Drop | p95 | Verdict | Lesson |
| --- | --- | ---: | ---: | --- | --- |
| A - Default | pre=25, max=80, drop=0 | 20 | 9.01s | FAIL | VU pool qua nho, drop tap trung peak |
| B - Rerun | pre=60, max=120, drop=0 | 3 | 9.25s | FAIL | Tang VU giup giam 85% drop nhung khong triet de |
| C - Relaxed | pre=60, max=120, drop=5 | 3 | 9.25s | PASS | Chap nhan drop budget la cach thuc te |
| D - No sleep | pre=25, max=80, drop=0 | 0 | ~5ms | PASS | Sleep() la nguyen nhan goc cua moi van de |

---

## 13. Nghich ly / misconceptions

### Nghich ly 1: "checks=100% ma test fail?"

```text
Day la NGHICH LY COT LOI cua case nay.

checks = 100%: Tat ca nhung request NAO DUOC TAO deu OK.
Nhung 20 arrivals KHONG BAO GIO DUOC TAO REQUEST.

checks chi danh gia CORRECTNESS cua nhung gi da chay.
dropped_iterations danh gia COMPLETENESS cua viec thuc thi hop dong.

Trong open model:
  - "All green metrics" != "Contract met"
  - Phai doc dropped_iterations TRUOC, roi moi doc checks
  - Drop la PRIMARY pass/fail signal
```

### Nghich ly 2: "Tang VU len 60/120 van drop?"

```text
Tang preAllocatedVUs tu 25 len 60 (tang 2.4x).
Tang maxVUs tu 80 len 120 (tang 1.5x).

Ket qua: Drop giam 85% (20 -> 3) nhung KHONG ve 0.

Vi sao? Vi sleep(0.14s) trong open model la "VU sink":
  - Moi async job giu VU it nhat 0.14s
  - Tai peak 8/s, 3.2 async jobs/s
  - 3.2 x 0.14 = 0.45 VUs bi giu moi giay
  - Neu 1 async job cham 9s -> 1 VU bi giu 9s
  - Trong 9s do, ~72 arrivals moi duoc schedule
  - Du co 120 VU, neu 120 async job cung cham -> van drop

BAI HOC: Tang VU la giai phap "mo rong be chua", khong phai "sua ong nuoc rò ri".
        Phai giam event duration hoac thay doi thiet ke script.
```

### Nghich ly 3: "8/s peak thap hon case 06 (36/s) nhung drop nhieu hon"

```text
rar-06: peak 36/s, drop=0
rar-05: peak 8/s, drop=20

So sanh truc tiep ve arrival rate -> rar-06 "kho hon" 4.5x.
Nhung thuc te rar-05 "kho hon" rat nhieu.

Nguyen nhan:
  rar-06: 1 call/event, khong sleep, W_p95 ~ 5ms
  rar-05: 1.4 calls/event, co sleep 0.14s, W_p95 = 9010ms
  
  rar-06 required_vus = 36 x 0.005 = 0.18 VU
  rar-05 required_vus = 8 x 9.01 = 72.1 VU (gap 400x!)

BAI HOC: Arrival rate khong phai la yeu to DUY NHAT quyet dinh do kho.
        Event duration (dac biet la p95) moi la yeu to chi phoi.
        Mot case 8/s + async co the kho gap 400 lan case 36/s don gian.
```

### Nghich ly 4: "http_req_duration thap nhung event_duration cao?"

```text
http_req_duration p95 = 8.51s
event_duration p95 = 9.01s

Ca hai deu CAO, nhung event_duration > http_req_duration.

Day la vi:
  - event_duration = http time + wait time + processing
  - wait time = 0.14s (sleep) + thoi gian cho response
  - http_req_duration CHI do thoi gian HTTP request/response
  - sleep() nam NGOAI http_req_duration

Mot event async_job co the co:
  - POST: http_req_duration = 2ms (nhanh)
  - sleep: 140ms (KHONG duoc do trong http_req_duration)
  - GET: http_req_duration co the rat cao (8.5s!) neu server queue day
  - Tong event_duration = 2ms + 140ms + 8500ms = 8642ms

http_req_duration trung binh co the THAP (vi nhieu dashboard GET nhanh)
nhung event_duration trung binh CAO (vi async job co wait)

BAI HOC: Trong open model, http_req_duration la METRIC SAI cho sizing VU.
        Phai dung event_duration.
```

### Nghich ly 5: "Tang VU nhung p95 lai tang?"

```text
Default (pre=25): p95 event_duration = 9.01s
Rerun (pre=60):   p95 event_duration = 9.25s  (+2.7%)

Nghich ly: Tang VU -> nhieu request duoc xu ly hon -> server chiu tai nhieu hon
          -> moi request CHAM HON -> p95 tang.

Day la hieu ung "self-limiting" trong performance test:
  - Khi ban them VU, backend chiu them tai
  - W = f(concurrency) = W_base + alpha x concurrency
  - Khi concurrency tang -> W tang -> can them VU nua
  - Vong luan quan: them VU -> backend cham -> can them VU -> ...

BAI HOC: Khong phai luc nao "them VU" cung la giai phap.
        Den 1 nguong nao do, phai toi uu backend (giam W_base)
        chu khong phai tang VU mai mai.
```

---

## 14. Checklist

### Pre-run checklist

```text
[ ] Da set RAR_05_BASE_URL (default: http://localhost:8088)
[ ] Backend report service dang chay o target URL
[ ] Endpoint /api/sim/report hoat dong
[ ] Endpoint /api/sim/report/jobs hoat dong (POST + GET)
[ ] Da hieu maxDropped=0 la STRICT contract
[ ] Da hieu sleep(0.14s) se gay VU pressure
[ ] Dashboard da san sang nhan data (neu push to cloud)
```

### Post-run verification checklist

```text
[ ] Doc dropped_iterations TRUOC TIEN
[ ] Neu dropped > 0 -> FAIL, bat ke checks
[ ] So sanh iterations + dropped vs target slots (220)
[ ] Kiem tra http_reqs ~ iterations x 1.4
[ ] Kiem tra request breakdown: dashboard + create + status
[ ] Kiem tra active VU max vs preAllocated
[ ] Kiem tra event_duration p95 (bao gom wait)
[ ] Kiem tra http_req_duration p95 (khong bao gom wait)
[ ] Xac nhan case_id, business_case tren executor tab
```

### Decision checklist

```text
[ ] Dropped = 0? -> PASS: He thong du capacity
[ ] Dropped > 0 va maxDropped > 0? -> PASS neu drop trong budget
[ ] Dropped > 0 va maxDropped = 0? -> FAIL: Can dieu tra
[ ] Neu FAIL:
    [ ] Active VU max < maxVUs? -> Tang preAllocatedVUs
    [ ] Active VU max == maxVUs? -> Tang maxVUs HOAC toi uu backend
    [ ] event_duration p95 cao? -> Toi uu async path HOAC giam ready_after_ms
    [ ] sleep() trong script? -> Can nhac bo sleep hoac tach scenario
[ ] Kiem tra: co phai "silent failure" khong? (checks pass nhung drop > 0)
```

---

## 15. 4-5 variations

### Variation 1: Bo sleep() -- pure async without wait

```powershell
# Sua script: comment hoac xoa dong wait()
$env:RAR_05_BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

**Thay doi trong script**:

```js
// async_job branch - KHONG wait
const create = requestJson('POST', `${TARGET_URL}/api/sim/report/jobs?...`, ...);
const jobId = create.ok ? responseJson(create.response, 'data.job_id', '') : '';
if (jobId) {
  // wait((READY_AFTER_MS + 20) / 1000);  // <-- COMMENT DONG NAY
  const status = requestJson('GET', `${TARGET_URL}/api/sim/report/jobs/${jobId}?...`, ...);
  ok = ok && status.ok;
}
```

**Du doan ket qua**:

```text
iterations ~ 220
dropped_iterations = 0
event_duration p95 ~ 5-10ms (chi con POST + GET)
active VU max ~ 1-2
vus_max ~ 1-2

-> PASS de dang voi config mac dinh
-> MINH CHUNG sleep() la nguyen nhan goc
```

**Khi nao dung**: Khi muon test throughput cua rieng HTTP layer, khong quan tam den viec cho async job ready. Hoac khi backend da duoc toi uu de job ready trong <1ms.

---

### Variation 2: Giam ready_after_ms -- faster async

```powershell
$env:RAR_05_READY_AFTER_MS = "10"  # Giam tu 120ms -> 10ms
$env:RAR_05_BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

**Y nghia**:

```text
ready_after_ms = 10: Job "san sang" chi sau 10ms (thay vi 120ms)
wait time = (10 + 20) / 1000 = 0.03s (thay vi 0.14s)

Event duration async:
  - Truoc: POST(2ms) + wait(140ms) + GET(2ms) = 144ms
  - Sau:   POST(2ms) + wait(30ms) + GET(2ms) = 34ms (giam 76%)

required_vus tai peak:
  - Truoc: 8 x 0.0594 = 0.48 VU (avg), 8 x 9.01 = 72.1 VU (p95)
  - Sau:   8 x 0.0264 = 0.21 VU (avg), 8 x ? = ? VU (p95, phu thuoc backend)
```

**Du doan ket qua**: Drop giam dang ke, co the ve 0 neu backend du khoe.

**Khi nao dung**: Khi backend thuc te co thoi gian job processing nhanh. Day la cach "toi uu backend" thay vi "tang VU".

---

### Variation 3: Separate scenario cho async job

```powershell
# Tao script moi: rar-05b-separate-async.js
# Scenario 1: ramping-arrival-rate cho dashboard (60% traffic, 0 drop budget)
# Scenario 2: ramping-arrival-rate cho async_job (40% traffic, drop budget=5)
```

**Thiet ke**:

```js
export const options = {
  scenarios: {
    dashboard_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 0.6,  // 60% cua 1/s
      stages: [
        { target: 1.8, duration: '15s' },   // 60% cua 3/s
        { target: 4.8, duration: '20s' },   // 60% cua 8/s
        { target: 1.2, duration: '15s' },   // 60% cua 2/s
        { target: 0, duration: '5s' },
      ],
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'dashboardOnly',
    },
    async_job_ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 0.4,  // 40% cua 1/s
      stages: [
        { target: 1.2, duration: '15s' },   // 40% cua 3/s
        { target: 3.2, duration: '20s' },   // 40% cua 8/s
        { target: 0.8, duration: '15s' },   // 40% cua 2/s
        { target: 0, duration: '5s' },
      ],
      preAllocatedVUs: 30,
      maxVUs: 80,
      exec: 'asyncJobOnly',
    },
  },
  thresholds: {
    'dropped_iterations{scenario:dashboard_ramp}': ['count<=0'],     // strict
    'dropped_iterations{scenario:async_job_ramp}': ['count<=5'],     // relaxed
  },
};
```

**Loi ich**:

```text
1. Dashboard va async job co VU pool RIENG -> khong canh tranh VU
2. Dashboard co drop budget = 0 (quan trong, nguoi dung khong duoc thay loi)
3. Async job co drop budget = 5 (chap nhan duoc, job co the retry)
4. Co the tuning rieng preAllocated, maxVUs cho tung loai traffic
5. Dashboard chi can 5-10 VU, async job can 30-80 VU
```

---

### Variation 4: Smoke test (scale=0.2)

```powershell
$env:RAR_05_DURATION_SCALE = "0.2"  # Rut ngan 5x
$env:RAR_05_BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

**Thay doi**:

```text
DURATION_SCALE = 0.2:
  Giai doan 1: 3s thay vi 15s
  Giai doan 2: 4s thay vi 20s
  Giai doan 3: 3s thay vi 15s
  Giai doan 4: 1s thay vi 5s
  Tong: 11s thay vi 55s

Target slots giam 5x: 220 -> ~44 slots
  Giai doan 1: (1+3)/2 x 3 = 6
  Giai doan 2: (3+8)/2 x 4 = 22
  Giai doan 3: (8+2)/2 x 3 = 15
  Giai doan 4: (2+0)/2 x 1 = 1
  Total = 44 slots
```

**Muc dich**: Kiem tra nhanh script hoat dong, backend san sang, khong quan tam den drop.

---

### Variation 5: Relaxed drop budget

```powershell
$env:RAR_05_MAX_DROPPED = "5"  # Chap nhan 5 drop
$env:RAR_05_BASE_URL = "http://localhost:8088"
k6 run "E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js"
```

**Y nghia**:

```text
maxDropped=5: Chap nhan toi da 5/220 = 2.3% drop rate.

Voi default VU pool (pre=25, max=80):
  drop=20 > 5 -> van FAIL

Voi expanded VU pool (pre=60, max=120):
  drop=3 <= 5 -> PASS (xem Scenario C)
  
Day la cach tiep can "thuc te": khong phai service nao cung can SLO 100%.
```

---

## 16. Anti-patterns

### Anti-pattern 1: sleep() trong open-model scripts

```text
Sai: Dung sleep() de "cho async job ready" trong ramping-arrival-rate script.

Dung: Neu can wait, hay su dung 1 trong cac cach sau:
  1. Tach scenario rieng cho async job (xem Variation 3)
  2. Dung polling loop voi timeout (thay vi sleep co dinh):
     for (let i = 0; i < 10; i++) {
       const status = requestJson('GET', `.../jobs/${jobId}`, ...);
       if (status.response.json('data.status') === 'completed') break;
       sleep(0.01);  // Poll moi 10ms, thay vi wait 140ms
     }
  3. Giam ready_after_ms de wait ngan hon
  4. Chap nhan drop budget cao hon cho async scenario
```

### Anti-pattern 2: Zero-drop budget tren async workloads

```text
Sai: Dat maxDropped=0 cho scenario co async job + sleep.

Dung: 
  1. Neu SLO that su yeu cau zero-drop -> PHAI bo sleep hoac toi uu backend
  2. Neu SLO cho phep drop nho -> dat maxDropped = ty le chap nhan duoc
     Vi du: 1% drop rate -> maxDropped = 220 x 0.01 = 2 (lam tron len 3)
  3. Dat maxDropped rieng cho tung scenario (sync vs async)
```

### Anti-pattern 3: Shared VU pool cho sync + async traffic

```text
Sai: Dung chung 1 scenario cho ca dashboard (nhanh) va async job (cham).

Hau qua: Head-of-line blocking -- async job giu VU lau,
        dashboard event khong tim duoc VU (du chi can 1-5ms).

Dung: Tach 2 scenario rieng:
  - Scenario dashboard: preAllocatedVUs nho (5-10), maxDropped=0
  - Scenario async_job: preAllocatedVUs lon (30-80), maxDropped>=0
```

### Anti-pattern 4: Dung http_req_duration de sizing VU

```text
Sai: Lay http_req_duration lam W de tinh required_vus.

Vi du: http_req_duration avg = 7.61ms
       required_vus = 8 x 0.00761 = 0.06 VU -> "Qua du, chi can 1 VU!"
       -> SAI HOAN TOAN

Dung: Phai dung event_duration (ramping_arrival_event_duration_ms).
  event_duration = http time + wait time + processing
  event_duration avg = 3603ms
  required_vus = 8 x 3.603 = 28.8 VU
  event_duration p95 = 9010ms
  required_vus_p95 = 8 x 9.01 = 72.1 VU
```

### Anti-pattern 5: Chi nhin checks de ket luan pass/fail

```text
Sai: checks=100%, http_req_failed=0% -> "Test pass!"

Dung: Trong open model, dropped_iterations la PRIMARY signal.
  1. Doc dropped_iterations TRUOC
  2. Neu drop > threshold -> FAIL (bat ke checks)
  3. Neu drop <= threshold -> moi xem checks va http_req_failed
  4. Ca 3 deu OK -> PASS
```

### Anti-pattern 6: Tang VU vo han thay vi toi uu script

```text
Sai: "Drop 20 -> tang maxVUs len 200 -> drop 10 -> tang len 500 -> ..."

Dung: Xac dinh nguyen nhan goc:
  - Co phai do sleep()? -> Bo sleep hoac giam wait
  - Co phai do backend cham? -> Toi uu backend
  - Co phai do bimodal distribution? -> Tach scenario
  - Co phai do preAllocated qua thap? -> Tang preAllocated (khong phai maxVUs)
```

---

## 17. Real validation data

### Default run (preAllocatedVUs=25, maxVUs=80)

```text
Run ID: rar-05 default
Script: rar-05-report-job-ingress-ramp.js
Target: http://localhost:8088 (report target rieng)
Exit code: 0
```

| Metric | Value |
| --- | ---: |
| `iterations` | 199 |
| `dropped_iterations` | **20** |
| `http_reqs` | 278 |
| `checks_rate` | 1.00 (100%) |
| `http_req_failed_rate` | 0.00 (0%) |
| `ramping_arrival_events_failed` | 0 |
| `ramping_arrival_event_duration_ms p95` | 9010ms (9.01s) |
| `http_req_duration p95` | 8510ms (8.51s) |
| `active VU max` | 45 |
| `vus_max` | 45 |
| `ramping_arrival_api_calls_total` | 278 |

**Request breakdown**:
```text
report_job_ramp_dashboard  GET 200  count=139
report_job_ramp_create     POST 202 count=80
report_job_ramp_status     GET 200  count=80
```

**Stage math reconciliation**:
```text
Target: 220 slots
Completed: 199
Dropped: 20
199 + 20 = 219 ~ 220 ✅ (1 slot unaccounted: boundary micro-timing)
```

**Verdict: FAIL** -- dropped_iterations=20 > maxDropped=0. Khong dat zero-drop contract.

---

### Rerun (preAllocatedVUs=60, maxVUs=120)

```text
Run ID: rar-05 rerun
Script: rar-05-report-job-ingress-ramp.js
Target: http://localhost:80 (qua unified load target)
Env: RAR_05_PREALLOCATED_VUS=60, RAR_05_MAX_VUS=120
Exit code: 0
```

| Metric | Value |
| --- | ---: |
| `iterations` | 216 |
| `dropped_iterations` | **3** |
| `http_reqs` | 296 |
| `checks_rate` | 1.00 (100%) |
| `http_req_failed_rate` | 0.00 (0%) |
| `ramping_arrival_events_failed` | 0 |
| `ramping_arrival_event_duration_ms p95` | 9250ms (9.25s) |
| `http_req_duration p95` | 8890ms (8.89s) |
| `active VU max` | 62 |
| `vus_max` | 63 |
| `ramping_arrival_api_calls_total` | 296 |

**Request breakdown**:
```text
report_job_ramp_dashboard  GET 200  count=148
report_job_ramp_create     POST 202 count=74
report_job_ramp_status     GET 200  count=74
```

**Stage math reconciliation**:
```text
Target: 220 slots
Completed: 216
Dropped: 3
216 + 3 = 219 ~ 220 ✅
```

**Verdict: STILL FAIL** -- dropped_iterations=3 > maxDropped=0. Tang VU 2.4x giup giam 85% drop nhung van khong dat zero-drop contract. Van de nam o sleep() + async pattern, khong phai o VU count.

---

### So sanh 2 runs

| Metric | Default | Rerun | Delta |
| --- | ---: | ---: | --- |
| Config (pre/max) | 25 / 80 | 60 / 120 | +140% / +50% |
| Iterations | 199 | 216 | +17 (+8.5%) |
| Dropped | 20 | 3 | -17 (-85%) |
| HTTP reqs | 278 | 296 | +18 (+6.5%) |
| Event p95 | 9.01s | 9.25s | +0.24s (+2.7%) |
| HTTP p95 | 8.51s | 8.89s | +0.38s (+4.5%) |
| Active VU max | 45 | 62 | +17 (+37.8%) |
| vus_max | 45 | 63 | +18 (+40%) |
| Result | FAIL | FAIL | -- |

### Day la case hoc tap quan trong nhat

```text
Trong toan bo series ramping-arrival-rate, rar-05 la case co gia tri giang day cao nhat:

1. No day rang checks=100% + http_req_failed=0% KHONG DU de PASS
2. No day rang dropped_iterations LA PRIMARY SIGNAL trong open model
3. No day rang tang VU khong phai la "vien dan bac" -- co the giam drop nhung khong triet de
4. No day rang sleep() trong open model la CON DAO 2 LUOI: mo phong dung hanh vi nguoi dung nhung gay VU pressure
5. No day rang bimodal event duration la ke thu tham lang cua VU pool
6. No day rang tail latency (p95) quyet dinh VU sizing, khong phai avg
7. No day rang co nhieu giai phap cho cung 1 van de:
   - Tang VU (tam thoi)
   - Bo sleep (thay doi script)
   - Tach scenario (thiet ke lai)
   - Chap nhan drop budget (thay doi SLO)
   - Giam ready_after_ms (toi uu backend)
8. No cho thay moi quan he self-limiting: tang VU -> nhieu request -> backend cham -> can them VU

Sinh vien nao hieu duoc TAT CA cac bai hoc tren tu case nay
thi da nam vung ban chat cua ramping-arrival-rate executor.
```

---

## Reference

- Run guide: `./RUN_GUIDE.md`
- Overview: `./00_overview.md`
- Validation and chart analysis: `./08_validation-and-chart-analysis.md`
- Parallel case (constant-arrival-rate): `../constant-arrival-rate/05_report-api-ingress.md`
- Source: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\rar-05-report-job-ingress-ramp.js`
- Common helpers: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-arrival-rate\common.js`
