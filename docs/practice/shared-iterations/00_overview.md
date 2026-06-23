# Series thực hành: 7 tình huống thực tế cho `shared-iterations`

## Mục đích series

Series này dạy **WHEN/WHY dùng `shared-iterations`** bằng 7 case backend thực tế.

Điểm quan trọng: đây không phải series mô phỏng user journey. Đây là series mô phỏng kiểu việc sau:

```text
Có một danh sách job/backlog cố định.
Có nhiều worker cùng xử lý danh sách đó.
Worker nào xong job trước thì lấy job tiếp theo.
Batch kết thúc khi toàn bộ backlog đã được xử lý.
```

Nói ngắn gọn:

```text
shared-iterations = fixed global backlog drained by worker pool
```

## Mental model: fixed global backlog + worker pool

Ví dụ config:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "shared-iterations",
      vus: 3,
      iterations: 10,
    },
  },
};
```

Đọc đúng:

```text
Có 10 job tổng cộng.
Có 3 VU đóng vai worker.
3 worker cùng lấy job từ pool chung.
Ai xong trước thì lấy job kế tiếp.
```

Không đọc thành:

```text
3 VU × 10 iterations = 30 job
```

Với `shared-iterations`, field `iterations` luôn là:

```text
tổng số iteration/job của toàn scenario
```

không phải:

```text
số iteration mỗi VU
```

Câu hỏi đúng:

```text
Did the pool finish all 10 jobs?
```

Câu hỏi sai:

```text
Did each VU run the same number of jobs?
```

Vì nếu VU 1 nhanh hơn VU 2, phân phối có thể là:

```text
VU 1: 5 jobs
VU 2: 3 jobs
VU 3: 2 jobs
```

Đó là bình thường, thậm chí đúng với mô hình worker queue.

## Vì sao `shared-iterations` tồn tại?

Nó giải quyết một class bài toán rất cụ thể:

```text
Tôi biết chính xác có N việc cần làm.
Tôi muốn M worker làm cho xong N việc đó.
Tôi không quan tâm worker nào làm bao nhiêu, miễn tổng việc hoàn tất đủ và sạch.
```

Ví dụ đời thực:

| Tình huống | N là gì? | Worker là gì? | Done nghĩa là gì? |
| --- | --- | --- | --- |
| Catalog audit | số SKU/product cần audit | VU workers | mọi SKU được list/detail verify |
| Order reconciliation | số order pending/failed | VU workers | mọi order confirm + status verify |
| Webhook drain | số webhook event trong queue | VU consumers | mọi event process an toàn |
| Cart cleanup | số stale cart item | VU workers | mọi item update + summary verify |
| Cache warm | số URL/cache key | VU warmers | mọi URL được gọi |
| Report export | số report job | VU workers | create/status/download đủ |
| CI checklist | số API contract check | VU workers | coverage đủ, checks pass |

## Executor comparison: chọn executor nào?

| Executor | Why tempting | Why right/wrong for fixed backlog |
| --- | --- | --- |
| `shared-iterations` | Fixed global jobs, worker pool | **Đúng**: `iterations` là tổng job, VU nào rảnh lấy job tiếp. |
| `per-vu-iterations` | Deterministic count | Sai nếu VU không phải business identity. Nó ép mỗi VU quota bằng nhau. |
| `constant-vus` | Simple worker pool | Sai khi cần exact count: tổng job phụ thuộc duration và latency. |
| `constant-arrival-rate` | Controls rate | Sai vì nó schedule arrivals, không phải drain fixed queue; có thể có dropped iterations. |
| `ramping-vus` | Vary workers | Sai nếu exact backlog completion là requirement chính. |
| `ramping-arrival-rate` | Vary traffic rate | Sai cho exact fixed-job coverage; hợp traffic surge hơn. |

Rule nhớ nhanh:

```text
Cần mỗi user/account làm đúng N việc  -> per-vu-iterations
Cần tổng N job được xử lý bởi M worker -> shared-iterations
Cần chạy trong T phút                  -> constant-vus/ramping-vus
Cần RPS/arrival rate                   -> arrival-rate executors
```

## Technical semantics that matter

### 1. Global shared iteration counter

Trong `shared-iterations`, k6 có một quota chung cho scenario:

```text
totalIters = iterations
```

Mỗi VU chạy vòng lặp:

```text
lấy số iteration kế tiếp từ counter chung
nếu counter còn trong quota -> chạy job
nếu counter vượt quota -> dừng
```

Nghĩa là VU không được cấp trước một quota riêng.

### 2. Fast VUs pull more jobs

Nếu một VU đang gặp job nhẹ hơn, network nhanh hơn, hoặc backend response nhanh hơn, nó có thể quay lại lấy job tiếp theo trước VU khác.

Đây là feature, không phải bug:

```text
worker queue ngoài đời cũng vậy:
worker nào rảnh trước thì lấy ticket tiếp theo
```

### 3. `__VU` là worker identity, không phải business identity

Trong các case này:

```text
__VU = worker đang xử lý job hiện tại
```

Không nên dùng `__VU` làm product ID, order ID, event ID, report ID, cache key chính.

Nếu dùng `__VU`, bạn có thể chỉ lặp lại vài identity worker và bỏ sót phần lớn backlog.

### 4. `__ITER` là local counter của VU

`__ITER` chỉ đếm iteration của riêng VU đó.

Ví dụ VU 1 có `__ITER=4` không có nghĩa đó là global job #4. VU 2 cũng có thể có `__ITER=4`.

Vì vậy, global job identity nên dựa vào:

```js
exec.scenario.iterationInTest
```

Ý nghĩa:

```text
số thứ tự iteration/job trong toàn scenario
```

### 5. `maxDuration` là safety cap, không phải target duration

Nếu `maxDuration` cắt test trước khi đủ job, kết quả không còn valid.

```text
iterations < JOBS
```

nghĩa là:

```text
backlog chưa drain hết
```

Không được nói batch pass chỉ vì phần job đã chạy không lỗi.

## Common metrics của bộ shared cases

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `shared_jobs_total` | Counter | Tổng job đã hoàn tất end-to-end. Expected `count == JOBS`. |
| `shared_jobs_failed` | Counter | Job fail ở tầng business. Expected `count == 0`. |
| `shared_api_calls_total` | Counter | Tổng API calls gửi qua helper chung. Expected khớp công thức API/job. |
| `shared_job_duration_ms` | Trend | Duration của full job lifecycle. Count nên bằng `JOBS`. |
| `shared_sleep_seconds` | Counter | Sleep/wait time nếu case có mô phỏng delay. |

Pass criteria chung:

```text
checks rate == 1
http_req_failed rate == 0
shared_jobs_total count == JOBS
shared_jobs_failed count == 0
```

## Common invalid-result patterns

| Pattern | Meaning | Action |
| --- | --- | --- |
| `iterations < JOBS` | Backlog chưa xử lý hết | Invalid result, fix cause and rerun |
| `shared_jobs_total < JOBS` | Script/backend không mark complete đủ job | Kiểm instrumentation, branch lỗi, exception |
| `shared_jobs_failed > 0` | Có job business fail | Block/investigate theo `job_id`, `operation` |
| Operation counts mismatch | Coverage gap | Invalid hoặc mapping bug |
| VU distribution uneven | Normal worker pool behavior | Do not fail |
| Latency high but counts complete | Functional pass, performance risk | Investigate operation latency |

## Dashboard semantics for shared-iterations

### Chart 1 — Response time

Chart này trả lời:

```text
Request path / operation nào chậm?
Bucket nào có tail latency?
Service nào đang là bottleneck?
```

Vì một job có thể có nhiều API call, luôn đọc theo tag:

```text
service
operation
endpoint
```

Đừng nhầm:

```text
Response time chart không tự chứng minh backlog đã chạy đủ.
Nó chỉ nói request latency.
```

Muốn biết job end-to-end, đọc thêm:

```text
shared_job_duration_ms
```

### Chart 2 — Execution timeline

Chart này trả lời:

```text
Backlog được drain theo thời gian như thế nào?
Mỗi bucket hoàn tất bao nhiêu iterations/http_reqs/jobs?
Có bucket nào có failed jobs không?
```

Kiểm tổng:

```text
sum(iterations buckets) == JOBS
sum(http_reqs buckets) == expected API calls
sum(shared_jobs_total buckets) == JOBS
sum(shared_jobs_failed buckets) == 0
```

Đừng nhầm:

```text
Mỗi point = 1 time bucket / metrics frame.
Không phải 1 request.
Không phải 1 job.
```

### Chart 3 — VUs vs iter/s

Chart này trả lời:

```text
Worker pool drain backlog nhanh/chậm ra sao?
VUs có gần configured worker count khi còn việc không?
iter/s có tụt/spike ở giai đoạn nào?
```

Đừng nhầm:

```text
VUs ổn định không có nghĩa mỗi VU làm số job bằng nhau.
Tail VUs tụt có thể chỉ nghĩa là backlog gần hết.
```

## Bảng tổng hợp 7 case

| # | Case | Business case | Expected work |
| --- | --- | --- | --- |
| 01 | Catalog audit | Audit fixed SKU/product backlog | `80 jobs × 2 API = 160 calls` |
| 02 | Order reconciliation | Reconcile pending/failed order backlog | `120 jobs × 2 API = 240 calls` |
| 03 | Payment webhook drain | Drain webhook backlog có duplicate | `100 jobs × 1 API = 100 calls` |
| 04 | Cart cleanup | Cleanup stale cart item backlog | `90 jobs × 2 API = 180 calls` |
| 05 | Cache warm | Warm fixed URL/cache-key backlog | `120 jobs × 1 API = 120 calls` |
| 06 | Report export batch | Create/status-poll/download report jobs | `60 jobs: create 60 + status polls >=60 + download 60` |
| 07 | CI verification batch | Fixed API checklist | `100 jobs × 1 API = 100 calls` |

## ⭐ 2 bài tiêu biểu nhất để dạy shared-iterations

Trong 7 case, đây là 2 bài **thực tế hay gặp nhất** và **bao quát toàn bộ tinh thần executor**:

### Bài 1: Case 01 — Catalog audit (`01_catalog-audit.md`)

**Vì sao chọn làm bài nền tảng:**

```text
Đây là "hello world" của shared-iterations.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | Sau deploy catalog, audit 80 SKU — mỗi SKU = 1 job, mỗi job = 2 HTTP requests (list + detail) |
| **Tinh thần executor** | Fixed backlog (80 jobs) được drain bởi worker pool (8 VU). Worker nhanh lấy thêm job, worker chậm làm ít hơn — đúng mô hình worker queue. |
| **Identity mapping** | Dùng `exec.scenario.iterationInTest` (0..79) để map job → SKU. KHÔNG dùng `__VU` vì worker identity ≠ business identity. Đây là bài học **quan trọng nhất** của shared-iterations. |
| **Công thức áp dụng** | Công thức 1 (chia kho), Công thức 3 (T_est), Công thức 5 (VU sizing) — cả 5 công thức TOP đều demo được trên case này. |
| **Output validation** | `shared_jobs_total == 80`, `shared_jobs_failed == 0`, `iterations == 80` — pass/fail rõ ràng, không ambiguous. |
| **Độ khó** | ⭐ — Single service, 2 API calls per job, không async, không external dependency. |

