# ms-05 -- Report service: async job API contract

## Muc luc

1. [Tinh huong thuc te](#1-tinh-huong-thuc-te)
2. [Microservices capability duoc chung minh](#2-microservices-capability-duoc-chung-minh)
3. [Vi sao phai test o Microservices layer](#3-vi-sao-phai-test-o-microservices-layer)
4. [Topology va precondition](#4-topology-va-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: async job lifecycle](#6-service-mechanism-deep-dive-async-job-lifecycle)
7. [Request sequence flow](#7-request-sequence-flow)
8. [Key signals](#8-key-signals)
9. [Pass/fail criteria](#9-passfail-criteria)
10. [Cach chay va output mau](#10-cach-chay-va-output-mau)
11. [4 output → decision scenarios](#11-4-output--decision-scenarios)
12. [Nghich ly / misconceptions](#12-nghich-ly--misconceptions)
13. [Checklist](#13-checklist)
14. [4-5 Variations](#14-4-5-variations)
15. [Anti-patterns](#15-anti-patterns)
16. [Real validation data](#16-real-validation-data)
17. [Reference](#17-reference)

---

## 1. Tinh huong thuc te

### 1.1 Boi canh doanh nghiep

Mot batch export report: tao job → poll status → download khi ready. Report service mo hinh hoa async job pattern -- khong giong cac service khac (sync request-response), no dung 202 Accepted + polling.

Trong mot he thong thuong mai dien tu, moi cuoi ngay, bo phan kinh doanh can xuat bao cao ban hang theo tung chi nhanh. Khong phai bao cao nao cung co san -- mot so bao cao yeu cau aggregation du lieu tu nhieu bang, join phuc tap, hoac dinh dang PDF/Excel can thoi gian render. Neu API giu connection mo trong suot qua trinh xu ly (30-60 giay), no se tieu ton tai nguyen server (thread, connection pool) va de bi timeout boi load balancer hoac trinh duyet.

```text
Report export: create job → list jobs → poll status → download
```

### 1.2 Vi sao dung async pattern?

Async job pattern giai quyet van de nay bang cach:

- **Tach biet submission va execution**: Client gui yeu cau tao job, nhan ngay 202 Accepted + `job_id`. Server xu ly bat dong bo.
- **Client polling nhe**: Thay vi giu connection, client goi GET status moi vai giay -- moi request chi ton vai ms.
- **Resource-aware**: Server co the queue job, uu tien, xu ly song song, va thong bao khi hoan thanh.
- **Scalable**: Khong bi gioi han boi connection timeout. Job co the chay 5 giay hoac 5 phut.

### 1.3 Cac buoc nguoi dung thuc hien

1. **Dashboard read**: Truoc khi xuat bao cao, nguoi dung xem dashboard tong quan de chon loai bao cao can xuat.
2. **Tao job**: Chon loai bao cao (sales, inventory, hourly, daily), he thong tra ve `job_id`.
3. **List jobs**: Xem danh sach jobs dang chay va da hoan thanh.
4. **Poll status**: Kiem tra trang thai job (`queued` → `processing` → `completed` / `failed`).
5. **Download**: Khi job `completed`, tai file bao cao da render.

### 1.4 Nguoi hoc gap van de gi?

Nguoi hoc thuong quen voi sync API (request → response ngay). Gap async pattern lan dau, ho de bi:

- Nham 202 Accepted thanh 200 OK trong check -- day la loi pho bien nhat.
- Khong biet cach poll status -- gui download ngay sau create, nhan 202 vi job chua ready.
- Khong hieu lifecycle job (`queued`, `processing`, `completed`, `failed`) -- mong doi job luon completed ngay lap tuc.
- Bo qua `X-Upstream-Service` header -- khong xac nhan duoc routing den report-service.

---

## 2. Microservices capability duoc chung minh

Case nay chung minh cac capability sau cua report-service:

### 2.1 Sync read endpoints

- `GET /api/sim/report` tra ve dashboard data (sync read, tra ve ngay);
- Response envelope: `{ success: true, data: {...} }`;
- Status code: 200 OK;
- `X-Upstream-Service: report-service` tren moi response.

### 2.2 Async job endpoints

- `POST /api/sim/report/jobs` tao async job, tra ve 202 Accepted + `job_id`;
- `GET /api/sim/report/jobs` liet ke jobs (co phan trang voi `limit`);
- `GET /api/sim/report/jobs/:id` poll status (tra ve `data.status`);
- `GET /api/sim/report/jobs/:id/download` tai ket qua khi ready;
- `X-Upstream-Service: report-service` tren moi response.

### 2.3 Contract verification cu the

| Endpoint | Method | Expected Status | Expected Body | Header |
| --- | --- | --- | --- | --- |
| `/api/sim/report?cpu_ms=2&db_rows=4` | GET | 200 | `{ success: true, data: {...} }` | `X-Upstream-Service: report-service` |
| `/api/sim/report/jobs?cpu_ms=2&db_rows=2&ready_after_ms=10` | POST | **202** | `{ success: true, data: { job_id, poll_after_ms } }` | `X-Upstream-Service: report-service` |
| `/api/sim/report/jobs?limit=10&cpu_ms=1&db_rows=1` | GET | 200 | `{ success: true, data: { jobs: [...] } }` | `X-Upstream-Service: report-service` |
| `/api/sim/report/jobs/{job_id}?cpu_ms=1&db_rows=1` | GET | 200 | `{ success: true, data: { status } }` | `X-Upstream-Service: report-service` |
| `/api/sim/report/jobs/{job_id}/download?cpu_ms=1` | GET | 200 hoac 202 | Download content hoac status | `X-Upstream-Service: report-service` |

### 2.4 Khac biet voi cac service khac

Report service la service duy nhat trong stack dung **202 Accepted** pattern. Tat ca cac service khac (auth, products, cart, order) deu dung sync request-response voi 200 OK. Viec nhan dien su khac biet nay giup nguoi hoc phan biet:

- **API Gateway routing**: Van dung nhu cac service khac -- Nginx route prefix `/api/sim/report` den report-service.
- **Contract shape**: Van co envelope `{ success, data }` giong cac service khac.
- **Status code**: Khac -- 202 cho job create thay vi 200. Day la diem chinh gay nham lan.

---

## 3. Vi sao phai test o Microservices layer

### 3.1 Vi sao khong test o CDN layer?

CDN test (layer 1) xac nhan cache behavior -- response co duoc cache edge khong, TTL, bypass rules. Nhung CDN khong the xac nhan:

- Async job co thuc su duoc tao khong;
- Job lifecycle co dien ra dung khong;
- 202 Accepted co duoc tra ve dung luc khong;
- Client co the poll → download thanh cong khong.

CDN khong tham gia vao async flow -- no chi cache sync GET responses.

### 3.2 Vi sao khong test o LB layer?

LB test (layer 2) xac nhan upstream selection, routing algorithm, retry/failover. Nhung LB khong the xac nhan:

- Contract cua tung endpoint (status code, body shape);
- Async pattern correctness (202 vs 200);
- Job lifecycle traversal (`queued → processing → completed`);
- `X-Upstream-Service` header co dung service khong.

### 3.3 Vi sao phai test o Microservices layer?

Microservices layer (layer 3) la noi duy nhat co the xac nhan:

- **Routing dung**: Nginx route `/api/sim/report*` den report-service (khong phai fallback app).
- **Contract dung**: 202 Accepted cho POST job (khong phai 200), 200 cho GET report/dashboard.
- **Async lifecycle**: Job di qua du cac trang thai va hoan thanh trong thoi gian expected.
- **Cross-request state**: `job_id` tu POST job dung duoc cho GET status va GET download.

Neu layer nay sai, Redis idempotency va claim ownership ben trong order-service la vo nghia -- vi request co the da den sai service ngay tu dau.

### 3.4 Lien ket voi cac layer khac

```text
CDN (layer 1) → LB (layer 2) → Microservices (layer 3, case nay) → Redis (layer 4) → Postgres (layer 5)
```

Case nay la mot trong 7 capability proofs cua microservices layer. Sau khi hoan thanh case nay cung voi cac case per-service contract khac (ms-02 den ms-04), nguoi hoc co the tien len ms-06 (cross-service stateful flow) va ms-07 (health check).

---

## 4. Topology va precondition

### 4.1 Topology

```text
Script: ../shared-iterations/si-06-report-export-batch.js
Executor: shared-iterations
Default VUs: 8
Default jobs: 80
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Tat ca microservices cases dung `TargetLayer=full-no-cdn`:

- Khong dung `full` (co CDN) vi Varnish cache co the lam nhi eu response header va latency.
- Khong dung `lb-app` vi can du 5 microservice upstream.
- `BASE_URL=http://localhost:80` dam bao request di qua Nginx API gateway.

### 4.2 Runtime path

```text
k6 client
  → http://localhost:80
  → Nginx (API gateway)
  → /api/sim/report  → report-service:8085
  → /api/sim/report/jobs → report-service:8085
```

### 4.3 Prerequisites

Truoc khi chay case nay, can dam bao:

1. **ms-01 (gateway routing smoke) da pass**: Xac nhan Nginx route dung prefix den report-service.
2. **Infrastructure healthy**: Postgres dang chay, report-service dang chay.
3. **Topology full-no-cdn dang up**: `docker compose` profile full-no-cdn da duoc start.
4. **Không có service nao khac bi down**: Neu order-service down, khong anh huong den report case nay -- nhung health check (ms-07) nen duoc chay truoc.

### 4.4 Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_06_VUS = "8"
$env:SI_06_JOBS = "80"
$env:SI_06_SLEEP_SECONDS = "0"
```

| Env variable | Default | Y nghia |
| --- | --- | --- |
| `SI_06_VUS` | 8 | So luong VU (virtual user) chay dong thoi |
| `SI_06_JOBS` | 80 | Tong so jobs duoc tao trong dot chay |
| `SI_06_SLEEP_SECONDS` | 0 | Thoi gian sleep giua cac iteration |
| `SI_06_READY_AFTER_MS` | 100 | Thoi gian (ms) job can de hoan thanh |
| `SI_06_STATUS_POLL_INTERVAL_MS` | 25 | Thoi gian (ms) giua cac lan poll status |
| `SI_06_STATUS_TIMEOUT_MS` | 5000 | Thoi gian toi da (ms) cho job hoan thanh |

---

## 5. Script deep-dive

### 5.1 File script

Script duoc dat tai `../shared-iterations/si-06-report-export-batch.js`. No su dung executor `shared-iterations` de phan phoi 80 jobs cho 8 VUs.

### 5.2 Struct cua script

```javascript
// CASE_ID va env variables
const CASE_ID = 'si-06-report-export-batch';
const VUS = envInt('SI_06_VUS', 6);
const JOBS = envInt('SI_06_JOBS', 60);
const READY_AFTER_MS = envInt('SI_06_READY_AFTER_MS', 100);
const STATUS_POLL_INTERVAL_MS = envInt('SI_06_STATUS_POLL_INTERVAL_MS', 25);
const STATUS_TIMEOUT_MS = envInt('SI_06_STATUS_TIMEOUT_MS', 5000);
const SLEEP_SECONDS = envFloat('SI_06_SLEEP_SECONDS', 0);
```

### 5.3 Setup phase

```javascript
export function setup() {
  return {
    jobs: buildJobs(JOBS, (index) => ({
      id: `report-export-${index + 1}`,
      reportType: index % 2 === 0 ? 'sales' : 'inventory',
    })),
  };
}
```

Setup tao 80 jobs, xen ke hai loai bao cao: `sales` va `inventory`. Moi job co mot ID duy nhat (`report-export-1`, `report-export-2`, ...). Dieu nay mo phong viec nguoi dung yeu cau xuat bao cao voi cac loai khac nhau.

### 5.4 Default function: `reportExportBatch`

Day la ham chinh duoc goi cho moi job. No thuc hien 5 thao tac:

#### 5.4.1 Tao job

```javascript
const create = requestJson(
  'POST',
  `${BASE_URL}/api/sim/report/jobs?report_type=${job.reportType}&cpu_ms=2&db_rows=2&gzip_kb=4&ready_after_ms=${READY_AFTER_MS}`,
  { report_type: job.reportType, source: 'shared_iterations' },
  {
    caseId: CASE_ID,
    service: 'report-service',
    operation: 'report_job_create',
    endpoint: 'POST /api/sim/report/jobs',
    jobId: job.id,
  },
  202,  // ← 202 Accepted, KHÔNG phai 200
);
```

Day la diem quan trong nhat: `requestJson` nhan tham so cuoi cung la `202`, khong phai `200`. Neu server tra ve 200, check se fail.

#### 5.4.2 Trich xuat job_id

```javascript
let reportJobId = '';
try {
  reportJobId = create.ok ? create.response.json('data.job_id') : '';
} catch (err) {
  reportJobId = '';
}
```

`job_id` duoc trich xuat tu response body `data.job_id`. Neu `job_id` rong, script khong the thuc hien cac buoc tiep theo va danh dau job fail.

#### 5.4.3 Poll status voi waitForReportCompleted

```javascript
function waitForReportCompleted(reportJobId, job, initialPollAfterMs) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;

  if (initialPollAfterMs > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      sleep(Math.min(initialPollAfterMs, remainingMs) / 1000);
    }
  }

  while (Date.now() <= deadline) {
    const status = requestJson(
      'GET',
      `${BASE_URL}/api/sim/report/jobs/${reportJobId}?cpu_ms=1&db_rows=1`,
      null,
      { ... },
      200,
    );
    if (!status.ok) return false;

    let lifecycleStatus = '';
    try {
      lifecycleStatus = status.response.json('data.status') || '';
    } catch (err) {
      lifecycleStatus = '';
    }

    if (lifecycleStatus === 'completed') return true;
    if (lifecycleStatus !== 'processing' && lifecycleStatus !== 'queued') return false;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    sleep(Math.min(STATUS_POLL_INTERVAL_MS, remainingMs) / 1000);
  }

  return false;
}
```

Ham nay thuc hien polling loop:

1. **Initial delay**: Doi `poll_after_ms` (tu response job create) truoc khi bat dau poll. Dieu nay tranh poll qua som khi job chac chan chua ready.
2. **Polling loop**: Cu moi `STATUS_POLL_INTERVAL_MS` (25ms), goi GET status.
3. **Terminal states**: `completed` → return true. `queued`/`processing` → tiep tuc poll. Bat ky trang thai nao khac → return false (job failed).
4. **Timeout**: Neu sau `STATUS_TIMEOUT_MS` (5s) job van chua completed, return false.

#### 5.4.4 Download

```javascript
if (completed) {
  const download = requestJson(
    'GET',
    `${BASE_URL}/api/sim/report/jobs/${reportJobId}/download?cpu_ms=1&gzip_kb=4`,
    null,
    {
      caseId: CASE_ID,
      service: 'report-service',
      operation: 'report_job_download',
      endpoint: 'GET /api/sim/report/jobs/:id/download',
      jobId: job.id,
    },
  );
  ok = ok && download.ok;
}
```

Chi download khi job da `completed`. Neu job chua ready, download tra ve 202 Accepted -- nhung script chi goi download sau khi `waitForReportCompleted` tra ve true.

### 5.5 Thresholds

```javascript
thresholds: {
  checks: ['rate==1'],
  http_req_failed: ['rate==0'],
  shared_jobs_total: [`count==${JOBS}`],
  shared_jobs_failed: ['count==0'],
},
```

- `checks rate==1`: 100% checks pass -- khong co job nao fail o bat ky buoc nao.
- `http_req_failed rate==0`: Khong co HTTP error.
- `shared_jobs_total count==80`: Dung 80 jobs duoc thuc thi.
- `shared_jobs_failed count==0`: Khong job nao fail.

### 5.6 Luu y ve `ready_after_ms`

Script dung `ready_after_ms=100` (ms) -- kha ngan. Dieu nay co nghia la job hoan thanh rat nhanh. Trong thuc te, `ready_after_ms` co the dai hon (500ms, 1000ms, hoac 5000ms). Tham so nay duoc truyen qua query string de report-service biet can mo phong thoi gian xu ly bao lau.

---

## 6. Service mechanism deep-dive: async job lifecycle

### 6.1 Report service architecture

Report service (port 8085) la service duy nhat trong stack co ca sync va async endpoints:

```text
Sync endpoints (tra ve ngay):
  GET /api/sim/report              — dashboard data

Async endpoints (job-based):
  POST /api/sim/report/jobs        — tao job → 202 + job_id
  GET  /api/sim/report/jobs        — list jobs
  GET  /api/sim/report/jobs/:id    — poll status
  GET  /api/sim/report/jobs/:id/download — tai ket qua
```

### 6.2 Sync vs async: so do so sanh

```text
┌─────────────── Sync Pattern ───────────────┐
│ Client → GET /api/sim/report               │
│ Server → 200 OK + { data: {...} }          │
│ Thoi gian: < 10ms                           │
└─────────────────────────────────────────────┘

┌─────────────── Async Pattern ───────────────┐
│ Client → POST /api/sim/report/jobs          │
│ Server → 202 Accepted + { job_id: "abc" }    │
│                                              │
│ Client → GET /api/sim/report/jobs/abc        │
│ Server → 200 OK + { status: "processing" }   │
│                                              │
│ Client → GET /api/sim/report/jobs/abc        │
│ Server → 200 OK + { status: "completed" }    │
│                                              │
│ Client → GET /api/sim/report/jobs/abc/download│
│ Server → 200 OK + binary/file content        │
└──────────────────────────────────────────────┘
```

### 6.3 Job lifecycle states

Moi job di qua cac trang thai:

```text
                POST /jobs
                    │
                    ▼
              ┌──────────┐
              │  queued  │  Job da duoc chap nhan, dang cho xu ly
              └────┬─────┘
                    │
                    ▼
              ┌──────────────┐
              │  processing  │  Job dang duoc xu ly (render, aggregate)
              └──────┬───────┘
                    │
              ┌─────┴─────┐
              │           │
              ▼           ▼
        ┌──────────┐  ┌────────┐
        │completed │  │ failed │
        └──────────┘  └────────┘
           │
           ▼
        GET /download
        → 200 OK + content
```

Trang thai phu:

- **queued**: Job da duoc tao, nam trong hang doi. Client nen cho `poll_after_ms` truoc khi poll.
- **processing**: Job dang duoc worker xu ly. Client tiep tuc poll.
- **completed**: Job da hoan thanh. Client co the download.
- **failed**: Job that bai (loi DB, timeout, exception). Client khong the download.

### 6.4 Tai sao 202 Accepted thay vi 200 OK?

HTTP 202 Accepted co y nghia:

> The request has been accepted for processing, but the processing has not been completed.

Khac biet chinh:

- 200 OK: "Da xu ly xong, day la ket qua."
- 202 Accepted: "Da nhan yeu cau, se xu ly sau. Day la job_id de ban theo doi."

POST job tra ve 202 (khong phai 200) -- nguoi hoc de bi nham. Day la diem khac biet quan trong giua sync read (GET report) va async create (POST jobs).

### 6.5 Polling pattern

Client khong the biet chinh xac khi nao job hoan thanh. Co hai cach tiep can:

1. **Polling (su dung trong case nay)**: Client goi GET status dinh ky (moi 25ms). Don gian, nhung ton bang thong neu poll qua thuong xuyen.
2. **Webhook/Callback**: Server goi lai client khi job hoan thanh. Hieu qua hon nhung phuc tap hon.

Script nay dung polling vi no la cach don gian nhat de verify async pattern hoat dong.

### 6.6 `poll_after_ms` hint

Response cua POST job co the bao gom `poll_after_ms` -- thoi gian toi thieu (ms) client nen cho truoc khi poll lan dau. Dieu nay tranh viec poll qua som (khi job chac chan chua ready), giam tai cho server.

```json
{
  "success": true,
  "data": {
    "job_id": "report-export-1-abc123",
    "poll_after_ms": 80
  }
}
```

### 6.7 Cap nhat tu report-service dashboard

Case nay khong chi test async job -- no con test sync dashboard read. Dashboard la GET request tra ve ngay lap tuc:

```text
GET /api/sim/report?cpu_ms=2&db_rows=4
→ 200 OK
→ { success: true, data: { summary: {...}, charts: [...] } }
```

Dashboard doc du lieu tu Postgres (4 rows) va xu ly mot chut CPU (2ms). Khong co async o day -- tat ca la sync.

---

## 7. Request sequence flow

### 7.1 Flow tong the

```text
Setup tao 80 jobs

Moi job:
  1. GET /api/sim/report?cpu_ms=2&db_rows=4
     → Expect: 200, success=true, data (dashboard)

  2. POST /api/sim/report/jobs?cpu_ms=2&db_rows=2&ready_after_ms=10
     → Body: { report_type, context }
     → Expect: 202 Accepted, success=true, data.job_id

  3. GET /api/sim/report/jobs?limit=10&cpu_ms=1&db_rows=1
     → Expect: 200, success=true, data.jobs array

  4. GET /api/sim/report/jobs/{job_id}?cpu_ms=1&db_rows=1
     → Expect: 200, success=true, data.status

  5. GET /api/sim/report/jobs/{job_id}/download?cpu_ms=1
     → Expect: 200 hoac 202 (neu job chua ready)
```

### 7.2 Flow chi tiet cho mot job

#### Buoc 1: Doc dashboard (sync read)

```text
Client: GET /api/sim/report?cpu_ms=2&db_rows=4
Nginx: route /api/sim/report → report-service:8085
Report-service: query Postgres, aggregate, return JSON
Nginx: add X-Upstream-Service=report-service
Client: Expect 200, success=true, data khong null
```

Day la sync request-response thong thuong. Khong co async, khong co polling.

#### Buoc 2: Tao job (async create)

```text
Client: POST /api/sim/report/jobs?report_type=sales&cpu_ms=2&db_rows=2&ready_after_ms=100
Body: { report_type: "sales", source: "shared_iterations" }
Nginx: route /api/sim/report/jobs → report-service:8085
Report-service: insert job row vao Postgres, queue job cho worker, return 202 + job_id
Nginx: add X-Upstream-Service=report-service
Client: Expect 202 Accepted, success=true, data.job_id khong rong
```

POST job chi tao job -- khong doi job hoan thanh. Worker se xu ly bat dong bo.

#### Buoc 3: Liet ke jobs

```text
Client: GET /api/sim/report/jobs?limit=10&cpu_ms=1&db_rows=1
Nginx: route /api/sim/report/jobs → report-service:8085
Report-service: query Postgres cho danh sach jobs, return JSON array
Nginx: add X-Upstream-Service=report-service
Client: Expect 200, success=true, data.jobs la array
```

Day la mot sync read khac -- danh sach jobs duoc doc tu Postgres.

#### Buoc 4: Poll status

```text
Client: GET /api/sim/report/jobs/{job_id}?cpu_ms=1&db_rows=1
Nginx: route /api/sim/report/jobs/:id → report-service:8085
Report-service: query Postgres cho job status, return { status: "completed" | "processing" | "queued" }
Nginx: add X-Upstream-Service=report-service
Client: Expect 200, success=true, data.status
```

Day la buoc quan trong nhat cua async flow. Client goi lai nhieu lan cho den khi `data.status === "completed"`.

#### Buoc 5: Download

```text
Client: GET /api/sim/report/jobs/{job_id}/download?cpu_ms=1&gzip_kb=4
Nginx: route /api/sim/report/jobs/:id/download → report-service:8085
Report-service: đọc file da render, return voi content type phu hop
Nginx: add X-Upstream-Service=report-service
Client: Expect 200 (job completed) hoac 202 (job chua ready)
```

Download chi thanh cong khi job completed. Neu goi download khi job dang processing, server tra ve 202.

### 7.3 So do sequence day du

```text
Client                          Nginx                       Report-service              Postgres
  │                               │                              │                          │
  │  1. GET /api/sim/report       │                              │                          │
  │──────────────────────────────►│──────────────────────────────►│                          │
  │                               │                              │──── SELECT dashboard ────►│
  │                               │                              │◄─── data rows ────────────│
  │◄── 200 + { data } ────────────│◄── 200 + X-Upstream-Service ─│                          │
  │                               │                              │                          │
  │  2. POST /api/sim/report/jobs │                              │                          │
  │──────────────────────────────►│──────────────────────────────►│                          │
  │                               │                              │──── INSERT job row ──────►│
  │                               │                              │◄─── job_id ───────────────│
  │◄── 202 + { job_id } ─────────│◄── 202 + X-Upstream-Service ─│                          │
  │                               │                              │                          │
  │                               │           ┌─ worker ─┐       │                          │
  │                               │           │ process  │       │                          │
  │                               │           │ job...   │       │                          │
  │                               │           └──────────┘       │                          │
  │                               │                              │                          │
  │  3. GET /jobs (list)          │                              │                          │
  │──────────────────────────────►│──────────────────────────────►│                          │
  │◄── 200 + { jobs: [...] } ────│◄── 200 + X-Upstream-Service ─│                          │
  │                               │                              │                          │
  │  4. GET /jobs/{id} (status)   │                              │                          │
  │──────────────────────────────►│──────────────────────────────►│                          │
  │                               │                              │──── SELECT job status ───►│
  │◄── 200 + { status } ─────────│◄── 200 + X-Upstream-Service ─│                          │
  │                               │                              │                          │
  │  (polling loop... cho den completed)                         │                          │
  │                               │                              │                          │
  │  5. GET /jobs/{id}/download   │                              │                          │
  │──────────────────────────────►│──────────────────────────────►│                          │
  │◄── 200 + binary content ─────│◄── 200 + X-Upstream-Service ─│                          │
  │                               │                              │                          │
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Y nghia | Cach doc |
| --- | --- | --- |
| `X-Upstream-Service: report-service` | Chứng minh routing dung den report-service | Co tren 100% response |
| Status 202 Accepted (POST job) | Async pattern duoc thuc thi dung | Xuat hien ~20% response |
| Status 200 OK (GET reports/status/list) | Sync endpoints hoat dong dung | Xuat hien ~80% response |
| `data.job_id` khong rong | Job duoc tao va co ID de poll | Kiem tra response body |
| `data.status` thay doi tu `queued` → `processing` → `completed` | Lifecycle job dien ra dung | Quan sat qua polling loop |

### 8.2 Secondary signals

| Signal | Y nghia |
| --- | --- |
| `poll_after_ms` trong response job create | Server hint cho client biet khi nao nen bat dau poll |
| `data.jobs[]` trong list endpoint | Danh sach jobs hien tai |
| Download content length > 0 | File bao cao co noi dung thuc su |
| Latency cua POST job > GET report | Job create co thoi gian xu ly (db write) cao hon sync read |

### 8.3 Custom metrics

| Metric | Expected | Y nghia |
| --- | --- | --- |
| `shared_jobs_total` | 80 | Tong so jobs duoc thuc thi |
| `shared_jobs_failed` | 0 | Khong job nao fail |
| `checks` | 100% (rate==1) | Tat ca checks deu pass |
| `http_req_failed` | 0.00% (rate==0) | Khong co HTTP error nao |

### 8.4 Status code distribution

```text
Khoang 20% response la 202 (POST job create)
Khoang 80% response la 200 (GET dashboard, status, list, download)
Khong co 4xx, khong co 5xx
```

Neu thay 200 cho POST job, day la fail -- async pattern khong duoc ton trong.

### 8.5 Response envelope consistency

Moi response tu report-service phai co envelope:

```json
{
  "success": true,
  "data": { ... }
}
```

Dieu nay nhat quan voi tat ca cac service khac trong stack (auth, products, cart, order). Report-service khong thay doi envelope shape -- chi khac status code cho job create.

---

## 9. Pass/fail criteria

### 9.1 Pass criteria

Tat ca cac dieu kien sau phai dong thoi dung:

1. **checks = 100%**: Tat ca k6 checks deu pass.
2. **shared_jobs_total = 80**: Dung so jobs duoc thuc thi.
3. **shared_jobs_failed = 0**: Khong job nao fail.
4. **X-Upstream-Service = `report-service`**: Tren 100% response.
5. **Sync report GET tra ve 200 + `success: true`**: Dashboard hoat dong.
6. **Job create POST tra ve 202 Accepted**: Async pattern dung.
7. **Job status GET tra ve 200 + `data.status`**: Polling hoat dong.
8. **Job download GET tra ve 200 (job completed)**: Download hoat dong.
9. **http_req_failed = 0.00%**: Khong co HTTP error.

### 9.2 Fail criteria -- tung phan

| Kiem tra | Fail neu | Nguyen nhan kha di |
| --- | --- | --- |
| Sync report GET | status != 200 | Service down, DB down, routing sai |
| Sync report GET | success != true | Contract violation |
| Job create POST | status != 202 | Service khong hieu async pattern (tra ve 200) |
| Job create POST | job_id rong | Insert DB fail, service bug |
| Job status GET | status != 200 | job_id sai, service khong tim thay job |
| Job status GET | data.status khong xac dinh | Response body sai shape |
| Polling loop | Job khong completed truoc timeout | ready_after_ms qua dai, worker khong chay |
| Download GET | status != 200 | Goi download khi job chua completed |
| X-Upstream-Service | Khong phai `report-service` | Routing sai, Nginx config sai |
| http_req_failed | > 0% | Network error, service crash |

### 9.3 Phan biet fail o layer nao

| Trieu chung | Co the la loi o... |
| --- | --- |
| X-Upstream-Service khong phai report-service | Nginx routing (layer 2-3) |
| 200 thay vi 202 cho POST job | Report-service code (layer 3) |
| Job khong completed | Report-service worker (layer 3) hoac Postgres (layer 5) |
| Download luon 202 | Job khong bao gio completed |
| success=false | Contract violation (layer 3) |
| http_req_failed > 0 | Network/DNS (layer 2) hoac service crash |

---

## 10. Cach chay va output mau

### 10.1 Cach chay co ban

```powershell
# Run trong thu muc chua script
k6 run si-06-report-export-batch.js

# Hoac tu thu muc goc cua project
k6 run shared-iterations/si-06-report-export-batch.js
```

### 10.2 Cach chay voi env knobs tuy chinh

```powershell
$env:BASE_URL = "http://localhost:80"
$env:SI_06_VUS = "4"
$env:SI_06_JOBS = "40"
$env:SI_06_READY_AFTER_MS = "200"
$env:SI_06_STATUS_TIMEOUT_MS = "10000"
k6 run si-06-report-export-batch.js
```

### 10.3 Output mau -- pass

```text
     ✓ report_job_create response status 202
     ✓ report_job_create response success is true
     ✓ report_job_status completed before timeout
     ✓ report_job_download response status 200

     checks.........................: 100.00% ✓ 320      ✗ 0
     http_req_failed................: 0.00%   ✓ 0        ✗ 320
     shared_jobs_total..............: 80      ✓ 80       ✗ 0
     shared_jobs_failed.............: 0       ✓ 0        ✗ 0

     http_req_duration..............: avg=15ms   p(95)=45ms
```

### 10.4 Output mau -- fail (job create tra ve 200 thay vi 202)

```text
     ✗ report_job_create response status 202
       ↳  95% — 76 ✓ / 4 ✗

     checks.........................: 95.00%  ✓ 304      ✗ 16
     shared_jobs_total..............: 80      ✓ 80       ✗ 0
     shared_jobs_failed.............: 4       ✓ 0        ✗ 4
```

4 jobs fail vi POST job tra ve 200 thay vi 202. Day la loi contract nghiem trong -- report-service khong hieu async pattern.

### 10.5 Output mau -- fail (job khong completed)

```text
     ✗ report_job_status completed before timeout
       ↳  90% — 72 ✓ / 8 ✗

     checks.........................: 90.00%  ✓ 288      ✗ 32
     shared_jobs_failed.............: 8       ✓ 0        ✗ 8
```

8 jobs khong hoan thanh trong thoi gian `STATUS_TIMEOUT_MS`. Nguyen nhan co the la `ready_after_ms` qua dai, worker khong chay, hoac Postgres cham.

### 10.6 Cach doc output theo thu tu uu tien

1. **Checks rate**: Neu < 100%, xem chi tiet check nao fail.
2. **shared_jobs_failed**: Neu > 0, co job khong hoan thanh.
3. **http_req_failed**: Neu > 0, co HTTP error (network, timeout).
4. **Status code distribution**: Xac nhan 202 xuat hien cho POST job.

---

## 11. 4 output → decision scenarios

### Scenario 1: Tat ca pass (checks 100%, 0 fail)

**Output**:
```text
checks=100%, shared_jobs_total=80, shared_jobs_failed=0
X-Upstream-Service=report-service 100%
202 cho POST job, 200 cho GET
```

**Quyet dinh**: Report-service hoat dong dung. Async pattern duoc implement chinh xac. Co the tien len ms-06 (cross-service stateful flow). Khong can action gi.

**Confidence**: Cao. Tat ca cac khia canh cua async contract da duoc verify.

### Scenario 2: Job create tra ve 200 thay vi 202

**Output**:
```text
checks=80%, shared_jobs_failed=16/80
POST job: 200 thay vi 202
```

**Quyet dinh**: Report-service dang tra ve sai status code. Day la bug contract -- async pattern khong duoc ton trong. Khong nen chay ms-06 (cross-service flow) vi report flow se cho ket qua sai.

**Action**:
1. Kiem tra report-service code -- POST handler co tra ve 202 khong?
2. Co the service da bi downgrade xuong sync-only.
3. Fix service code, redeploy, rerun case.

### Scenario 3: Job khong bao gio completed

**Output**:
```text
checks=75%, shared_jobs_failed=20/80
report_job_status completed before timeout: fail
download luon tra ve 202
```

**Quyet dinh**: Job duoc tao (202 Accepted) nhung khong hoan thanh. Co the worker khong chay, `ready_after_ms` qua dai so voi `STATUS_TIMEOUT_MS`, hoac Postgres bi loi.

**Action**:
1. Kiem tra report-service worker co dang chay khong.
2. Tang `STATUS_TIMEOUT_MS` (vd: 30000) neu `ready_after_ms` lon.
3. Kiem tra Postgres connection.
4. Rerun case.

### Scenario 4: X-Upstream-Service khong phai report-service

**Output**:
```text
X-Upstream-Service = "app" (fallback)
checks=50%, shared_jobs_failed=40/80
```

**Quyet dinh**: Nginx dang route sai -- request den app fallback thay vi report-service. App fallback khong hieu async pattern, tra ve 200 thay vi 202.

**Action**:
1. Kiem tra Nginx config -- `location /api/sim/report` co tro den report-service:8085 khong?
2. Kiem tra report-service co dang chay khong (neu service down, Nginx fallback den app).
3. Rerun ms-01 (gateway routing smoke) de xac nhan routing.
4. Fix Nginx config, reload, rerun case.

---

## 12. Nghich ly / misconceptions

### 12.1 "202 Accepted la loi -- API phai luon tra 200"

**Sai**. 202 Accepted la HTTP status code chuan (RFC 7231, section 6.3.3) cho async processing. 200 OK co nghia la "da xu ly xong" -- khong phu hop khi job chua hoan thanh. Dung sai status code la contract violation nghiem trong.

### 12.2 "Async pattern lam API cham hon"

**Nguoc lai**. Async pattern lam API nhanh hon ve mat response time:

- POST job: 5-10ms (chi insert vao DB, khong doi xu ly).
- GET status: 1-2ms (chi doc mot row).
- Tong thoi gian client cho: 5-10ms ban dau + thoi gian polling.

So voi sync approach (giu connection 30-60s de xu ly), async giai phong tai nguyen server va khong bi timeout.

### 12.3 "Polling la cach duy nhat de biet job hoan thanh"

**Khong**. Polling la cach don gian nhat, nhung khong phai duy nhat. Cac cach khac:

- **Webhook**: Server goi lai client khi job hoan thanh.
- **Server-Sent Events (SSE)**: Server push status updates qua persistent connection.
- **WebSocket**: Two-way communication.
- **Message queue**: Client subscribe vao completion event.

Moi cach co trade-off rieng. Polling duoc chon trong case nay vi no don gian va de verify.

### 12.4 "Neu job create tra ve 200 cung khong sao"

**Sai**. Neu job create tra ve 200 thay vi 202, client se hieu lam la "job da hoan thanh ngay lap tuc". Client se goi download ngay -- va nhan 202 (chua ready) hoac file rong. Day la contract violation gay confusion cho client.

### 12.5 "Chi can test sync dashboard, async job la phan mo rong khong quan trong"

**Sai**. Dashboard la sync read don gian. Async job pattern moi la phan phuc tap va de sai cua report-service. Neu chi test dashboard, ban bo qua toan bo async contract. Trong production, loi async job (job khong completed, download fail) anh huong truc tiep den nguoi dung.

### 12.6 "X-Upstream-Service khong can thiet cho report-service"

**Sai**. `X-Upstream-Service` la evidence duy nhat chung minh request da den dung report-service. Khong co header nay, ban khong the phan biet duoc:

- Request den report-service hay app fallback?
- App fallback co tinh co tra ve 202 khong? (Khong -- app fallback tra ve 200.)

---

## 13. Checklist

### 13.1 Pre-run checklist

- [ ] Topology `full-no-cdn` da up (docker compose).
- [ ] ms-01 (gateway routing smoke) da pass -- xac nhan routing den report-service dung.
- [ ] Postgres dang chay (neu Postgres down, job khong the duoc tao).
- [ ] Report-service dang chay (port 8085 accessible).
- [ ] BASE_URL=http://localhost:80 duoc set.
- [ ] Khong co CDN (Varnish) -- tranh cache lam nhi eu response.

### 13.2 Runtime checklist

- [ ] Checks rate = 100%.
- [ ] shared_jobs_total = so jobs da cau hinh.
- [ ] shared_jobs_failed = 0.
- [ ] http_req_failed = 0.00%.
- [ ] X-Upstream-Service = `report-service` tren 100% response.
- [ ] POST job tra ve 202 (khong phai 200).
- [ ] GET dashboard tra ve 200 + success=true.
- [ ] GET job list tra ve 200 + data.jobs array.
- [ ] GET job status tra ve 200 + data.status.
- [ ] GET download tra ve 200 (khong phai 202).
- [ ] Job lifecycle: queued → processing → completed.

### 13.3 Post-run decision checklist

- [ ] Neu checks = 100%: Pass. Tien len ms-06.
- [ ] Neu POST job tra ve 200: Fail. Kiem tra report-service code.
- [ ] Neu job khong completed: Fail. Kiem tra worker, timeout, Postgres.
- [ ] Neu X-Upstream-Service != report-service: Fail. Kiem tra Nginx routing.
- [ ] Neu http_req_failed > 0: Fail. Kiem tra network, service health.

### 13.4 Learning checklist cho nguoi hoc

- [ ] Hieu su khac biet giua sync read (GET dashboard) va async create (POST job).
- [ ] Hieu y nghia cua HTTP 202 Accepted.
- [ ] Biet cach doc `data.status` va cac trang thai lifecycle.
- [ ] Biet cach poll status cho den khi completed.
- [ ] Biet cach su dung `X-Upstream-Service` de xac nhan routing.
- [ ] Biet cach phan biet loi routing vs loi contract vs loi lifecycle.
- [ ] Biet cach dieu chinh `ready_after_ms`, `STATUS_POLL_INTERVAL_MS`, `STATUS_TIMEOUT_MS`.

---

## 14. 4-5 Variations

### Variation 1: Ready time dai (long-running job)

**Muc tieu**: Test job can thoi gian xu ly lau (vd: bao cao cuoi thang aggregate nhieu du lieu).

```powershell
$env:SI_06_READY_AFTER_MS = "5000"     # 5 giay
$env:SI_06_STATUS_TIMEOUT_MS = "15000"  # 15 giay timeout
$env:SI_06_STATUS_POLL_INTERVAL_MS = "200" # Poll moi 200ms
```

**Expected**: Job completed sau ~5s. Polling loop kiem tra nhieu lan truoc khi completed.

**Hoc duoc**: Cach dieu chinh timeout va poll interval cho long-running jobs.

### Variation 2: Nhieu loai report type

**Muc tieu**: Test da dang loai bao cao (sales, inventory, hourly, daily, monthly).

```javascript
// Trong setup, tao nhieu loai report
jobs: buildJobs(JOBS, (index) => ({
  id: `report-export-${index + 1}`,
  reportType: ['sales', 'inventory', 'hourly', 'daily', 'monthly'][index % 5],
}))
```

**Expected**: Tat ca loai bao cao deu duoc tao, poll, va download thanh cong.

**Hoc duoc**: Async pattern hoat dong cho nhieu loai job khac nhau.

### Variation 3: High concurrent jobs

**Muc tieu**: Test kha nang xu ly nhieu jobs dong thoi.

```powershell
$env:SI_06_VUS = "20"
$env:SI_06_JOBS = "200"
```

**Expected**: 200 jobs duoc xu ly. Co the co mot so job cham hon binh thuong (queue depth).

**Hoc duoc**: Gioi han cua report-service worker pool. Neu qua nhieu jobs, mot so co the timeout.

### Variation 4: Job list pagination

**Muc tieu**: Verify list endpoint phan trang dung.

```powershell
$env:SI_06_JOBS = "200"
```

Script tu dong goi GET `/api/sim/report/jobs?limit=10`. Voi 200 jobs, list endpoint phai phan trang dung.

**Expected**: List tra ve array voi limit duoc ton trong.

### Variation 5: Download khi job chua ready (negative test)

**Muc tieu**: Xac nhan service tra ve 202 khi download goi qua som.

**Chinh script**: Bo qua `waitForReportCompleted`, goi download ngay sau khi create.

**Expected**: Download tra ve 202 Accepted (chua ready). Sau `ready_after_ms`, download tra ve 200.

**Hoc duoc**: Cach service bao ve chinh no -- khong cho download khi job chua hoan thanh.

---

## 15. Anti-patterns

### 15.1 Kiem tra status code cung cho ca sync va async

**Sai**:
```javascript
// Dung cung 200 cho moi request
requestJson('POST', url, body, tags, 200); // SAI -- POST job phai la 202
requestJson('GET', url, null, tags, 200);   // DUNG
```

**Dung**:
```javascript
requestJson('POST', url, body, tags, 202);  // DUNG -- POST job tra ve 202
requestJson('GET', url, null, tags, 200);   // DUNG
```

### 15.2 Khong extract job_id, dung hardcoded ID

**Sai**:
```javascript
const jobId = 'some-hardcoded-id'; // SAI -- se fail khi rerun
```

**Dung**:
```javascript
const jobId = create.response.json('data.job_id'); // DUNG
```

### 15.3 Khong poll, goi download ngay lap tuc

**Sai**:
```javascript
const create = requestJson('POST', url, body, tags, 202);
// Khong poll -- goi download ngay
const download = requestJson('GET', downloadUrl, null, tags, 200); // Co the fail
```

**Dung**:
```javascript
const create = requestJson('POST', url, body, tags, 202);
const jobId = responseJson(create.response, 'data.job_id', '');
if (jobId) {
  const completed = waitForReportCompleted(jobId, job, pollAfterMs); // Poll truoc
  if (completed) {
    const download = requestJson('GET', downloadUrl, null, tags); // Download sau
  }
}
```

### 15.4 Polling khong co timeout

**Sai**:
```javascript
while (true) {
  const status = requestJson('GET', statusUrl, ...);
  if (status === 'completed') break;
  sleep(0.025);
}
// Co the loop vo han neu job khong bao gio completed
```

**Dung**:
```javascript
const deadline = Date.now() + STATUS_TIMEOUT_MS;
while (Date.now() <= deadline) {
  const status = requestJson('GET', statusUrl, ...);
  if (status === 'completed') return true;
  if (Date.now() > deadline) return false;
  sleep(0.025);
}
return false;
```

### 15.5 Bo qua X-Upstream-Service header

**Sai**: Khong kiem tra `X-Upstream-Service` header -- khong the xac nhan routing.

**Dung**: Moi request deu tag voi service name, va verify header trong response:

```javascript
{
  caseId: CASE_ID,
  service: 'report-service', // Tag de verify routing
  operation: 'report_job_create',
  endpoint: 'POST /api/sim/report/jobs',
}
```

### 15.6 Khong kiem tra job_id rong

**Sai**:
```javascript
const jobId = create.response.json('data.job_id');
// jobId co the la undefined/null/'' -- van tiep tuc poll
```

**Dung**:
```javascript
const jobId = responseJson(create.response, 'data.job_id', '');
if (jobId) {
  // Chi poll khi co job_id hop le
} else {
  ok = false; // Khong co job_id → fail
}
```

---

## 16. Real validation data

### 16.1 Job type distribution

Trong script, job type duoc phan bo:

```javascript
reportType: index % 2 === 0 ? 'sales' : 'inventory'
```

| Loai bao cao | So luong | Ty le |
| --- | --- | --- |
| sales | 40 | 50% |
| inventory | 40 | 50% |

### 16.2 Expected request counts

Voi 80 jobs, moi job thuc hien 4-5 requests:

| Request type | So luong toi thieu | Ghi chu |
| --- | --- | --- |
| GET /api/sim/report (dashboard) | 80 | Sync, 1 per job |
| POST /api/sim/report/jobs (create) | 80 | Async, 1 per job |
| GET /api/sim/report/jobs (list) | 80 | Sync, 1 per job |
| GET /api/sim/report/jobs/:id (status) | 80-400+ | Polling, it nhat 1, co the nhieu lan |
| GET /api/sim/report/jobs/:id/download | 80 | Sync, 1 per job (chi khi completed) |

### 16.3 Status code distribution thuc te

```text
202 Accepted: ~80 requests (POST job) — ~16-20% tong so
200 OK: ~320-400 requests (GET dashboard, status, list, download) — ~80-84% tong so
```

### 16.4 Timing baseline

Voi `ready_after_ms=100`:

| Thao tac | Thoi gian dien hinh |
| --- | --- |
| POST job | 5-15ms |
| GET dashboard | 2-8ms |
| GET status (poll) | 1-5ms |
| GET download | 3-10ms |
| Tong thoi gian 1 job | ~120-200ms (bao gom 100ms ready + polling) |

### 16.5 Polling behavior

Voi `ready_after_ms=100`, `STATUS_POLL_INTERVAL_MS=25`:

- Lan poll dau tien: sau `poll_after_ms` (~80-100ms).
- So lan poll trung binh: 2-5 lan.
- Job hoan thanh sau: 100-150ms tu luc tao.

---

## 17. Reference

### 17.1 Scripts lien quan

| Script | Executor | Muc dich |
| --- | --- | --- |
| `shared-iterations/si-06-report-export-batch.js` | shared-iterations | Async job contract (case chinh) |
| `constant-arrival-rate/car-05-report-api-ingress.js` | constant-arrival-rate | Report API voi ti le co dinh |
| `ramping-arrival-rate/rar-05-report-job-ingress-ramp.js` | ramping-arrival-rate | Report job ingress ramp test |
| `constant-vus/cv-06-backoffice-report-users.js` | constant-vus | Backoffice report users |
| `ramping-vus/rv-05-reporting-ramp.js` | ramping-vus | Reporting ramp test |

### 17.2 Cases lien quan trong microservices layer

| Case | Ten | Moi quan he |
| --- | --- | --- |
| ms-01 | Gateway routing smoke | Phai pass truoc -- xac nhan routing den report-service |
| ms-02 | Products read contract | Cung la per-service contract, sync-only |
| ms-03 | Cart write contract | Cung la per-service contract, sync-only |
| ms-04 | Order transaction contract | Cung la per-service contract, sync-only |
| ms-06 | Stateful business flow | Tich hop 5 services (bao gom report) |
| ms-07 | Service health | Health check -- kiem tra report-service dang healthy khong |

### 17.3 HTTP specifications

| RFC | Topic |
| --- | --- |
| RFC 7231, Section 6.3.3 | 202 Accepted |
| RFC 7231, Section 6.3.1 | 200 OK |
| RFC 7230, Section 6.1 | Connection management |

### 17.4 K6 concepts

| Khai niem | Y nghia |
| --- | --- |
| shared-iterations executor | Phan phoi iterations (jobs) giua cac VUs |
| buildJobs | Tao array jobs tu setup data |
| requestJson | Gui HTTP request + verify status + parse JSON |
| check | Verify dieu kien, ghi nhan pass/fail |
| Counter | Dem so lan xay ra su kien |
| thresholds | Pass/fail criteria cho toan bo test |

### 17.5 Topology reference

```text
full-no-cdn topology:
  k6 → localhost:80 → Nginx → report-service:8085 → Postgres:5432

Khong dung CDN (Varnish) de tranh cache lam nhi eu response header.
```

### 17.6 Production lesson

Async job pattern la microservices pattern quan trong: khong phai operation nao cung nen la sync. Report export, data import, batch processing -- tat ca nen dung 202 + polling thay vi giu connection mo. Case nay day cach verify contract cho async pattern: status code dung (202 khong phai 200), job ID usable, va job that su complete sau thoi gian expected.

Trong production:

- **Timeout cua load balancer**: Thuong la 30-60s. Async pattern tranh bi LB cat connection.
- **Resource pooling**: Server chi xu ly mot so jobs dong thoi (worker pool) -- tranh qua tai.
- **Retry safety**: Neu poll that bai, chi can goi lai GET status -- khong anh huong den job.
- **Observability**: Moi job co ID duy nhat de trace qua cac he thong (log, metric, tracing).
- **Client experience**: Client biet chinh xac tien do (queued/processing/completed) thay vi cho doi vo han.

Trong incident, neu report export khong hoat dong:

1. Kiem tra health check (ms-07) -- report-service va Postgres co healthy khong?
2. Kiem tra routing (ms-01) -- Nginx co route den dung report-service khong?
3. Kiem tra contract (case nay) -- async pattern co dung khong?
4. Kiem tra worker logs -- co job nao bi stuck khong?
5. Kiem tra Postgres -- connection pool co day khong?

