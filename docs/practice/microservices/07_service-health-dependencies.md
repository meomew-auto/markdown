# ms-07 -- Service health and real dependency status

## Muc luc

1. [Tinh huong thuc te](#1-tinh-huong-thuc-te)
2. [Microservices capability duoc chung minh](#2-microservices-capability-duoc-chung-minh)
3. [Vi sao phai test o Microservices layer](#3-vi-sao-phai-test-o-microservices-layer)
4. [Topology va precondition](#4-topology-va-precondition)
5. [Script deep-dive](#5-script-deep-dive)
6. [Service mechanism deep-dive: health endpoint pattern va dependency graph](#6-service-mechanism-deep-dive-health-endpoint-pattern-va-dependency-graph)
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

### 1.1 Boi canh van hanh

Truoc khi chay bat ky test nao, can xac nhan tat ca services va dependencies deu healthy. Moi microservice co `/health` endpoint bao cao trang thai cua chinh no va cac dependency (Postgres, Redis, payment URL). App-level dependency endpoint aggregate tat ca.

```text
Health check: app → tung service → tung dependency
```

Day la case dau tien nen chay trong moi incident -- neu dependency down, service degraded du business endpoint van tra 200.

### 1.2 Mot buoi sang thu Ba...

04:30 AM. DevOps nhan duoc canh bao: "order-service p95 latency tang gap 5 lan". Kiem tra dashboard, order-service van tra ve 200 OK. CPU khong cao. Memory binh thuong.

Sau 20 phut debug, ho phat hien ra: Redis da het connection pool tu 04:15 AM do mot batch job mo qua nhieu connection nhung khong dong lai. Order-service van tra 200 OK cho GET status (tu Postgres), nhung POST checkout (can Redis de luu idempotency key) thi bi treo 5 giay moi lan. Postgres van healthy, Redis van "up" (process chay) nhung khong the chap nhan connection moi.

Neu health check co **real dependency probing** (thuc su goi Redis PING, khong chi kiem tra process), incident nay da duoc phat hien luc 04:15 AM, khong phai 04:30 AM.

### 1.3 Bai hoc

Health check khong chi la "process alive" (process co dang chay khong). Day la su khac biet giua:

- **Process alive**: PID ton tai, port mo. Nhung co the khong the xu ly request.
- **Service healthy**: Service co the phuc vu request dung cach. Dependency (DB, cache, external) kha dung.
- **Dependency aware**: Khong chi kiem tra chinh minh, ma con kiem tra nhung gi minh phu thuoc vao.

### 1.4 Tai sao day la case dau tien?

```text
Neu dependency down, service degraded du business endpoint van tra 200.
```

Trong bat ky incident nao, cau hoi dau tien khong phai la "code co bug khong", ma la "infrastructure co healthy khong". Health check tra loi cau hoi nay trong vong vai giay.

Thu tu debug chuan:

1. **Health check layer (case nay)**: Infrastructure healthy khong?
2. **Gateway routing (ms-01)**: Request den dung service khong?
3. **Per-service contract (ms-02→05)**: Moi service tra dung contract khong?
4. **Cross-service flow (ms-06)**: Flow xuyen service khong dut khong?

---

## 2. Microservices capability duoc chung minh

Case nay chung minh cac capability sau cua he thong:

### 2.1 App dependency endpoint

- App dependency endpoint (`/ops/app/health/dependencies`) tra ve trang thai tung dependency;
- Response bao gom overall status: `ok` hoac `degraded`;
- Response bao gom tung dependency: Redis, Postgres, payment URL;
- Moi dependency co `status` field: `up` hoac `down`.

### 2.2 Per-service health endpoints

- Moi service co `/health` endpoint rieng (auth, products, cart, order, report);
- Moi service `/health` tra ve 200 khi healthy, 503 khi degraded;
- Moi service bao cao dependency status rieng biet;
- Order service la service duy nhat co external HTTP dependency (payment-mock).

### 2.3 Dependency status mapping

| Dependency | Y nghia | Service nao phu thuoc |
| --- | --- | --- |
| Postgres | Database chinh | Tat ca 5 services |
| Redis | Cache/session store | Tat ca 5 services (qua app layer) |
| payment-mock | External HTTP service | Chi order-service |
| Internal health | Service tu kiem tra chinh no | Moi service |

### 2.4 Expectation modes

Script ho tro **11 expectation modes** de test cac trang thai dependency khac nhau:

```text
healthy            — tat ca dependencies up (default)
redis_down         — Redis down, Postgres up
postgres_down      — Postgres down, Redis up
redis_slow         — Redis cham nhung up
postgres_slow      — Postgres cham nhung up
redis_timeout      — Redis timeout
postgres_timeout   — Postgres timeout
redis_exhausted    — Redis het connection
postgres_exhausted — Postgres het connection
redis_network_fault — Redis network fault
postgres_network_fault — Postgres network fault
```

### 2.5 Cac khia canh duoc verify

1. **Redis status = "up"**: Redis connection thanh cong.
2. **Postgres status = "up"**: Postgres connection thanh cong.
3. **Khong co dependency nao degraded**: Tat ca expected status la `up`.
4. **Service-level `/health` endpoints deu tra ve 200**: Moi service bao cao healthy.
5. **Health check phan anh dung thuc te**: Khong phai static "ok" -- thuc su probe dependency.
6. **Cache path va DB path**: Verified thong qua probe cache va probe DB read/write.
7. **Overall status consistency**: App-level status nhat quan voi service-level status.

---

## 3. Vi sao phai test o Microservices layer

### 3.1 Vi sao khong test o CDN layer?

CDN test (layer 1) quan tam den cache hit/miss, TTL, bypass rules. Health check khong phai la cacheable content -- ban khong muon CDN cache mot health check response. CDN khong the:

- Probe Redis connection tu service.
- Probe Postgres connection tu service.
- Biet duoc order-service co goi duoc payment-mock khong.
- Aggregate dependency status tu 5 services khac nhau.

### 3.2 Vi sao khong test o LB layer?

LB test (layer 2) kiem tra upstream selection, routing algorithm, retry/failover. Nhung LB health check thuong la TCP port check hoac HTTP 200 check don gian -- khong co dependency awareness. LB khong the:

- Biet Redis co het connection pool khong.
- Biet Postgres co bi slow query khong.
- Biet payment-mock co timeout khong.
- Danh gia "service healthy" vs "process alive".

### 3.3 Vi sao phai test o Microservices layer?

Microservices layer (layer 3) la noi health check co **business meaning**:

- Moi service tu biet no phu thuoc vao gi.
- Moi service tu probe dependency cua no.
- App-level aggregate cho biet buc tranh tong the.
- Health status anh huong truc tiep den quyet dinh routing (K8s readiness probe, load balancer health check).

Neu health check sai (bao "up" khi Redis down), orchestrator se tiep tuc route traffic den service khong hoat dong duoc -- gay ra cascading failure.

### 3.4 Vi sao day la prerequisite cho moi case khac?

```text
Health check (case nay) → Gateway routing (ms-01) → Per-service contracts (ms-02→05) → Cross-service flow (ms-06)
```

Neu infrastructure khong healthy, moi case khac deu co the fail vi ly do ngoai y muon. Chay health check truoc giup:

- **Isolate infrastructure issues**: Neu health check fail, dung -- dung debug business logic.
- **Tiet kiem thoi gian debug**: Khong ton 30 phut debug code khi van de la Redis down.
- **Baseline**: Biet duoc latency baseline cua cache va DB khi moi thu healthy.

---

## 4. Topology va precondition

### 4.1 Topology

```text
Script: ../app/01-dependency-smoke.js
Executor: constant-vus
Default VUs: 2
Default duration: 24s
Topology: full-no-cdn
BASE_URL: http://localhost:80
```

Case nay dung constant-vus voi low VUs de sustained health probe -- khong can nhieu traffic, chi can du de xac nhan health on dinh theo thoi gian.

### 4.2 Runtime path

```text
k6 client
  → http://localhost:80
  → Nginx (API gateway)
  → /ops/app/health/dependencies → app:8080
  → /health (per service) → auth:8081, products:8084, cart:8082, order:8083, report:8085
  → /api/cached → app:8080 → Redis
  → /api/no-cache → app:8080 → Postgres
  → /api/data → app:8080 → Postgres
```

### 4.3 Prerequisites

Truoc khi chay case nay, can dam bao:

1. **Topology full-no-cdn dang up**: `docker compose` profile full-no-cdn da duoc start.
2. **Postgres dang chay**: Health check can Postgres de probe.
3. **Redis dang chay**: Health check can Redis de probe.
4. **Tat ca 5 services dang chay**: auth, products, cart, order, report.
5. **Khong co CDN (Varnish)**: Tranh cache lam nhi eu health response.

### 4.4 Env knobs

```powershell
$env:BASE_URL = "http://localhost:80"
$env:APP_DEPS_EXPECTATION = "healthy"
$env:APP_DEPS_VUS = "2"
$env:APP_DEPS_DURATION = "24s"
$env:APP_DEPS_SLEEP_SECONDS = "0.2"
$env:APP_DEPS_ORIGIN_BASE_URL = ""
```

> **Luu y**: `APP_DEPS_ORIGIN_BASE_URL=""` buoc script dung `BASE_URL` cho tat ca health probe, tranh port 8088 khong co trong topology `full-no-cdn`.

| Env variable | Default | Y nghia |
| --- | --- | --- |
| `APP_DEPS_EXPECTATION` | `healthy` | Trang thai dependency mong doi |
| `APP_DEPS_VUS` | 2 | So VU chay dong thoi |
| `APP_DEPS_DURATION` | `24s` | Thoi gian chay |
| `APP_DEPS_SLEEP_SECONDS` | 0.2 | Sleep giua cac iteration |
| `APP_DEPS_ORIGIN_BASE_URL` | `""` | URL origin (bo trong = dung BASE_URL) |
| `APP_DEPS_REDIS_SLOW_MIN_MS` | 200 | Nguong Redis cham (ms) |
| `APP_DEPS_POSTGRES_SLOW_MIN_MS` | 250 | Nguong Postgres cham (ms) |

---

## 5. Script deep-dive

### 5.1 File script

Script duoc dat tai `../app/01-dependency-smoke.js`. No su dung executor `constant-vus` de duy tri 2 VU lien tuc trong 24 giay, moi VU thuc hien health probe moi 0.2 giay.

### 5.2 Struct tong the

Script duoc to chuc thanh cac phan:

1. **Env parsing**: Doc va validate `APP_DEPS_EXPECTATION` va cac bien moi truong khac.
2. **Custom metrics**: Dinh nghia Counter, Rate, Trend cho health signals.
3. **Expectation functions**: Xac dinh expected status cho moi dependency dua tren `expectation` mode.
4. **Probe functions**: `probeHealth`, `probeCachePath`, `probeDbReadPath`, `probeDbWritePath`.
5. **Default function**: Goi cac probe functions theo thu tu, sau do sleep.

### 5.3 Custom metrics

```javascript
const dependencyCheckFailures = new Counter('app_deps_check_failures');
const dependencyDegradedObserved = new Rate('app_deps_degraded_observed');
const cacheEndpointDuration = new Trend('app_deps_cache_duration', true);
const dbEndpointDuration = new Trend('app_deps_db_duration', true);
```

| Metric | Loai | Y nghia |
| --- | --- | --- |
| `app_deps_check_failures` | Counter | So lan check that bai |
| `app_deps_degraded_observed` | Rate | Ty le probe thay degraded |
| `app_deps_cache_duration` | Trend | Latency cua cache path (Redis) |
| `app_deps_db_duration` | Trend | Latency cua DB path (Postgres) |

### 5.4 Options va thresholds

```javascript
export const options = {
  scenarios: {
    dependency_probe: {
      executor: 'constant-vus',
      vus,
      duration,
      gracefulStop: '5s',
      tags: { suite: 'app_deps', expectation },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    app_deps_check_failures: ['count==0'],
  },
};
```

- `constant-vus` executor: Duy tri VUs co dinh trong suot duration.
- `checks rate==1`: 100% checks pass.
- `app_deps_check_failures count==0`: Khong co check failure nao.

### 5.5 Expectation functions

#### 5.5.1 expectedDependencyStatus

```javascript
function expectedDependencyStatus(name) {
  if (['healthy', 'redis_slow', 'postgres_slow'].includes(expectation)) {
    return 'up';
  }
  if (['redis_down', 'redis_timeout', 'redis_exhausted', 'redis_network_fault'].includes(expectation)) {
    return name === 'redis' ? 'down' : 'up';
  }
  if (['postgres_down', 'postgres_timeout', 'postgres_exhausted', 'postgres_network_fault'].includes(expectation)) {
    return name === 'postgres' ? 'down' : 'up';
  }
  return 'up';
}
```

Logic:
- Neu expectation la `healthy`, `redis_slow`, `postgres_slow`: Tat ca dependency expected `up`. (Slow van la up -- chi la cham.)
- Neu expectation la `redis_down`, `redis_timeout`, `redis_exhausted`, `redis_network_fault`: Redis expected `down`, Postgres expected `up`.
- Neu expectation la `postgres_down`, `postgres_timeout`, `postgres_exhausted`, `postgres_network_fault`: Postgres expected `down`, Redis expected `up`.

#### 5.5.2 expectedOverallHealthStatus

```javascript
function expectedOverallHealthStatus() {
  return ['healthy', 'redis_slow', 'postgres_slow'].includes(expectation) ? 200 : 503;
}
```

- Healthy/slow: 200 OK.
- Co dependency down: 503 Service Unavailable.

#### 5.5.3 expectedOverallHealthState

```javascript
function expectedOverallHealthState() {
  return ['healthy', 'redis_slow', 'postgres_slow'].includes(expectation) ? 'ok' : 'degraded';
}
```

- `ok`: Tat ca dependency healthy.
- `degraded`: It nhat mot dependency down.

### 5.6 Default function

```javascript
export default function () {
  probeHealth('public', publicBaseUrl);
  if (originBaseUrl) {
    probeHealth('origin', originBaseUrl);
  }
  probeCachePath();
  probeDbReadPath();
  probeDbWritePath();
  probePressureMetrics();
  sleep(sleepSeconds);
}
```

Moi iteration thuc hien 5-6 probe:

1. **probeHealth('public', publicBaseUrl)**: Goi `/health` qua public URL.
2. **probeHealth('origin', originBaseUrl)**: Goi `/health` qua origin URL (chi khi `originBaseUrl` duoc set).
3. **probeCachePath()**: Goi `/api/cached` de probe Redis.
4. **probeDbReadPath()**: Goi `/api/no-cache` de probe Postgres read.
5. **probeDbWritePath()**: Goi POST `/api/data` de probe Postgres write.
6. **probePressureMetrics()**: Probe them metric (placeholder).

### 5.7 probeHealth function

```javascript
function probeHealth(targetLabel, url) {
  const response = http.get(`${url}/health`, {
    tags: { probe: `${targetLabel}_health`, expectation },
  });

  const expectedStatuses = isProxyOutageMode()
    ? [expectedOverallHealthStatus(), 502, 504]
    : [expectedOverallHealthStatus()];
  expectStatusOneOf(response, expectedStatuses, `${targetLabel} health`);
  expectJsonPathOrProxyFailure(response, `${targetLabel} overall state matches`,
    (body) => body.status === expectedOverallHealthState());
  expectJsonPathOrProxyFailure(response, `${targetLabel} redis dependency matches`,
    (body) => body.dependencies && body.dependencies.redis
      && body.dependencies.redis.status === expectedDependencyStatus('redis'));
  expectJsonPathOrProxyFailure(response, `${targetLabel} postgres dependency matches`,
    (body) => body.dependencies && body.dependencies.postgres
      && body.dependencies.postgres.status === expectedDependencyStatus('postgres'));

  dependencyDegradedObserved.add(
    response.status === 503 || isProxyGatewayFailure(response) ? 1 : 0,
    { target: targetLabel, expectation },
  );
}
```

Ham nay verify:

1. Status code dung (200 cho healthy, 503 cho degraded).
2. Overall status (`ok` hoac `degraded`).
3. Redis dependency status.
4. Postgres dependency status.
5. Ghi nhan degraded observation.

---

## 6. Service mechanism deep-dive: health endpoint pattern va dependency graph

### 6.1 Health check architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                      App:8080                                 │
│  GET /ops/app/health/dependencies                            │
│  → Aggregate health cua 5 services                           │
│  → Probe Redis truc tiep                                     │
│  → Probe Postgres truc tiep                                  │
│  → Tra ve { status: "ok" | "degraded", dependencies: {...} } │
└──────────┬──────────┬──────────┬──────────┬──────────────────┘
           │          │          │          │
    ┌──────▼──┐ ┌─────▼───┐ ┌───▼────┐ ┌──▼──────┐
    │ auth    │ │products  │ │ cart   │ │ order   │   ┌──────────┐
    │ :8081   │ │ :8084    │ │ :8082  │ │ :8083   │   │ report   │
    │ /health │ │ /health  │ │/health │ │ /health │   │ :8085    │
    │ PG      │ │ PG       │ │ PG     │ │ PG+Pay  │   │ /health  │
    └────┬────┘ └────┬─────┘ └───┬────┘ └──┬──┬───┘   │ PG       │
         │           │           │         │  │       └────┬─────┘
         └───────────┴───────────┴─────────┘  │            │
                                              │            │
                                    ┌─────────▼──┐         │
                                    │ Postgres   │◄────────┘
                                    │ :5432      │
                                    └────────────┘
                                              │
                                    ┌─────────▼──┐
                                    │ Redis      │
                                    │ :6379      │
                                    └────────────┘
                                              │
                                    ┌─────────▼──┐
                                    │payment-mock│ (chi order-service)
                                    │ :8090      │
                                    └────────────┘
```

### 6.2 Tung service health endpoint

Moi service co `/health` endpoint rieng. Khac biet giua cac service:

| Service | Health dependencies | Ghi chu |
| --- | --- | --- |
| auth-service | Chi Postgres | Service don gian nhat |
| products-service | Chi Postgres | Read-only, khong can Redis |
| cart-service | Chi Postgres | Cart state luu trong session (Redis), nhung health chi kiem tra Postgres |
| order-service | Postgres + payment-mock (HTTP) | Service duy nhat co external HTTP dependency |
| report-service | Chi Postgres | Async jobs chi can Postgres, khong can Redis |

### 6.3 Vi sao order-service la service duy nhat co external HTTP dependency?

Order service can goi payment-mock de xu ly thanh toan. Neu payment-mock down:

- `POST /api/sim/checkout` co the fail hoac treo.
- `POST /api/sim/orders/:id/confirm` co the fail.
- `POST /api/sim/webhooks/payment` -- webhook tu payment-mock -- se khong bao gio den.

Nhung cac endpoint khac cua order-service (GET status) van hoat dong -- vi chi can Postgres. Day la degraded, khong phai down hoan toan.

### 6.4 Dependency graph

```text
Tat ca services → Postgres
Tat ca services → Redis (qua app layer)
order-service  → payment-mock (HTTP)
```

Khi Postgres down: **Tat ca 5 services degraded**. He thong gan nhu khong hoat dong duoc.
Khi Redis down: Moi service van doc/ghi Postgres duoc, nhung cache khong hoat dong, session co the bi anh huong.
Khi payment-mock down: **Chi order-service degraded**. Cac service khac van healthy.

### 6.5 Health endpoint response format

```json
{
  "status": "ok",
  "dependencies": {
    "redis": {
      "status": "up",
      "latency_ms": 2
    },
    "postgres": {
      "status": "up",
      "latency_ms": 5
    }
  }
}
```

Khi degraded:

```json
{
  "status": "degraded",
  "dependencies": {
    "redis": {
      "status": "down",
      "error": "connection refused"
    },
    "postgres": {
      "status": "up",
      "latency_ms": 5
    }
  }
}
```

### 6.6 Phan biet process alive vs service healthy

```text
┌─────────────────────────────────────────────────────────────┐
│ Process alive                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Port mo (8083), PID ton tai                             │ │
│ │ Nhung...                                                │ │
│ │ - Redis connection pool exhausted                       │ │
│ │ - Postgres connection timeout                           │ │
│ │ - Payment mock khong the reach                          │ │
│ │ → Service KHONG healthy, du process alive                │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Service healthy                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Port mo (8083), PID ton tai                             │ │
│ │ - Redis PING thanh cong                                 │ │
│ │ - Postgres SELECT 1 thanh cong                          │ │
│ │ - Payment mock HTTP GET /health thanh cong              │ │
│ │ → Service healthy, co the phuc vu request               │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 6.7 Health check trong K8s/Docker

Trong production, orchestrator su dung health check de:

- **Liveness probe**: Process co song khong? Neu fail, restart container.
- **Readiness probe**: Service co san sang nhan request khong? Neu fail, remove khoi load balancer.
- **Startup probe**: Service da khoi dong xong chua? Neu fail, cho them.

Case nay mo phong readiness probe -- no kiem tra ca dependency, khong chi process.

---

## 7. Request sequence flow

### 7.1 Flow tong the

```text
Runtime loop (2 VUs, 24s, sleep 0.2s giua cac iteration):

Moi iteration:
  1. GET /ops/app/health/dependencies
     → Expect: 200, JSON voi trang thai tung dependency

  2. Verify:
     - Redis status = "up"
     - Postgres status = "up"
     - Tat ca dependencies expected healthy

  3. GET /api/cached
     → Probe Redis cache path

  4. GET /api/no-cache
     → Probe Postgres read path

  5. POST /api/data
     → Probe Postgres write path

  6. sleep 0.2s
```

Health check probe khong goi business endpoint -- no goi thang health endpoint de tranh side effect.

### 7.2 Flow chi tiet cho mot iteration

#### Buoc 1: Probe health endpoint

```text
Client: GET /ops/app/health/dependencies
Nginx: route /ops/app/health/dependencies → app:8080
App: goi health endpoint cua tung service
  → GET auth-service:8081/health
  → GET products-service:8084/health
  → GET cart-service:8082/health
  → GET order-service:8083/health
  → GET report-service:8085/health
App: probe Redis (PING)
App: probe Postgres (SELECT 1)
App: aggregate result → { status: "ok", dependencies: {...} }
Nginx: add X-Upstream-Service (app)
Client: Expect 200, status=ok, redis=up, postgres=up
```

#### Buoc 2: Probe cache path

```text
Client: GET /api/cached
Nginx: route /api/cached → app:8080
App: goi Redis GET
Redis: tra ve cached value
App: return { source: "cache" | "origin", ... }
Client: Expect 200, source xac dinh
```

Cache path kiem tra Redis thuc su hoat dong -- khong chi PING, ma con GET/SET.

#### Buoc 3: Probe DB read path

```text
Client: GET /api/no-cache
Nginx: route /api/no-cache → app:8080
App: goi Postgres SELECT
Postgres: tra ve data rows
App: return { source: "database", ... }
Client: Expect 200, source="database"
```

#### Buoc 4: Probe DB write path

```text
Client: POST /api/data
Body: { expectation, vu, iter, timestamp }
Nginx: route /api/data → app:8080
App: goi Postgres INSERT
Postgres: tra ve new row id
App: return { id: ..., ... }
Client: Expect 201, id khong null
```

DB write path kiem tra Postgres co the INSERT duoc -- khong chi SELECT.

### 7.3 So do sequence tong the

```text
Client                App:8080         Auth:8081   Products:8084   Cart:8082   Order:8083   Report:8085   Redis    Postgres   PaymentMock
  │                      │                  │            │             │            │             │          │         │           │
  │ 1. GET /health/deps  │                  │            │             │            │             │          │         │           │
  │─────────────────────►│                  │            │             │            │             │          │         │           │
  │                      │── GET /health ──►│            │             │            │             │          │         │           │
  │                      │── GET /health ──────────────►│             │            │             │          │         │           │
  │                      │── GET /health ───────────────────────────►│            │             │          │         │           │
  │                      │── GET /health ───────────────────────────────────────►│             │          │         │           │
  │                      │── GET /health ────────────────────────────────────────────────────►│          │         │           │
  │                      │                  │            │             │            │             │          │         │           │
  │                      │── PING ────────────────────────────────────────────────────────────────────────►│         │           │
  │                      │── SELECT 1 ─────────────────────────────────────────────────────────────────────────────►│           │
  │                      │                  │            │             │            │             │          │         │           │
  │                      │◄─ aggregate: Redis=up, PG=up, all services healthy ──────────────────────────────────────────────│
  │◄─ 200 + { deps } ───│                  │            │             │            │             │          │         │           │
  │                      │                  │            │             │            │             │          │         │           │
  │ 2. GET /api/cached   │                  │            │             │            │             │          │         │           │
  │─────────────────────►│────────────────────────────────────────────────────────────────────────►│         │           │
  │◄─ 200 + source ─────│◄────────────────────────────────────────────────────────────────────────│         │           │
  │                      │                  │            │             │            │             │          │         │           │
  │ 3. GET /api/no-cache │                  │            │             │            │             │          │         │           │
  │─────────────────────►│──────────────────────────────────────────────────────────────────────────────────►│           │
  │◄─ 200 + database ───│◄──────────────────────────────────────────────────────────────────────────────────│           │
  │                      │                  │            │             │            │             │          │         │           │
  │ 4. POST /api/data    │                  │            │             │            │             │          │         │           │
  │─────────────────────►│──────────────────────────────────────────────────────────────────────────────────►│           │
  │◄─ 201 + id ─────────│◄──────────────────────────────────────────────────────────────────────────────────│           │
  │                      │                  │            │             │            │             │          │         │           │
```

---

## 8. Key signals

### 8.1 Primary signals

| Signal | Y nghia | Cach doc |
| --- | --- | --- |
| `checks` 100% | Tat ca check deu pass | Threshold `rate==1` |
| `app_deps_check_failures` = 0 | Khong co check failure nao | Threshold `count==0` |
| `app_deps_degraded_observed` = 0 | Khong co degraded observation | Rate metric |
| Redis status = `up` | Redis healthy | Xem response body |
| Postgres status = `up` | Postgres healthy | Xem response body |
| Tung service `/health` tra ve 200 | Moi service bao cao healthy | Xem app health aggregate |

### 8.2 Secondary signals

| Signal | Y nghia | Cach doc |
| --- | --- | --- |
| `app_deps_cache_duration` | Latency cua cache path (Redis) | Trend metric |
| `app_deps_db_duration` | Latency cua DB path (Postgres) | Trend metric |
| Cache path `source` = `origin` hoac `cache` | Cache hoat dong dung | Response body |
| DB read path `source` = `database` | DB read hoat dong dung | Response body |
| DB write path status = 201 | DB write hoat dong dung | Response status |
| Overall health state = `ok` | Tat ca dependency healthy | Response body |

### 8.3 Latency baseline

Khi moi thu healthy, latency nen o muc:

| Probe | Expected latency |
| --- | --- |
| Health endpoint | 5-30ms (aggregate tu 5 services + 2 DB probes) |
| Cache path (Redis) | 1-5ms |
| DB read path (Postgres) | 2-10ms |
| DB write path (Postgres) | 3-15ms |

### 8.4 Cac trang thai expectation va expected outcomes

| Expectation | Redis | Postgres | Overall | Cache path | DB path | Overall status |
| --- | --- | --- | --- | --- | --- | --- |
| `healthy` | up | up | 200 | 200, source=origin/cache | 200/201 | ok |
| `redis_down` | down | up | 503 | 500 | 200/201 | degraded |
| `postgres_down` | up | down | 503 | 200, source=origin | 500 | degraded |
| `redis_slow` | up | up | 200 | 200, duration >= 200ms | 200/201 | ok |
| `postgres_slow` | up | up | 200 | 200 | 200/201, duration >= 250ms | ok |
| `redis_timeout` | down | up | 503 | 500, timeout error | 200/201 | degraded |
| `postgres_timeout` | up | down | 503 | 200 | 500, timeout error | degraded |

---

## 9. Pass/fail criteria

### 9.1 Pass criteria (expectation = healthy)

1. **checks = 100%**: Tat ca k6 checks pass.
2. **app_deps_check_failures = 0**: Khong co check failure.
3. **app_deps_degraded_observed = 0**: Khong co degraded observation.
4. **Redis status = "up"**: Redis healthy.
5. **Postgres status = "up"**: Postgres healthy.
6. **Tung service /health tra ve 200 OK**: Tat ca services healthy.
7. **Overall health status = 200**: HTTP 200.
8. **Overall health state = "ok"**: Khong degraded.
9. **Cache path: 200 + source xac dinh**: Redis cache hoat dong.
10. **DB read path: 200 + source="database"**: Postgres read hoat dong.
11. **DB write path: 201 + id khong null**: Postgres write hoat dong.

### 9.2 Fail criteria -- tung phan

| Kiem tra | Fail neu | Nguyen nhan kha di |
| --- | --- | --- |
| Health endpoint | Status != 200 | Co dependency down |
| Redis status | Khong phai "up" | Redis down, Redis timeout, Redis exhausted |
| Postgres status | Khong phai "up" | Postgres down, Postgres timeout |
| app_deps_degraded_observed | > 0 | Co dependency khong healthy |
| app_deps_check_failures | > 0 | Co check failure (status sai, body sai) |
| Cache path | Status != 200 | Redis khong the GET |
| DB read path | Status != 200, source != "database" | Postgres khong the SELECT |
| DB write path | Status != 201, id null | Postgres khong the INSERT |
| Checks < 100% | Mot so probe fail | Tong hop cac loi tren |

### 9.3 Phan biet loai degraded

| Trieu chung | Co the la... |
| --- | --- |
| Redis=down, Postgres=up | Redis crash, Redis OOM, Redis network partition |
| Postgres=down, Redis=up | Postgres crash, PG disk full, PG connection limit |
| Ca Redis va Postgres deu down | Network partition, Docker network down |
| Redis=up nhung latency cao | Redis slow (`redis_slow` expectation) |
| Cache path fail nhung health van bao up | Health check khong probe thuc su |

---

## 10. Cach chay va output mau

### 10.1 Cach chay co ban (healthy)

```powershell
# Run trong thu muc chua script
k6 run 01-dependency-smoke.js

# Hoac tu thu muc goc cua project
k6 run app/01-dependency-smoke.js
```

### 10.2 Cach chay voi env knobs tuy chinh

```powershell
$env:BASE_URL = "http://localhost:80"
$env:APP_DEPS_EXPECTATION = "healthy"
$env:APP_DEPS_VUS = "2"
$env:APP_DEPS_DURATION = "24s"
$env:APP_DEPS_SLEEP_SECONDS = "0.2"
$env:APP_DEPS_ORIGIN_BASE_URL = ""
k6 run app/01-dependency-smoke.js
```

### 10.3 Output mau -- pass (healthy)

```text
     ✓ public health status 200
     ✓ public overall state matches
     ✓ public redis dependency matches
     ✓ public postgres dependency matches
     ✓ cache path status 200
     ✓ cache path source is origin-or-cache
     ✓ db read path status 200
     ✓ db read path source is database
     ✓ db write path status 201
     ✓ db write path returns id

     checks.........................: 100.00% ✓ 1200     ✗ 0
     app_deps_check_failures........: 0       ✓ 0        ✗ 0
     app_deps_degraded_observed.....: 0.00%   ✓ 0        ✗ 120
     app_deps_cache_duration........: avg=2ms   p(95)=5ms
     app_deps_db_duration...........: avg=4ms   p(95)=10ms
```

### 10.4 Output mau -- fail (Redis down)

```powershell
$env:APP_DEPS_EXPECTATION = "redis_down"
k6 run app/01-dependency-smoke.js
```

```text
     ✓ public health status 503
     ✓ public overall state matches (degraded)
     ✓ public redis dependency matches (down)
     ✓ public postgres dependency matches (up)
     ✓ cache path status 500
     ✓ cache path reports redis error

     checks.........................: 100.00% ✓ 1200     ✗ 0
     app_deps_degraded_observed.....: 100.00% ✓ 120      ✗ 0
```

Khi expectation la `redis_down`, script EXPECT Redis down -- checks van 100% vi service bao cao dung thuc te.

### 10.5 Output mau -- fail (unexpected degraded trong healthy mode)

```text
     ✗ public redis dependency matches
       ↳  0% — 0 ✓ / 120 ✗
     ✓ public postgres dependency matches

     checks.........................: 75.00%  ✓ 900      ✗ 300
     app_deps_check_failures........: 120     ✓ 0        ✗ 120
     app_deps_degraded_observed.....: 100.00% ✓ 120      ✗ 0
```

Redis down nhung expectation la `healthy` -- day la fail. Checks < 100%.

### 10.6 Cach doc output theo thu tu uu tien

1. **app_deps_check_failures**: Neu > 0, co check that bai. Xem chi tiet label de biet check nao fail.
2. **app_deps_degraded_observed**: Neu > 0 trong healthy mode, co dependency down.
3. **Checks rate**: Neu < 100%, xem chi tiet check nao fail.
4. **Latency trends**: `app_deps_cache_duration` va `app_deps_db_duration` -- neu cao bat thuong, co the dependency dang cham.
5. **Response body**: Kiem tra Redis status, Postgres status, overall state.

---

## 11. 4 output → decision scenarios

### Scenario 1: Tat ca pass -- healthy

**Output**:
```text
checks=100%, app_deps_check_failures=0, app_deps_degraded_observed=0%
Redis=up, Postgres=up, overall=ok
Cache path=200, DB read=200, DB write=201
```

**Quyet dinh**: Infrastructure healthy. Co the tien hanh chay cac case khac (ms-01 den ms-06). Day la baseline.

**Action**: Khong. Tiep tuc len lich chay cac case tiep theo.

**Confidence**: Cao. Tat ca dependency da duoc probe thuc te.

### Scenario 2: Redis down trong healthy mode

**Output**:
```text
checks=75%, app_deps_check_failures=120, app_deps_degraded_observed=100%
Redis=down, Postgres=up, overall=degraded (503)
```

**Quyet dinh**: Redis dang down. Dung -- khong chay cac case khac (dac biet Redis layer cases) vi se fail vi ly do infrastructure.

**Action**:
1. Kiem tra Redis container co dang chay khong: `docker ps | grep redis`.
2. Kiem tra Redis logs: `docker logs <redis-container>`.
3. Kiem tra Redis connection: `redis-cli PING`.
4. Restart Redis neu can.
5. Rerun case nay cho den khi pass.
6. Sau khi pass, tien hanh chay cac case khac.

### Scenario 3: Health bao "up" nhung cache path fail

**Output**:
```text
✓ public redis dependency matches (Redis=up)
✗ cache path status 200 (thuc te tra ve 500)
checks=90%
```

**Quyet dinh**: Health check dang sai -- bao Redis "up" nhung Redis khong the GET. Day la health check khong phan anh dung thuc te.

**Action**:
1. Kiem tra health endpoint co thuc su probe Redis khong (hay chi tra ve static "up").
2. Kiem tra Redis co bi phan manh khong (PING duoc nhung GET/SET khong duoc).
3. Fix health check de probe Redis GET/SET, khong chi PING.
4. Rerun.

### Scenario 4: Postgres write fail nhung read van ok

**Output**:
```text
✓ db read path status 200 + source=database
✗ db write path status 201 (thuc te tra ve 500)
checks=85%
```

**Quyet dinh**: Postgres read-only -- co the SELECT nhung khong the INSERT. Co the PG disk full hoac primary/replica failover dang dien ra.

**Action**:
1. Kiem tra Postgres disk space: `df -h`.
2. Kiem tra Postgres replication status.
3. Kiem tra Postgres connection pool -- co the da het connection cho write.
4. Fix Postgres.
5. Rerun case nay.

---

## 12. Nghich ly / misconceptions

### 12.1 "Health check la static 'ok' -- khong can probe dependency"

**Sai**. Health check static (luon tra ve "ok" ma khong probe) la mot trong nhung anti-pattern nguy hiem nhat. No dan den:

- Load balancer tiep tuc route traffic den service khong the xu ly request.
- Cascading failure: mot service nhan request, co gang goi dependency da chet, treo, timeout, va dan den chain reaction.
- Debug kho: business endpoint loi nhung health van bao "ok" -- mat nhieu thoi gian de tim ra dependency la root cause.

### 12.2 "Neu health check pass, business endpoint chac chan pass"

**Sai**. Health check co the pass (tat ca dependency up) nhung business endpoint van fail neu:

- Business logic bug (code loi).
- Contract violation (sai status code, sai body shape).
- Race condition (chi xuat hien duoi load).
- Data corruption (data trong DB sai nhung DB van up).

Health check la dieu kien can, khong du. No loai tru infrastructure issues -- khong loai tru application bugs.

### 12.3 "Case nay ton tai nguyen -- 2 VUs trong 24s la thua"

**Nguoc lai**. Case nay la case nhe nhat trong toan bo test suite (2 VUs, sleep 0.2s). Muc dich khong phai la load test -- ma la **sustained health probe**. 24 giay dam bao health duy tri on dinh, khong chi "up" trong 1 giay roi chet.

Neu health check da fail o muc nay (2 VUs, 0.2s sleep), dung chay bat ky case nao khac (8-50 VUs, 0s sleep) -- vi infrastructure da co van de.

### 12.4 "Chi can kiem tra health mot lan luc bat dau"

**Sai**. Health check mot lan chi cho biet "luc do healthy". Nhung:

- Dependency co the crash giua chung (OOM, timeout, network partition).
- Connection pool co the bi can kiet dan dan.
- Slow dependency co the build up (latency tang dan den timeout).

Sustained health probe (24s lien tuc) dam bao health duy tri on dinh trong suot thoi gian test.

### 12.5 "APP_DEPS_EXPECTATION=healthy la mode duy nhat can test"

**Sai**. `healthy` la default, nhung 10 expectation modes khac cung quan trong:

- **redis_down / postgres_down**: Verify service degraded gracefully (503 thay vi crash).
- **redis_slow / postgres_slow**: Verify latency duoc bao cao dung.
- **redis_timeout / postgres_timeout**: Verify timeout handling.
- **redis_exhausted / postgres_exhausted**: Verify connection pool exhaustion.
- **redis_network_fault / postgres_network_fault**: Verify TCP/DNS error handling.

Moi mode day mot bai hoc khac nhau ve dependency failure.

### 12.6 "Cache path va DB path la phan cua Redis/Postgres layer -- khong thuoc case nay"

**Sai**. Cache path va DB path la cach duy nhat de verify health check **phan anh dung thuc te**. Health endpoint bao Redis "up", nhung cache path fail → health check sai. Su ket hop giua health endpoint (aggregate) va direct probe (cache/DB path) moi cho evidence day du.

---

## 13. Checklist

### 13.1 Pre-run checklist

- [ ] Topology `full-no-cdn` da up (docker compose).
- [ ] Tat ca 5 services dang chay (auth, products, cart, order, report).
- [ ] Redis dang chay (port 6379).
- [ ] Postgres dang chay (port 5432).
- [ ] Payment-mock dang chay (port 8090) -- cho order-service health.
- [ ] BASE_URL=http://localhost:80 duoc set.
- [ ] APP_DEPS_EXPECTATION duoc set (thuong la `healthy`).
- [ ] APP_DEPS_ORIGIN_BASE_URL="" (bo trong) de dung BASE_URL.
- [ ] Khong co CDN (Varnish) -- tranh cache health response.

### 13.2 Runtime checklist

- [ ] checks = 100% (rate==1).
- [ ] app_deps_check_failures = 0.
- [ ] app_deps_degraded_observed = 0% (voi healthy mode).
- [ ] Redis status = "up".
- [ ] Postgres status = "up".
- [ ] Overall health state = "ok".
- [ ] Overall health status = 200.
- [ ] Cache path: 200, source = "origin" hoac "cache".
- [ ] DB read path: 200, source = "database".
- [ ] DB write path: 201, id khong null.
- [ ] app_deps_cache_duration trong khoang binh thuong (1-5ms).
- [ ] app_deps_db_duration trong khoang binh thuong (2-10ms).

### 13.3 Post-run decision checklist

- [ ] Neu checks = 100% + degraded = 0: Pass. Tien len ms-01 (gateway routing).
- [ ] Neu Redis down: Dung. Fix Redis.
- [ ] Neu Postgres down: Dung. Fix Postgres.
- [ ] Neu health pass nhung cache path fail: Health check sai. Fix health check.
- [ ] Neu latency cao bat thuong: Dependency dang cham. Kiem tra load/resource.
- [ ] Neu overall status != 200: Co dependency degraded. Xac dinh dependency nao.

### 13.4 Learning checklist cho nguoi hoc

- [ ] Hieu su khac biet giua "process alive" va "service healthy".
- [ ] Biet cach doc `X-Upstream-Service` header de xac nhan routing.
- [ ] Biet cach doc tung dependency status (Redis, Postgres).
- [ ] Biet cach phan biet degraded vs down.
- [ ] Hieu dependency graph cua tung service.
- [ ] Biet cach chay cac expectation mode khac nhau.
- [ ] Biet tai sao day la case dau tien trong moi incident.
- [ ] Hieu tai sao sustained probe (24s) quan trong hon one-time check.

---

## 14. 4-5 Variations

### Variation 1: Redis down

**Muc tieu**: Verify service bao cao Redis down mot cach chinh xac.

```powershell
$env:APP_DEPS_EXPECTATION = "redis_down"
```

**Expected**:
- Overall health: 503, status = "degraded".
- Redis dependency status = "down".
- Postgres dependency status = "up".
- Cache path: 500 (Redis error).
- DB read/write path: 200/201 (Postgres van hoat dong).
- checks = 100% (vi expectation match).

**Hoc duoc**: Service degraded gracefully khi Redis down. Postgres van hoat dong.

### Variation 2: Postgres down

**Muc tieu**: Verify service bao cao Postgres down mot cach chinh xac.

```powershell
$env:APP_DEPS_EXPECTATION = "postgres_down"
```

**Expected**:
- Overall health: 503, status = "degraded".
- Postgres dependency status = "down".
- Redis dependency status = "up".
- Cache path: 200 (Redis van hoat dong).
- DB read/write path: 500 (Postgres error).
- checks = 100%.

**Hoc duoc**: Postgres down anh huong den toan bo services (tat ca deu phu thuoc Postgres). Cache van hoat dong nhung DB paths fail.

### Variation 3: Redis slow

**Muc tieu**: Verify latency duoc bao cao dung khi Redis cham.

```powershell
$env:APP_DEPS_EXPECTATION = "redis_slow"
$env:APP_DEPS_REDIS_SLOW_MIN_MS = "200"
```

**Expected**:
- Redis status = "up" (van up, chi cham).
- Overall health: 200, status = "ok".
- Cache path: 200, duration >= 200ms.
- checks = 100%.

**Hoc duoc**: Slow dependency khong phai la down. Service van healthy nhung latency cao. Can theo doi latency trends.

### Variation 4: Redis connection pool exhausted

**Muc tieu**: Verify service phat hien va bao cao connection exhaustion.

```powershell
$env:APP_DEPS_EXPECTATION = "redis_exhausted"
$env:APP_DEPS_REDIS_PRESSURE_LIMIT = "10"
$env:APP_DEPS_REDIS_PRESSURE_HOLD_MS = "5000"
$env:APP_DEPS_REDIS_PRESSURE_WAITS_MIN = "1"
```

**Expected**:
- Redis status = "down".
- Cache path: 500 hoac queueing error.
- checks = 100%.

**Hoc duoc**: Connection pool exhaustion la mot dang failure khac voi Redis process crash. Redis process van chay nhung khong the chap nhan connection moi.

### Variation 5: Postgres network fault

**Muc tieu**: Verify service phat hien network-level failure.

```powershell
$env:APP_DEPS_EXPECTATION = "postgres_network_fault"
$env:APP_DEPS_POSTGRES_FAULT_MODE = "tcp_reset"
```

**Expected**:
- Postgres status = "down".
- DB paths: 500, error message chua "connection reset" hoac tuong tu.
- checks = 100%.

**Hoc duoc**: Network fault (TCP reset, DNS failure) la mot dang failure khac voi timeout hoac connection refusal. Service can phan biet cac loai failure de co error message chinh xac.

---

## 15. Anti-patterns

### 15.1 Health check tra ve static "ok"

**Sai**:
```go
// Health endpoint luon tra ve "ok" ma khong probe
func HealthHandler(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

**Dung**:
```go
// Health endpoint thuc su probe dependency
func HealthHandler(w http.ResponseWriter, r *http.Request) {
    redisStatus := checkRedis()
    pgStatus := checkPostgres()
    overall := "ok"
    httpStatus := 200
    if redisStatus != "up" || pgStatus != "up" {
        overall = "degraded"
        httpStatus = 503
    }
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status": overall,
        "dependencies": map[string]interface{}{
            "redis": map[string]string{"status": redisStatus},
            "postgres": map[string]string{"status": pgStatus},
        },
    })
}
```

### 15.2 Chi kiem tra port (TCP check), khong kiem tra dependency

**Sai**: LB config voi TCP health check (chi kiem tra port 8083 co mo khong). Neu Redis down, port 8083 van mo → LB van route traffic den order-service.

**Dung**: LB config voi HTTP health check goi `/health` endpoint, kiem tra status 200 va body co `"status": "ok"` khong. Neu Redis down, `/health` tra ve 503 → LB remove khoi pool.

### 15.3 Health check khong co timeout

**Sai**: Health check probe Redis nhung khong set timeout. Neu Redis treo, health check treo vinh vien → orchestrator khong biet service dang degraded.

**Dung**:
```go
ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
defer cancel()
err := redisClient.Ping(ctx).Err()
```

### 15.4 Chi probe mot lan luc startup, khong probe dinh ky

**Sai**: Health check chi chay luc service startup. Neu Redis chet sau 5 phut, service van bao "ok" cho den khi restart.

**Dung**: Moi request den `/health` deu probe lai dependency (hoac cache trong 1-2 giay). Sustained probe (nhu script nay lam trong 24s) phat hien failure som hon.

### 15.5 Gom chung tat ca dependency vao mot "overall" status

**Sai**:
```json
{
  "status": "degraded"
}
```

Khong biet dependency nao down -- Redis hay Postgres?

**Dung**:
```json
{
  "status": "degraded",
  "dependencies": {
    "redis": { "status": "down", "error": "connection refused" },
    "postgres": { "status": "up", "latency_ms": 5 }
  }
}
```

Biet chinh xac Redis down, Postgres up. Co the action ngay (restart Redis) thay vi debug lan lung.

### 15.6 Khong kiem tra consistency giua health endpoint va direct probe

**Sai**: Chi goi `/health`, khong goi direct probe (cache path, DB path). Neu health endpoint tra ve sai (bao "up" nhung thuc te down), khong phat hien duoc.

**Dung**: Ket hop health endpoint (aggregate) va direct probe (cache/DB path). Script nay lam ca hai:

- `probeHealth()`: Goi `/health`, verify response.
- `probeCachePath()`: Goi `/api/cached`, verify Redis hoat dong thuc te.
- `probeDbReadPath()` / `probeDbWritePath()`: Goi `/api/no-cache` va POST `/api/data`, verify Postgres hoat dong thuc te.

---

## 16. Real validation data

### 16.1 Iteration count

Voi `constant-vus`, 2 VUs, 24s duration, sleep 0.2s:

```text
So iteration ≈ 24s / 0.2s * 2 VUs = 240 iterations
Moi iteration: 1 health probe + 1 cache probe + 1 DB read probe + 1 DB write probe
Tong request: ~960 requests trong 24s
```

Day la case nhe nhat trong toan bo test suite.

### 16.2 Latency baseline (healthy)

| Probe | avg | p(95) | p(99) |
| --- | --- | --- | --- |
| Health endpoint | 10ms | 25ms | 40ms |
| Cache path (Redis) | 2ms | 5ms | 10ms |
| DB read path (Postgres) | 4ms | 10ms | 20ms |
| DB write path (Postgres) | 6ms | 15ms | 30ms |

### 16.3 Dependency status mapping table

| Expectation | Redis status | Postgres status | Overall status | Overall state |
| --- | --- | --- | --- | --- |
| healthy | up | up | 200 | ok |
| redis_down | down | up | 503 | degraded |
| postgres_down | up | down | 503 | degraded |
| redis_slow | up | up | 200 | ok |
| postgres_slow | up | up | 200 | ok |
| redis_timeout | down | up | 503 | degraded |
| postgres_timeout | up | down | 503 | degraded |
| redis_exhausted | down | up | 503 | degraded |
| postgres_exhausted | up | down | 503 | degraded |
| redis_network_fault | down | up | 503 | degraded |
| postgres_network_fault | up | down | 503 | degraded |

### 16.4 Service dependency matrix

| Service | Postgres | Redis | Payment-mock | /health status khi PG down | /health status khi Redis down | /health status khi payment down |
| --- | --- | --- | --- | --- | --- | --- |
| auth-service | Required | Via app | No | 503 | 200 (van ok) | N/A |
| products-service | Required | Via app | No | 503 | 200 (van ok) | N/A |
| cart-service | Required | Via app | No | 503 | 200 (van ok) | N/A |
| order-service | Required | Via app | Required | 503 | 503 | 503 |
| report-service | Required | Via app | No | 503 | 200 (van ok) | N/A |

### 16.5 Cac loai error message theo failure mode

| Failure mode | Error message pattern |
| --- | --- |
| Connection refused | `connection refused`, `dial tcp.*: connect: connection refused` |
| Timeout | `deadline exceeded`, `context canceled`, `i/o timeout` |
| Connection exhausted | `connection pool exhausted`, `too many connections` |
| DNS failure | `no such host`, `name or service not known` |
| TCP reset | `connection reset by peer`, `forcibly closed` |

---

## 17. Reference

### 17.1 Scripts lien quan

| Script | Executor | Muc dich |
| --- | --- | --- |
| `app/01-dependency-smoke.js` | constant-vus | Health check (case chinh) |
| `app/03-dependency-recovery-matrix.js` | constant-vus | Dependency recovery matrix |
| `app/20-service-health-check.js` | Ram nhien | Service-level health check |

### 17.2 Cases lien quan trong microservices layer

| Case | Ten | Moi quan he |
| --- | --- | --- |
| ms-01 | Gateway routing smoke | Chay sau khi health check pass |
| ms-02 | Products read contract | Can Postgres healthy |
| ms-03 | Cart write contract | Can Postgres healthy |
| ms-04 | Order transaction contract | Can Postgres + Redis + payment-mock healthy |
| ms-05 | Report async contract | Can Postgres healthy |
| ms-06 | Stateful business flow | Can tat ca services + dependencies healthy |

### 17.3 Cases o cac layer khac co lien quan

| Layer | Case | Moi quan he |
| --- | --- | --- |
| Redis (layer 4) | Tat ca Redis cases | Can Redis healthy (case nay verify) |
| Postgres (layer 5) | Tat ca Postgres cases | Can Postgres healthy (case nay verify) |
| External (layer 6) | Payment mock cases | Can payment-mock healthy |
| Resource (layer 7) | Capacity cases | Can tat ca infrastructure healthy |

### 17.4 HTTP status codes trong health context

| Status | Y nghia |
| --- | --- |
| 200 | Tat ca dependency healthy |
| 500 | Dependency error (timeout, connection refused) |
| 502 | Bad gateway (proxy/nginx khong the connect den upstream) |
| 503 | Service unavailable (dependency degraded) |
| 504 | Gateway timeout (proxy/nginx timeout khi goi upstream) |

### 17.5 Orchestrator health check patterns

| Pattern | Cach hoat dong | Su dung case nay |
| --- | --- | --- |
| Liveness probe | Kiem tra process co song khong | Neu fail, restart container |
| Readiness probe | Kiem tra service co san sang khong | Neu fail, remove khoi load balancer |
| Startup probe | Kiem tra service da khoi dong xong chua | Neu fail, cho them truoc khi goi liveness |

Case nay mo phong readiness probe -- no kiem tra ca dependency, khong chi process.

### 17.6 Topology reference

```text
full-no-cdn topology:
  k6 → localhost:80 → Nginx → app:8080 → /health endpoints cua 5 services
                                   → Redis:6379 (PING)
                                   → Postgres:5432 (SELECT 1)

Khong dung CDN (Varnish) de tranh cache health response.
Khong dung lb-app topology vi can full 5 microservice upstream.
```

### 17.7 Production lesson

Health check la thu dau tien orchestrator (K8s, Docker Compose, load balancer) dung de quyet dinh service co ready khong. Mot health check sai (bao "up" khi dependency down) se dan den traffic bi route den service khong hoat dong duoc. Case nay day:

- Cach doc health check co dependency awareness;
- Cach phan biet "process alive" vs "service healthy";
- Cach dung health check lam baseline truoc khi test bat ky case nao khac.

Trong incident, day luon la case dau tien: xac nhan dependency state truoc khi debug business logic.

Quy trinh incident response chuan:

1. **Health check (case nay)**: Infrastructure healthy khong? Dependency nao down?
2. **Gateway routing (ms-01)**: Request den dung service khong?
3. **Per-service contract (ms-02→05)**: Service nao vi pham contract?
4. **Cross-service flow (ms-06)**: Flow xuyen service co dut khong?
5. **Redis layer (layer 4)**: Shared state co nhat quan khong?
6. **Postgres layer (layer 5)**: Data co toan ven khong?
7. **External layer (layer 6)**: External service co timeout khong?
8. **Resource layer (layer 7)**: CPU/Memory/Disk co van de khong?

Day la cach tiep can co he thong, tu thap den cao, tu don gian den phuc tap. Dung bo qua buoc 1.