**Dạy trong bao lâu:** 30-45 phút — đi từ "vì sao cần shared-iterations", qua identity mapping, đến đọc output.

### Bài 2: Case 06 — Report export batch (`06_report-export-batch.md`)

**Vì sao chọn làm bài nâng cao:**

```text
Đây là case "thực chiến" nhất — async job lifecycle với polling,
đúng pattern của mọi hệ thống backend có job queue.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | 60 report export jobs, mỗi job: create → poll status đến khi complete → download artifact. Đây là pattern của **mọi** async backend job (export, import, build, deploy, encode, ML training...). |
| **Tinh thần executor** | Fixed backlog (60 jobs), worker pool (6 VU). Nhưng mỗi job kéo dài vì **polling loop** — worker bị giữ lâu hơn. → Dạy VU sizing: pool 6 VU cho 60 job async. |
| **Polling pattern** | Không phải 1 HTTP request = 1 job. Mỗi job có create + N lần poll status + download. Tổng API calls > iterations. Đây là bài học **phân biệt iteration vs API call**. |
| **Công thức áp dụng** | Công thức 1 (chia kho với polling — t_i không đều vì mỗi job cần số poll khác nhau), Công thức 3 (T_est với W_effective > HTTP latency). |
| **Output validation** | `report_job_create == 60`, `report_job_download == 60`, `report_job_status >= 60` — verify đủ lifecycle, không chỉ count iterations. |
| **Độ khó** | ⭐⭐⭐ — Multi-step async flow, polling loop, `202 processing` là expected (không phải bug). |

**Dạy trong bao lâu:** 45-60 phút — polling pattern cần thời gian để học viên hiểu "202 không phải lỗi".

### Lộ trình dạy 2 bài

```text
Buổi 1 (nền tảng): Case 01 Catalog audit
  1. Mental model: fixed backlog + worker pool
  2. Identity mapping: iterationInTest vs __VU
  3. Đọc output: iterations, shared_jobs_total, checks
  4. Demo: chạy thật, xem dashboard

Buổi 2 (nâng cao): Case 06 Report export batch
  1. Async job lifecycle: create → poll → download
  2. Polling pattern: vì sao API calls > iterations
  3. VU sizing với async job: W_effective bao gồm polling wait
  4. Đọc output: kiểm đủ lifecycle (create/status/download counts)
  5. So sánh với Case 01: sync vs async job
```

### Vì sao không chọn các case khác?

| Case | Vì sao không chọn làm bài chính? |
| --- | --- |
| 02 Order reconciliation | Tốt, nhưng giống Case 01 về pattern (2 API/job), khác biệt chính là business domain. Case 01 + 06 phủ rộng hơn. |
| 03 Payment webhook drain | Hay (duplicate handling, idempotency), nhưng trùng tinh thần batch drain. Nên dạy như bonus case nếu còn thời gian. |
| 04 Cart cleanup | Giống Case 01 (2 API/job: PATCH + GET), ít khác biệt về pattern. |
| 05 Cache warm | 1 API/job đơn giản, không có identity mapping phức tạp — quá đơn giản để làm bài đại diện. |
| 07 CI verification batch | Hay (5 operation types, split đều), nhưng gần với Case 01 về độ phức tạp. Case 06 có async pattern độc đáo hơn. |

## Thứ tự đề xuất học

```text
1. Đọc 00_overview.md để hiểu worker-pool/backlog mental model.
2. Đọc RUN_GUIDE.md để biết stack/env/run pattern.
3. Làm case 01 để hiểu audit backlog đơn giản.
4. Làm case 02/03 để hiểu reconciliation + idempotency/queue drain.
5. Làm case 04/05 để hiểu cleanup/cache warm.
6. Làm case 06 để hiểu job lifecycle nhiều API.
7. Làm case 07 để hiểu deterministic CI checklist.
```

## Reference

- Run guide: `./RUN_GUIDE.md`
- Shared-iterations quick index: `../../20260515_01_shared-iterations-quick-index.md`
- Tham số/công thức: `../../20260515_02_shared-iterations-tham-so-cong-thuc.md`
- Worked example: `../../20260515_03_shared-iterations-quickpizza-two-requests-worked-example.md`
- Per-vu comparison series: `../per-vu-iterations/00_overview.md`
