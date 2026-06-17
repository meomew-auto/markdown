# `per-vu-iterations`: tham số, ý nghĩa và công thức

File này gom riêng cách đọc executor `per-vu-iterations`: tham số nào nghĩa là gì, lấy ở đâu,
tính như thế nào, và khi chạy thật thì nhìn output nào để kiểm tra.

Nguồn docs Grafana:
<https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/per-vu-iterations/>

## Mục lục nhanh

Nếu chỉ muốn tra nhanh, mở file index ngắn:

```text
docs/20260514_01_per-vu-iterations-quick-index.md
```

Các link hay dùng trong file này:

- [Ý tưởng chính](#1-ý-tưởng-chính)
- [Khi nào dùng thực tế](#11-khi-nào-dùng-thực-tế)
- [Core chạy như nào](#12-core-chạy-như-nào)
- [Checklist core đã lọc](#13-checklist-core-đã-lọc-cho-per-vu-iterations)
- [Gom nhanh metric theo executor](#14-gom-nhanh-metric-theo-executor)
- [Flow tổng hợp: 1 lần chạy per-vu diễn ra như nào](#15-flow-tổng-hợp-1-lần-chạy-per-vu-iterations-diễn-ra-như-nào)
- [Bảng tham số tiếng Việt](#2-bảng-tham-số-tiếng-việt)
- [Công thức nền](#3-công-thức-nền)
- [Dùng `avg`, `med`, `p90`, `p95` của `iteration_duration`](#dùng-avg-med-p90-p95-của-iteration_duration-như-nào)
- [Core tính `min`, `max`, `med`, `p(90)`, `p(95)`](#core-tính-min-max-med-p90-p95-như-nào)
- [Demo mô phỏng nhanh/chậm](#6-demo-của-ta)
- [Chạy trực tiếp thì tìm tham số ở đâu](#7-chạy-trực-tiếp-thì-tìm-tham-số-ở-đâu)
- [Demo QuickPizza 1 request / iteration](#77-demo-chạy-thật-với-quickpizza)
- [Map output QuickPizza về giá trị và công thức](#772-map-ngược-từ-output-về-các-giá-trị-ở-đầu-file)
- [Demo QuickPizza 2 requests / iteration](#773-demo-quickpizza-với-1-iteration--2-http-requests)
- [So sánh 1 request và 2 requests / iteration](#774-khác-gì-so-với-case-1-iteration--1-http-request)
- [`sample`, `Gauge`, `vus`, `vus_max`](#78-sample-gauge-vus-vus_max-là-gì)
- [Cheat sheet ngắn](#8-cheat-sheet-ngắn)

## 1. Ý tưởng chính

`per-vu-iterations` nghĩa là:

```text
mỗi VU được giao cố định N iterations riêng của nó
các VU chạy concurrent/song song
VU nào xong sớm thì idle
VU nhanh không lấy thêm iteration của VU chậm
scenario kết thúc khi VU chậm nhất chạy xong phần việc của nó
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 2,
    },
  },
};
```

Hiểu là:

```text
VU 1 chạy 2 iterations
VU 2 chạy 2 iterations
VU 3 chạy 2 iterations

tổng iterations = 3 * 2 = 6
```

### 1.1. Khi nào dùng thực tế?

`per-vu-iterations` hợp khi bạn muốn:

```text
mỗi VU làm đúng N vòng
```

tức là workload được chốt theo:

- số VU
- số iteration của mỗi VU

Ví dụ thực tế:

```text
20 tài khoản test
mỗi tài khoản login -> xem dashboard -> tạo 3 đơn -> logout
mỗi tài khoản chạy đúng 5 lần
```

Lúc đó:

```text
vus = 20
iterations_per_vu = 5
total_iterations = 20 * 5 = 100
```

Một vài trường hợp hợp với `per-vu-iterations`:

- mỗi user/test account phải chạy đủ số vòng như nhau
- có bộ test data chia sẵn theo user
- muốn số iteration toàn test cố định để dễ so sánh giữa các lần run
- muốn benchmark một flow nghiệp vụ cố định, không phải giữ load theo thời gian

Một vài ví dụ khác:

```text
10 nhân viên test, mỗi người submit đúng 8 form
50 account học sinh, mỗi account làm đúng 3 bài quiz
30 user giả lập, mỗi user tạo đúng 10 booking
```

### Có ít dùng không?

Nếu đang nói về load test kiểu:

```text
hệ thống chịu được bao nhiêu user trong 30 phút?
hệ thống chịu được bao nhiêu req/s?
traffic tăng giảm theo thời gian ra sao?
```

thì `per-vu-iterations` thường **ít dùng hơn** các executor như:

- `constant-vus`
- `ramping-vus`
- `constant-arrival-rate`
- `ramping-arrival-rate`

Vì `per-vu-iterations` không sinh ra load profile theo thời gian. Nó sinh ra:

```text
fixed work per user
```

tức là:

```text
mỗi user/VU có một phần việc cố định
```

Nên cách nhớ thực tế:

```text
per-vu-iterations
  = fixed work per user/account

constant-vus / ramping-vus
  = fixed/ramping users over time

arrival-rate executors
  = fixed/ramping iteration rate over time
```

Kết luận:

```text
Nó không phải executor chính để mô phỏng traffic ngoài đời theo thời gian.
Nhưng nó rất đúng bài khi cần mỗi user/account chạy đủ số việc bằng nhau.
```

### Có phải biết trước số user và số vòng lặp không?

Thường là **có**.

Ít nhất bạn phải chủ động chốt trước:

```text
vus = bao nhiêu user/VU
iterations_per_vu = mỗi user chạy bao nhiêu vòng
```

Không nhất thiết hai số này phải là "sự thật ngoài đời" tuyệt đối, nhưng chúng phải là:

- giả định bạn muốn test
- hoặc workload bạn muốn cố định để đo

Ví dụ:

```text
không cần hệ thống thật đang có đúng 20 user
nhưng bạn quyết định test kịch bản 20 user, mỗi user 5 vòng
```

Vậy nên `per-vu-iterations` thường dùng khi bài test đã biết trước hoặc chủ động chốt:

```text
bao nhiêu user
bao nhiêu vòng mỗi user
```

### 1.2. Core chạy như nào?

Trong code executor:

```text
lib/executor/per_vu_iterations.go
```

description của executor là:

```text
N iterations for each of M VUs
```

Đây là điểm đầu tiên cần nhớ:

```text
iterations ở đây là số vòng mỗi VU
```

không phải:

```text
tổng iteration của scenario
```

Trong `Run()`:

- core lấy `numVUs`
- lấy `iterations = pvic.GetIterations()`
- rồi tự tính:

```text
totalIters = numVUs * iterations
```

Sau đó mỗi VU đi vào một vòng lặp riêng:

```text
for i := range iterations
```

tức là:

```text
mỗi VU tự chạy đúng số vòng của riêng nó
```

Hiểu đơn giản:

```text
mỗi VU được phát sẵn một xấp bài riêng
VU nhanh làm xong thì đứng yên
không sang lấy bài của VU chậm
```

Những điểm cần lưu ý thêm khi đọc core:

- **default config**: `vus = 1`, `iterations = 1`, `maxDuration = 10m`

- **validate**: `vus > 0`, `iterations > 0`, `maxDuration >= minDuration`

- **iterations của executor này là UNSCALED theo VU**:
  comment trong core nói rất rõ: chỉ scale số VU, không scale `iterations` theo cùng cách, để tránh hiệu ứng
  nhân đôi kiểu quadratic.

  Nghĩa đơn giản:
  - `vus`: số người làm việc
  - `iterations`: số vòng mỗi người phải làm

  Bình thường chạy local bằng `k6 run script.js` thì không cần nghĩ đến phần này. Khi đó k6 chạy
  toàn bộ test trên một process, hiểu nôm na là nhận đủ `0 -> 1` của bài test.

  Việc "chia test" xảy ra khi chạy cloud/distributed, hoặc khi tự truyền option kiểu:

  `k6 run --execution-segment 0:1/2 --execution-segment-sequence 0,1/2,1 script.js`

  Lệnh trên nghĩa là process này chỉ chạy nửa đầu của test. Nếu có process thứ hai chạy:

  `k6 run --execution-segment 1/2:1 --execution-segment-sequence 0,1/2,1 script.js`

  thì process thứ hai chạy nửa sau. Hai process này ghép lại mới thành 100% test gốc.

  Trong core, scheduler đọc `options.ExecutionSegment` và `options.ExecutionSegmentSequence`, rồi tạo
  `ExecutionTuple`. Sau đó executor gọi `GetVUs(et)`. Với `per-vu-iterations`, `GetVUs(et)` scale
  `vus`, còn `GetIterations()` trả nguyên `iterations`.

  Ví dụ test gốc: `10 VUs x 20 iterations/VU = 200 iterations`.

  Nếu chia làm 2 phần bằng nhau:

  Phần A nhận nửa đầu: `5 VUs x 20 iterations/VU = 100 iterations`.

  Phần B nhận nửa sau: `5 VUs x 20 iterations/VU = 100 iterations`.

  Cộng A và B lại: `100 + 100 = 200 iterations`. Tổng vẫn đúng bằng test gốc.

  Nếu scale cả `vus` lẫn `iterations`, mỗi phần sẽ thành:

  Phần A: `5 VUs x 10 iterations/VU = 50 iterations`.

  Phần B: `5 VUs x 10 iterations/VU = 50 iterations`.

  Cộng A và B lại chỉ còn: `50 + 50 = 100 iterations`. Tổng bị thiếu một nửa.

  Đó là lý do core chỉ scale `vus`, không scale `iterations`.

- **planned VUs được reserve sẵn**:
  `GetExecutionRequirements()` reserve đúng `vus` từ đầu đến
  `maxDuration + gracefulStop`.
  Việc initialize planned VUs xảy ra trong scheduler init phase, trước khi executor `Run()`.
  Thời gian tạo các planned VUs này không tính vào `maxDuration` của scenario. Nếu `vus` rất lớn,
  wall-clock từ lúc bấm `k6 run` có thể lâu hơn, nhưng `exec.scenario.startTime` và
  `maxDuration` bắt đầu sau khi init planned VUs xong.

- **executor mới bắt đầu tính thời gian khi Run()**:
  trong core, `Run()` gọi `getDurationContexts()`, và helper này set `startTime = time.Now()`.
  Đây là mốc dùng cho `maxDuration`, `gracefulStop` và `exec.scenario.startTime`.

- **khi Run() thì executor lấy đủ `vus` ra chạy song song**:
  với `per-vu-iterations`, sau khi init đủ planned VUs, executor gọi `GetPlannedVU(..., true)`
  đúng `vus` lần, rồi start mỗi VU bằng `go handleVU(initializedVU)`.
  Nghĩa là lúc bắt đầu executor:
  ```text
  vus = 4
  -> k6 init đủ 4 planned VUs
  -> executor lấy 4 VUs ra khỏi pool
  -> 4 VUs chạy concurrent/song song
  ```
  Nhưng mỗi VU chạy iteration tuần tự trong chính nó:
  ```text
  VU 1: iter 0 -> iter 1 -> iter 2
  VU 2: iter 0 -> iter 1 -> iter 2
  ```
  Với executor này, mỗi VU có quota riêng, nên VU nhanh xong quota sẽ idle, không sang lấy việc
  của VU chậm.
  Nghĩa là phải tách:
  ```text
  VU đã được start / active
  !=
  VU đang thật sự bận chạy iteration
  ```
  Về cuối test có thể:
  ```text
  4 VU đã được start
  nhưng chỉ còn 2 VU chậm đang bận
  2 VU nhanh đã xong quota và idle
  ```

- **`doneIters` chỉ là progress counter nội bộ**:
  nó dùng cho progress bar `xx/yy iters, z per VU`, không phải chính metric summary `iterations`.

- **`dropped_iterations` emit theo từng VU còn dở**:
  nếu chạm `maxDuration` giữa chừng, mỗi VU sẽ push số iteration còn lại của riêng nó vào
  `DroppedIterations`.

- **hết `maxDuration` thì không start iteration mới nữa**:
  vòng lặp VU check `regDurationDone` trước khi gọi `runIteration()`.

- **không có work stealing**:
  đây là khác biệt cốt lõi so với `shared-iterations`.

### 1.3. Checklist core đã lọc cho `per-vu-iterations`

| Core | Hành vi thật | Ý nghĩa khi đọc bài |
| --- | --- | --- |
| `per_vu_iterations.go:NewPerVUIterationsConfig()` | default `vus = 1`, `iterations = 1`, `maxDuration = 10m` | Thiếu config thì executor vẫn có quota mặc định nhỏ. |
| `per_vu_iterations.go:GetVUs()` | scale `vus` qua execution tuple | Local thường bằng config; segmented/distributed run phải dùng số đã scale. |
| `per_vu_iterations.go:GetIterations()` | trả về `iterations` nguyên bản | `iterations` là quota mỗi VU, không bị nhân/scale kiểu tổng work. |
| `per_vu_iterations.go:GetExecutionRequirements()` | reserve planned VUs tới `maxDuration + gracefulStop` | Planned VUs init trước execution; không có unplanned VUs cho executor này. |
| `per_vu_iterations.go:Run()` | tính `totalIters = numVUs * iterations` cho progress | Đây là planned work, không phải metric `iterations` trong summary. |
| `per_vu_iterations.go:handleVU()` | mỗi VU tự chạy `for i := range iterations` | Không có work stealing; VU nhanh xong quota thì idle. |
| `per_vu_iterations.go:regDurationDone` | trước mỗi iteration mới, nếu hết `maxDuration` thì emit phần quota còn lại vào `DroppedIterations` | `dropped_iterations` là iteration chưa từng start của VU đó. |
| `helpers.go:getDurationContexts()` | `maxDuration` là regular duration, `gracefulStop` là cửa sổ chờ sau đó | Hết `maxDuration` ngừng start mới; iteration đang chạy có thể finish trong grace. |
| `internal/js/runner.go:RunOnce()` + `iterationSamples()` | `iterations`/`iteration_duration` chỉ emit khi full iteration hoàn tất | `completed_iterations` đọc từ metric, không lấy từ planned quota nếu có drop/interrupt. |
| `internal/js/runner.go` min duration path | `iteration_duration` emit trước sleep bù `minIterationDuration` | Capacity phải dùng `effective_iteration_time`, không dùng riêng `iteration_duration` khi có min. |
| `scheduler.go:emitVUsAndVUsMax()` | `vus`/`vus_max` sample từ active/initialized VUs | Gauge sample theo thời điểm, không phải Counter. |

### 1.4. Gom nhanh metric theo executor

Nếu muốn đọc `per-vu-iterations` thật nhanh, chỉ cần nhớ:

| Metric | Type | Sample đếm như nào | Khi nào emit | Đọc nhanh |
| --- | --- | --- | --- | --- |
| `iterations` | `Counter` | 1 sample cho mỗi iteration hoàn chỉnh, `value = 1` | `internal/js/runner.go:RunOnce()` khi iteration xong | tổng số iteration hoàn thành |
| `iteration_duration` | `Trend` | 1 sample cho mỗi iteration hoàn chỉnh, `value = endTime - startTime` | cùng path với `iterations` | thời gian của 1 iteration hoàn chỉnh |
| `dropped_iterations` | `Counter` | khi hết `maxDuration`, mỗi VU emit 1 sample với `value = iterations - i` | `lib/executor/per_vu_iterations.go` trước khi start iteration tiếp theo | số iteration còn lại bị cắt |
| `vus` | `Gauge` | sample theo nhịp 1 giây, `value = active VUs` | `scheduler.go:emitVUsAndVUsMax()` | VU đang active tại thời điểm sample |
| `vus_max` | `Gauge` | sample theo nhịp 1 giây, `value = initialized VUs` | `scheduler.go:emitVUsAndVUsMax()` | VU đã init / reserve |

Hai metric chung của script vẫn áp dụng như bình thường:

```text
http_reqs, checks, data_sent, data_received
```

Nhưng trong `per-vu-iterations`, ba thứ dễ bị đọc nhầm nhất là:

```text
iterations
iteration_duration
dropped_iterations
```

Vì vậy khi xem summary của executor này, đọc theo thứ tự:

```text
1. vus / vus_max
2. iterations / iteration_duration
3. dropped_iterations nếu có
4. rồi mới soi http_reqs, checks, data_sent, data_received
```

### 1.5. Flow tổng hợp: 1 lần chạy `per-vu-iterations` diễn ra như nào?

Phần này gom các mảnh rải rác ở trên (core chạy 1.2, metric 1.4, công thức
mục 3) thành 1 mạch kể theo timeline, để hình dung trọn vẹn 1 lần chạy.

**Ví dụ đời thường trước** (để bám theo cả flow):

```text
Lớp học có 8 học sinh (= 8 VU), mỗi em phải làm ĐÚNG 5 bài (= iterations).
  - Phát đề: mỗi em nhận 1 xấp 5 bài RIÊNG
  - Làm bài: 8 em làm SONG SONG, mỗi em làm tuần tự bài 1->5 của mình
  - Em nào xong 5 bài thì NGỒI CHƠI (không làm hộ bạn)
  - Hết giờ (maxDuration): em nào chưa xong -> bài còn lại bị BỎ (dropped)
  - Lớp tan khi em CHẬM NHẤT làm xong (hoặc hết giờ)
```

**Timeline 6 giai đoạn** (config demo: `vus=8, iterations=5, sleep~2.45s/iter`):

```text
Giai đoạn 1 — INIT (trước khi tính giờ)
  k6 tạo 8 V8 isolate (= 8 VU), mỗi isolate là 1 JS runtime riêng
  -> chạy import + module-level scope 1 lần cho mỗi VU
  -> let session=null, totalCartItems=0 khởi tạo (chưa có giá trị thật)
  (thời gian init KHÔNG tính vào maxDuration — xem 1.2)

Giai đoạn 2 — SPAWN (t=0, startTime bắt đầu)
  executor lấy đúng 8 planned VU ra, start song song:
    go handleVU(VU1) ... go handleVU(VU8)
  -> 8 VU cùng vào vòng lặp riêng "for i in 0..5"

Giai đoạn 3 — ITER 0 (mỗi VU setup state)
  Mỗi VU chạy default() lần đầu (__ITER=0):
    if (__ITER === 0) session = login();   // ghi vào module-level
  -> session, token bây giờ CÓ giá trị thật, GIỮ cho các iter sau

Giai đoạn 4 — ITER 1..4 (đọc lại state, không login lại)
  Mỗi VU chạy default() tiếp, __ITER=1,2,3,4:
    session VẪN còn (module-level sống qua iter) -> KHÔNG login lại
    totalCartItems += 2 mỗi iter -> tích lũy 2,4,6,8,10
  -> mỗi VU chạy TUẦN TỰ trong chính nó: iter0->1->2->3->4

Giai đoạn 5 — VU XONG QUOTA -> IDLE
  VU nhanh xong 5 iter trước -> NGỒI CHƠI (active nhưng không bận)
  VU chậm vẫn đang chạy
  -> phân biệt: "VU active" != "VU đang bận chạy iter" (xem 1.2)
  -> nếu chạm maxDuration: VU chưa xong -> dropped_iterations += số iter còn lại

Giai đoạn 6 — KẾT THÚC
  Lớp tan khi VU chậm nhất xong (hoặc hết maxDuration)
  Tổng iterations = 8 × 5 = 40 (nếu không drop)
```

**Code thật minh họa giai đoạn 3-4** (từ `examples/per-vu-iterations/pvi-01-user-journey-replay.js`):

```js
// Module-level: GIỮ qua iter (giai đoạn 1 khởi tạo, 3-4 dùng)
let session = null;
let totalCartItems = 0;

export default function () {
  // Giai đoạn 3: iter 0 setup state
  if (__ITER === 0) {
    session = login();        // ghi module-level -> sống qua iter
  }

  // Giai đoạn 4: iter 1-4 đọc lại state cũ
  addToCart(...);             // totalCartItems += 1 (tích lũy)
  // session vẫn dùng được, KHÔNG login lại
}
```

**Throughput của flow này** (vì 8 VU song song — xem mục 3 + công thức):

```text
1 iter mất ~2.45s (iteration_duration), NHƯNG 8 VU chạy song song
-> rate = vus / iter_time = 8 / 2.45 ≈ 3.27 iter/s

Đừng nhầm: iteration_duration đo 1 iter LẺ, iterations rate đo CẢ POOL.
(Chi tiết nghịch lý này: xem practice case 01, section "Nghịch lý throughput")
```

**Bản đồ tới các section chi tiết**:

```text
Giai đoạn 1-2 (init, spawn)     -> mục 1.2 "Core chạy như nào"
Giai đoạn 3-4 (state qua iter)  -> practice case 01 "state KHÔNG mất"
Giai đoạn 5 (idle, drop)        -> mục 1.4 + "Demo dropped iterations" dưới
Throughput                       -> mục 3 "Công thức nền" + 8.1 CT throughput
```

### Demo dropped iterations do `maxDuration`

Grafana docs cho ý này:

```text
với shared-iterations và per-vu-iterations
iterations sẽ bị drop nếu scenario chạm maxDuration trước khi toàn bộ iterations finish
```

Với `per-vu-iterations`, phải hiểu đúng là:

```text
hết maxDuration
-> k6 không start iteration mới nữa
-> iteration nào chưa kịp start sẽ đi vào dropped_iterations
```

Nếu iteration đang chạy dở mà vẫn finish kịp trong `gracefulStop`, nó vẫn được tính là `complete`,
không phải `dropped`.

Nếu muốn mitigate theo docs thì với executor này thường là:

```text
tăng maxDuration
```

chứ không phải field `duration`, vì `per-vu-iterations` không có option `duration`.

File demo:

```text
examples/per_vu_iterations_dropped_demo.js
```

Command:

```bash
k6 run examples/per_vu_iterations_dropped_demo.js
```

Config:

```text
vus = 1
iterations = 3
maxDuration = 3s
gracefulStop = 2s
sleep(2) trong mỗi iteration
```

Timeline chạy thật:

```text
t=0.0s  iter 0 start
t=2.0s  iter 0 end
t=2.0s  iter 1 start
t=4.0s  iter 1 end

iter 2 khong duoc start
vi maxDuration da het tu t=3.0s
```

Output chính đã chạy:

```text
scenarios:
  * per_vu_dropped_demo: 3 iterations for each of 1 VUs (maxDuration: 3s, gracefulStop: 2s)

EXECUTION
  dropped_iterations...: 1   0.24992/s
  iterations...........: 2   0.499839/s

running (4.0s), 0/1 VUs, 2 complete and 0 interrupted iterations
```

Đọc ra:

```text
tổng mục tiêu = 3 iterations
thực tế complete = 2
interrupted = 0
dropped_iterations = 1
```

Vì sao drop?

```text
iter 2 chưa kịp start trước khi hết maxDuration
```

Đây chính là ý docs đang nói.

### Khi nào không nên dùng?

Không nên dùng khi mục tiêu của bạn là:

```text
giữ số user ổn định trong 10 phút
hoặc giữ 100 requests/s
```

Vì đó là bài toán theo:

- thời gian
- hoặc throughput mục tiêu

lúc đó thường hợp hơn với:

- `constant-vus`
- `ramping-vus`
- `constant-arrival-rate`
- `ramping-arrival-rate`

## 2. Bảng tham số tiếng Việt

| Tên trong k6 / ký hiệu | Dịch tiếng Việt | Lấy ở đâu | Cách tính / quy đổi | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | kiểu chạy | `options.scenarios.<name>.executor` | `executor = "per-vu-iterations"` | Chọn chiến lược chạy. Ở đây là `per-vu-iterations`. |
| `vus` | số VU | `options.scenarios.<name>.vus` | lấy trực tiếp từ config | Số Virtual Users được dùng cho scenario. |
| `iterations` | trường cấu hình số vòng mỗi VU | `options.scenarios.<name>.iterations` | lấy trực tiếp từ config | Đây là field trong config. Với `per-vu-iterations`, nó nghĩa là số iteration cho **mỗi VU**, không phải tổng toàn test. |
| `iterations_per_vu` | ký hiệu công thức: số vòng mỗi VU | ký hiệu mình dùng | `iterations_per_vu = iterations` | Đây không phải field riêng của k6. Nó chỉ là tên mình đặt trong công thức, và bằng giá trị `iterations` trong scenario. |
| `maxDuration` | trần thời gian chạy bình thường | `options.scenarios.<name>.maxDuration` | lấy trực tiếp từ config | Sau mốc này k6 không start iteration mới cho scenario. |
| `gracefulStop` | thời gian chờ dừng mềm | `options.scenarios.<name>.gracefulStop` | lấy trực tiếp từ config | Cho iteration đang chạy dở thêm thời gian để kết thúc. |
| `minIterationDuration` | thời gian tối thiểu mỗi iteration | global option, cùng cấp `scenarios` | lấy trực tiếp từ global options | Nếu iteration chạy ngắn hơn min, k6 sleep bù sau function. Phần sleep bù này không nằm trong `iteration_duration`. |
| `js_iteration_time_i` | thời gian JS thật của 1 iteration | đo/ước lượng | `code JS + HTTP + check + sleep()` trong function | Thời gian chạy code trong `default()` hoặc function `exec`: JS code, HTTP call, `check()`, `sleep()` tự viết. |
| `t_i` | thời gian chiếm VU cho 1 iteration | ký hiệu mình dùng | nếu không có min: `t_i = js_iteration_time_i`; có min: `t_i = max(js_iteration_time_i, minIterationDuration)` | Bằng `js_iteration_time_i`, hoặc bị kéo lên bởi `minIterationDuration`. |
| `vu_runtime_i` | thời gian chạy hết việc của VU thứ i | tự tính | `vu_runtime_i ≈ iterations_per_vu * t_i` | Thời gian VU thứ i cần để chạy đủ `iterations_per_vu`. |
| `total_iterations` | tổng số iteration theo kế hoạch | tự tính | `total_iterations = vus * iterations_per_vu` | Nếu không bị interrupt/drop: `vus * iterations_per_vu`. |
| `completed_iterations` | số iteration hoàn thành thật | k6 output | clean run thường đọc từ progress `... complete` hoặc summary `iterations` | Trong clean run hai chỗ này thường trùng. Edge case context chết trong sleep bù `minIterationDuration` có thể làm summary `iterations` đã tăng nhưng progress vẫn báo interrupted. |
| `actual_scenario_runtime` | thời gian scenario chạy thật theo mô hình giải thích của bài | output / tự ước lượng | `actual_scenario_runtime ≈ max(vu_runtime_i)` | Với `per-vu-iterations`, thường gần thời gian của VU chậm nhất. Đây là đại lượng trực giác để hiểu scenario, không phải lúc nào cũng trùng mẫu số `/s` của summary. |
| `peak_iteration_rate_if_all_vus_active` | tốc độ iteration cao nhất khi tất cả VU còn active | tự tính | `sum(1 / t_i)` | Không phải metric core k6. Dùng để dự đoán peak. |
| `average_iteration_rate` | tốc độ iteration trung bình nhìn từ summary | k6 summary / tự tính | `completed_iterations / summary_runtime_base` | Trong demo 1 scenario sạch, `summary_runtime_base` thường gần `actual_scenario_runtime`, nên hai cách nhìn gần nhau. |
| `vus` metric | số VU active tại thời điểm sample | k6 metric | đọc trong progress `02/10 VUs` hoặc summary `vus` | Gauge, lấy từ active VU count trong core. |
| `vus_max` metric | số VU đã initialized | k6 metric | đọc trong header / summary `vus_max` | Gauge, thường bằng số VU được tạo/reserve. |
| `iteration_duration` metric | thời gian 1 iteration hoàn chỉnh | k6 metric | đọc trong summary `iteration_duration`; core tính `endTime - startTime` | Trend, đo từ lúc k6 bắt đầu gọi JS function đến lúc function xong. |

Ghi nhớ nhanh:

```text
iterations_per_vu = iterations
```

Trong `per-vu-iterations`, `iterations` không phải tổng toàn test. Nó là số vòng của mỗi VU.

### Quy ước tên trong file này

Để không bị đổi tên giữa chừng, file này dùng thống nhất các tên sau:

```text
iterations_per_vu
  số vòng mỗi VU

js_iteration_time_i
  thời gian JS thật của 1 iteration ở VU thứ i

t_i
  thời gian chiếm VU của 1 iteration ở VU thứ i

vu_runtime_i
  thời gian VU thứ i chạy hết phần việc của nó

actual_scenario_runtime
  thời gian scenario chạy thật

peak_iteration_rate_if_all_vus_active
  tốc độ iteration cao nhất khi tất cả VU còn active

average_iteration_rate
  tốc độ iteration trung bình toàn test
```

Khi các VU giống hệt nhau, mình sẽ viết:

```text
mọi VU có cùng t_i = t
```

rồi dùng `t` trong công thức rút gọn.

## 3. Công thức nền

Tổng số iterations nếu test không bị interrupt/drop:

```text
total_iterations = vus * iterations_per_vu
```

Thời gian chiếm VU của 1 iteration:

```text
nếu không có minIterationDuration:
  t_i = js_iteration_time_i

nếu có minIterationDuration:
  t_i = max(js_iteration_time_i, minIterationDuration)
```

Tốc độ iteration của một VU:

```text
per_vu_rate_i = 1 / t_i
```

Vì sao là `1 / t_i`?

```text
t_i = số giây để VU i chạy xong 1 iteration
per_vu_rate_i = số iteration VU i chạy được trong 1 giây
```

Đổi đơn vị:

```text
nếu 1 iteration mất 0.5s:
  per_vu_rate_i = 1 / 0.5 = 2 iters/s

nếu 1 iteration mất 0.2s:
  per_vu_rate_i = 1 / 0.2 = 5 iters/s

nếu 1 iteration mất 2s:
  per_vu_rate_i = 1 / 2 = 0.5 iters/s
```

Nói cách khác:

```text
t_i càng nhỏ -> VU chạy càng nhanh -> iters/s càng lớn
t_i càng lớn -> VU chạy càng chậm -> iters/s càng nhỏ
```

Vậy `t_i` lấy ở đâu?

```text
1. Nếu script có thời gian cố định:
   t_i có thể ước lượng từ code.

2. Nếu script có HTTP/network thật:
   t_i chỉ ước lượng trước được.
   Muốn biết gần đúng phải chạy thử và nhìn `iteration_duration`.

3. Nếu có `minIterationDuration`:
   t_i = max(js_iteration_time_i, minIterationDuration)
```

Ví dụ tự biết trước từ code:

```js
export default function () {
  sleep(0.5);
}
```

Gần đúng:

```text
js_iteration_time_i ≈ 0.5s
t_i ≈ 0.5s
per_vu_rate_i ≈ 1 / 0.5 = 2 iters/s
```

Ví dụ chỉ biết sau khi chạy thử:

```js
export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

Lúc này `t_i` phụ thuộc response time, network, máy chạy, server. Cách thực tế:

```text
chạy thử một lần
nhìn metric iteration_duration
lấy avg/med/p95 tùy mục đích để ước lượng t_i
```

Nếu summary có:

```text
iteration_duration...: avg=515ms
```

thì có thể ước lượng:

```text
t_i ≈ 0.515s
per_vu_rate_i ≈ 1 / 0.515 ≈ 1.94 iters/s
```

### Dùng `avg`, `med`, `p90`, `p95` của `iteration_duration` như nào?

`iteration_duration` là metric dạng Trend, nên summary có nhiều số:

```text
iteration_duration...: avg=260ms min=200ms med=200ms max=500ms p(90)=500ms p(95)=500ms
```

Không có một số luôn đúng cho mọi trường hợp. Chọn số nào tùy câu hỏi đang hỏi.

```text
avg
  trung bình toàn bộ iterations
  dùng khi muốn ước tốc độ trung bình toàn test

med
  median, tức 50% iteration nhanh hơn hoặc bằng số này
  dùng khi muốn nhìn iteration "điển hình"

p90 / p95
  90% / 95% iteration nhanh hơn hoặc bằng số này
  dùng khi muốn ước lượng bảo thủ hơn, nghiêng về phía chậm

min
  iteration nhanh nhất
  dùng để nhận diện nhóm nhanh hoặc giới hạn nhanh nhất

max
  iteration chậm nhất
  dùng để nhìn worst case quan sát được, nhưng dễ bị outlier
```

Ví dụ demo:

```text
iteration_duration...: avg=260ms min=200ms med=200ms max=500ms p(90)=500ms p(95)=500ms
```

Đọc:

```text
min ≈ 200ms
  có nhóm iteration nhanh khoảng 0.2s

med ≈ 200ms
  phần lớn iteration thuộc nhóm nhanh

p90/p95 ≈ 500ms
  phía chậm là khoảng 0.5s

avg ≈ 260ms
  trung bình trộn giữa nhóm nhanh và nhóm chậm
```

Ở đây "nhóm VU" nghĩa là nhiều VU có cùng thời gian iteration gần giống nhau. Summary
`iteration_duration` không đếm theo VU, mà đếm theo **từng iteration đã hoàn thành**.

Với demo 10 VUs:

```text
fast_vus = 8
slow_vus = 2
iterations_per_vu = 20
```

Số iteration của từng nhóm:

```text
fast_iterations = fast_vus * iterations_per_vu
                = 8 * 20
                = 160 iterations

slow_iterations = slow_vus * iterations_per_vu
                = 2 * 20
                = 40 iterations

total_iterations = 160 + 40 = 200
```

Vì vậy `avg iteration_duration` là trung bình theo **200 iterations**, không phải trung bình theo
10 VUs:

```text
avg_iteration_duration
  ≈ (fast_iterations * t_fast + slow_iterations * t_slow) / total_iterations
  ≈ (160 * 0.2s + 40 * 0.5s) / 200
  = (32s + 20s) / 200
  = 52s / 200
  = 0.26s
  = 260ms
```

Ví dụ nhỏ hơn với 3 VUs:

```text
vus = 3
iterations_per_vu = 2

VU 1 nhanh: t = 0.2s
VU 2 nhanh: t = 0.2s
VU 3 chậm:  t = 0.5s
```

Số iteration:

```text
fast_vus = 2
slow_vus = 1

fast_iterations = 2 * 2 = 4
slow_iterations = 1 * 2 = 2
total_iterations = 3 * 2 = 6
```

Average duration:

```text
avg_iteration_duration
  ≈ (4 * 0.2s + 2 * 0.5s) / 6
  = (0.8s + 1.0s) / 6
  = 1.8s / 6
  = 0.3s
  = 300ms
```

Nên nếu có 3 VUs như trên, summary `iteration_duration avg` có thể gần `300ms`, dù không có VU nào
thực sự chạy đúng `300ms/iteration`. Đó chỉ là trung bình trộn của 4 iteration nhanh và 2 iteration
chậm.

Nếu mục tiêu là tính trung bình toàn test:

```text
t ≈ avg = 0.260s
```

Nếu mục tiêu là tính theo nhóm:

```text
t_fast ≈ min/med ≈ 0.2s
t_slow ≈ p90/p95/max ≈ 0.5s
```

#### Runtime bảo thủ là gì?

`Runtime bảo thủ` nghĩa là mình cố tình ước lượng theo hướng **chậm hơn / an toàn hơn**, để tránh
dự đoán quá lạc quan.

Ví dụ có 1 VU chạy 20 iterations.

Nếu dùng median:

```text
t = med = 0.2s
vu_runtime ≈ 20 * 0.2s = 4s
```

Nếu dùng p95:

```text
t = p95 = 0.5s
vu_runtime ≈ 20 * 0.5s = 10s
```

Dự đoán `10s` là bảo thủ hơn `4s`, vì nó giả định iteration sẽ nghiêng về phía chậm.

Khi dùng để capacity planning hoặc trả lời câu hỏi kiểu "liệu test có kịp xong trong
`maxDuration` không?", dùng `p90`/`p95` thường an toàn hơn dùng `avg` hoặc `med`.

Nhưng nếu muốn tính throughput trung bình đã xảy ra trong một lần chạy, summary `iterations/s` và
`avg` lại hữu ích hơn.

Nói rõ hơn: đây không phải một "luật cố định" áp dụng y hệt cho mọi executor.
Nó là cách chọn số đo theo câu hỏi đang hỏi.

Nếu câu hỏi là:

`lần chạy vừa rồi trung bình đạt bao nhiêu?`

thì dùng số đã xảy ra:

- `iterations/s` trong summary
- `http_reqs/s` nếu đang hỏi RPS HTTP
- `iteration_duration.avg` nếu muốn biết trung bình một iteration mất bao lâu

Nếu câu hỏi là:

`lần chạy sau nên chuẩn bị bao nhiêu VU?`

hoặc:

`liệu có kịp xong trước maxDuration không?`

thì dùng `p90`/`p95` thường hợp hơn, vì nó không giả định mọi iteration đều chạy đẹp như trung bình.

Áp dụng theo nhóm executor:

| Nhóm executor | Dùng `p90`/`p95` để làm gì? | Không nên hiểu nhầm |
| --- | --- | --- |
| `per-vu-iterations` | Ước lượng VU chậm có kịp chạy đủ `iterations` trước `maxDuration` không. | `p95` không phải throughput đã xảy ra. |
| `shared-iterations` | Ước lượng tổng work có nguy cơ kéo dài quá `maxDuration` không. | Work được chia động, không phải mỗi VU có quota bằng nhau. |
| `constant-vus`, `ramping-vus` | Ước lượng capacity theo kiểu `iterations/s ≈ active_vus / W`. Với dự báo an toàn, lấy `W = p90/p95`. | Summary `iterations/s` vẫn là số thực tế đã chạy, không cần tự tính lại nếu chỉ đọc kết quả. |
| `constant-arrival-rate`, `ramping-arrival-rate` | Ước lượng cần bao nhiêu VU để kịp rate: `required_vus ≈ rate * W`. Với dự báo an toàn, lấy `W = p90/p95`. | Rate start iteration do lịch arrival-rate điều khiển, không phải do VU tự loop. |

Tóm lại:

- đọc kết quả đã xảy ra: ưu tiên summary rate/count/avg
- dự báo hoặc sizing: ưu tiên p90/p95 + hệ số an toàn nếu workload dao động

### Core tính `min`, `max`, `med`, `p(90)`, `p(95)` như nào?

Với `iteration_duration`, core dùng `TrendSink`.

Code chính:

```text
metrics/sink.go:
  TrendSink.Add(sample)
    - append giá trị vào mảng values
    - cập nhật min
    - cập nhật max
    - cộng sum
    - tăng count

  TrendSink.Avg()
    = sum / count

  TrendSink.Min()
    = min nhỏ nhất đã thấy

  TrendSink.Max()
    = max lớn nhất đã thấy

  TrendSink.P(pct)
    - sort mảng values nếu chưa sort
    - tính vị trí i = pct * (count - 1)
    - lấy 2 điểm kề nhau
    - nội suy tuyến tính nếu i rơi giữa 2 index
```

`med` không có công thức riêng. Trong core:

```text
med = P(0.5)
p(90) = P(0.90)
p(95) = P(0.95)
```

Mapping này nằm ở:

```text
metrics/sample.go:
  "avg" -> s.Avg()
  "min" -> s.Min()
  "med" -> s.P(0.5)
  "max" -> s.Max()
  "p(90)" / "p(95)" -> s.P(...)
```

#### Áp vào chính demo `per-vu-iterations`

Demo có:

```text
8 VUs nhanh * 20 iterations = 160 iteration_duration khoảng 0.2s
2 VUs chậm * 20 iterations = 40 iteration_duration khoảng 0.5s

tổng = 200 samples của metric iteration_duration
```

Nếu tạm đơn giản hóa thành:

```text
160 giá trị = 0.2
40 giá trị = 0.5
```

thì sau khi sort:

```text
index 0..159   = 0.2
index 160..199 = 0.5
```

`min`:

```text
min = giá trị nhỏ nhất = 0.2
```

`max`:

```text
max = giá trị lớn nhất = 0.5
```

`avg`:

```text
avg = (160 * 0.2 + 40 * 0.5) / 200
    = 0.26
    = 260ms
```

`med = P(0.5)`:

```text
count = 200
i = 0.5 * (200 - 1) = 99.5

j = values[floor(99.5)] = values[99]  = 0.2
k = values[ceil(99.5)]  = values[100] = 0.2

med = j + (k - j) * 0.5
    = 0.2
```

Vì sample thứ 100 và 101 vẫn còn nằm trong nhóm nhanh.

`p(90) = P(0.90)`:

```text
i = 0.90 * 199 = 179.1

j = values[179] = 0.5
k = values[180] = 0.5

p(90) = 0.5
```

`p(95) = P(0.95)`:

```text
i = 0.95 * 199 = 189.05

j = values[189] = 0.5
k = values[190] = 0.5

p(95) = 0.5
```

Nên với demo này, nếu bỏ qua jitter:

```text
min ≈ 200ms
med ≈ 200ms
p(90) ≈ 500ms
p(95) ≈ 500ms
max ≈ 500ms
avg ≈ 260ms
```

#### Vì sao output thật lại là `200.05ms`, `500.39ms` thay vì đúng `200ms`, `500ms`?

Vì demo thật không sinh ra các số hoàn hảo tuyệt đối. `sleep(0.2)` và `sleep(0.5)` vẫn có:

```text
độ trễ timer
Go scheduler
chi phí log / event loop / runtime
độ lệch khi lấy time.Now()
```

Nên các sample thật sẽ kiểu:

```text
200.05ms
200.31ms
500.39ms
500.52ms
...
```

Core vẫn tính y hệt như trên, chỉ là input values không còn là `0.2` và `0.5` tuyệt đối nữa.

### Vậy lắp công thức thực tế có cần chạy mới biết không?

Phần lớn là:

```text
có
```

Nếu chỉ nhìn config, ta **biết chắc** được các đại lượng kiểu "khối lượng công việc đã khai báo":

```text
vus
iterations_per_vu
total_iterations = vus * iterations_per_vu
maxDuration
gracefulStop
scenario_max_end = maxDuration + gracefulStop
```

Nhưng nếu script có HTTP/network thật, ta **chưa đủ dữ liệu** để biết chính xác:

```text
t_i
per_vu_rate_i
vu_runtime_i
actual_scenario_runtime
peak_iteration_rate_if_all_vus_active
average_iteration_rate
```

Vì các đại lượng này phụ thuộc vào:

```text
response time thật của server
network latency
CPU của máy chạy k6
logic branch trong JS
check() mất bao lâu
số request trong 1 iteration
minIterationDuration có kéo dài iteration hay không
```

Nên cần phân biệt 2 mức:

```text
1. Tính trước từ config:
   dùng để biết quy mô workload và trần thời gian

2. Ước lượng / đo sau khi chạy:
   dùng để biết tốc độ thật và runtime thật
```

Ví dụ nếu chỉ có:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 20,
    },
  },
};

export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

thì trước khi chạy ta chỉ biết chắc:

```text
vus = 10
iterations_per_vu = 20
total_iterations = 200
```

Nhưng chưa biết chắc:

```text
mỗi iteration mất bao lâu
1 VU chạy được bao nhiêu iters/s
test sẽ kết thúc gần 3s, 10s hay 40s
```

Muốn biết phần đó, phải chạy thử ít nhất một lần.

Kết luận ngắn:

```text
config cho ta workload shape
run thực tế mới cho ta runtime shape
```

Peak khi tất cả VU còn active:

```text
peak_iteration_rate_if_all_vus_active = sum(1 / t_i)
```

Nếu tất cả VU giống nhau:

```text
mọi VU có cùng t_i = t
peak_iteration_rate_if_all_vus_active ≈ vus / t
```

Runtime của từng VU:

```text
vu_runtime_i ≈ iterations_per_vu * t_i
```

Runtime của scenario:

```text
actual_scenario_runtime ≈ max(vu_runtime_i)
```

Average iteration rate:

```text
average_iteration_rate = completed_iterations / summary_runtime_base
```

Nếu không bị interrupt/drop:

```text
average_iteration_rate ≈ (vus * iterations_per_vu) / max(vu_runtime_i)
```

Trần thời gian cứng của scenario:

```text
scenario_max_end = startTime + maxDuration + gracefulStop
```

Nếu không khai báo `startTime` riêng:

```text
scenario_max_end ≈ maxDuration + gracefulStop
```

## 4. `js_iteration_time_i` gồm những gì?

`js_iteration_time_i` là thời gian JS function thật sự chạy. Trong core, `RunOnce()` gọi exported
function qua `runFn()`:

```text
internal/js/runner.go:
  startTime := time.Now()
  fn(...) // Actually run the JS script
  endTime := time.Now()
  iteration_duration = endTime - startTime
```

Vì vậy mọi thứ nằm trong function iteration đều được tính vào `iteration_duration`:

```js
export default function () {
  const a = 1 + 2; // code JS thường

  const res = http.get("https://quickpizza.grafana.com/"); // HTTP call

  check(res, {
    "status is 200": (r) => r.status === 200,
  }); // check chạy trong iteration

  sleep(1); // sleep tự viết trong function
}
```

Gần đúng:

```text
js_iteration_time_i
  ≈ thời gian code JS thường
   + thời gian http.get()
   + thời gian evaluate check()
   + 1s sleep
```

Ghi chú: `check()` có metric riêng `checks`, nhưng metric đó là pass/fail rate. Nó không phải
duration riêng của check. Thời gian chạy check vẫn nằm trong `iteration_duration`.

## 5. `0.5s`, `0.515s`, `0.2s` lấy từ đâu?

Có 3 kiểu:

```text
1. Script tự set delay cố định.
2. Script có sleep cố định + HTTP work.
3. Script không cố định, phải chạy thử để ước lượng.
```

Ví dụ docs official thường có dạng:

```js
http.get(...);
sleep(0.5);
```

Khi đó:

```text
js_iteration_time_i ≈ http.get time + 0.5s
```

Nếu request mất khoảng `15ms`, thì:

```text
t_i ≈ 500ms + 15ms = 515ms = 0.515s
```

Vì vậy docs tính:

```text
per_vu_rate_i ≈ 1 / 0.515 ≈ 1.94 iters/s ≈ 2 iters/s
peak_iteration_rate_if_all_vus_active ≈ 10 VUs * 2 iters/s = 20 iters/s
```

Tức là câu docs:

```text
Maximum throughput (highest efficiency) is therefore expected to be ~20 iters/s
```

trong notation của file này map sang:

```text
peak_iteration_rate_if_all_vus_active ≈ 20 iters/s
```

Không phải:

```text
average_iteration_rate
```

### Vì sao docs nói "maximum throughput is reached, but not maintained"?

Vì `per-vu-iterations` chia việc theo kiểu:

- mỗi VU được giao sẵn đúng `iterations_per_vu`
- VU nhanh làm xong phần của nó thì dừng
- VU chậm vẫn phải tự làm nốt phần còn lại của chính nó
- VU nhanh không "steal work" từ VU chậm

Nên với test đang xét:

```text
10 VUs
20 iterations mỗi VU
```

lúc đầu, cả 10 VU đều còn active:

```text
instantaneous_iteration_rate gần peak_iteration_rate_if_all_vus_active
≈ 20 iters/s
```

`instantaneous_iteration_rate` ở đây chỉ là cách gọi mô tả tốc độ iteration tại một thời
điểm. k6 không in sẵn đại lượng này thành một metric summary riêng.

nhưng sau một thời gian:

- các VU nhanh hoàn thành 20 iteration trước
- số VU còn active giảm xuống
- iteration rate thực tế giảm theo

Ví dụ nếu chỉ còn 2 VU chậm đang chạy:

```text
instantaneous_iteration_rate ≈ 2 * (1 / t_slow)
```

nên thấp hơn nhiều so với peak ban đầu.

Vì vậy:

- **reached**: ở giai đoạn đầu có thể chạm gần mức `peak_iteration_rate_if_all_vus_active`
- **not maintained**: không giữ được mức đó suốt toàn bộ test vì số VU active giảm dần

Đó cũng là lý do `average_iteration_rate` của toàn test thường nhỏ hơn peak.

Đó là số ước lượng từ script và kết quả chạy, không phải hằng số core của k6.

## 6. Demo của ta

File demo:

```text
examples/per_vu_iterations_throughput_demo.js
```

Command:

```bash
k6 run examples/per_vu_iterations_throughput_demo.js
```

Các tham số trong file:

```js
const VUS = 10;
const ITERATIONS_PER_VU = 20;
const FAST_VUS = 8;
const FAST_ITERATION_SECONDS = 0.2;
const SLOW_ITERATION_SECONDS = 0.5;
```

Mapping sang tiếng Việt:

```text
VUS = 10
  tổng số VU của scenario

ITERATIONS_PER_VU = 20
  mỗi VU chạy 20 iterations

FAST_VUS = 8
  8 VU đầu chạy nhanh

FAST_ITERATION_SECONDS = 0.2
  t_fast = thời gian chiếm VU của mỗi iteration nhanh = 0.2 giây

SLOW_ITERATION_SECONDS = 0.5
  t_slow = thời gian chiếm VU của mỗi iteration chậm = 0.5 giây
```

Số VU chậm:

```text
slow_vus = VUS - FAST_VUS
         = 10 - 8
         = 2
```

Vì sao biết `8 nhanh` và `2 chậm`?

Vì demo **tự chia nhóm trong code**, không phải core k6 tự phát hiện:

```js
const FAST_VUS = 8;

function iterationSecondsForVU(vuID) {
  return vuID <= FAST_VUS ? FAST_ITERATION_SECONDS : SLOW_ITERATION_SECONDS;
}
```

Nghĩa là:

```text
VU id 1..8  -> nhóm nhanh
VU id 9..10 -> nhóm chậm
```

Nên trong demo này ta biết chắc:

```text
fast_vus = 8
slow_vus = 2
```

Ghi chú quan trọng:

```text
đây là điều ta biết từ code của demo
không phải điều core k6 tự suy ra từ summary
```

Trong bài test thực tế, nếu script không tự chia nhóm như vậy, thì chỉ nhìn summary
`iteration_duration` thường **không đủ** để kết luận chính xác:

```text
có đúng 8 VU nhanh và 2 VU chậm hay không
```

Muốn biết nhóm nào nhanh/chậm trong test thật, thường phải có thêm một trong các cách:

```text
- đọc code để biết workload từng nhánh
- log theo __VU / exec.vu.idInTest
- gắn tag riêng cho từng loại iteration
- tách scenario riêng
```

Trong demo này, ta log thêm duration đo thực tế của iteration đầu/cuối mỗi VU:

```js
const iterStartMs = Date.now();
sleep(delay);
const measuredMs = Date.now() - iterStartMs;

if (__ITER === 0 || __ITER === ITERATIONS_PER_VU - 1) {
  console.log(
    `[iter-measured] vu=${vuID} __ITER=${__ITER} measuredMs=${measuredMs} configuredDelay=${delay}s`,
  );
}
```

Output quan trọng:

```text
[iter-measured] vu=1  __ITER=0 measuredMs=202 configuredDelay=0.2s
[iter-measured] vu=2  __ITER=0 measuredMs=202 configuredDelay=0.2s
...
[iter-measured] vu=8  __ITER=0 measuredMs=203 configuredDelay=0.2s
[iter-measured] vu=9  __ITER=0 measuredMs=501 configuredDelay=0.5s
[iter-measured] vu=10 __ITER=0 measuredMs=501 configuredDelay=0.5s
```

Nếu bỏ qua `configuredDelay` và chỉ nhìn `measuredMs`, ta vẫn thấy:

```text
VU 1..8:
  measuredMs quanh 200ms
  nhóm nhanh

VU 9..10:
  measuredMs quanh 500ms
  nhóm chậm
```

Với test thật, không nên log quá nhiều iteration vì sẽ làm output nhiễu và có thể ảnh hưởng kết quả.
Thường chỉ log vài iteration đầu/cuối, hoặc dùng custom metric/tag nếu cần phân tích nghiêm túc.

Tổng iterations:

```text
total_iterations = vus * iterations_per_vu
                 = 10 * 20
                 = 200
```

Peak khi tất cả VU còn active:

```text
8 VU nhanh:
  1 VU nhanh = 1 / 0.2 = 5 iters/s
  8 VUs nhanh = 8 * 5 = 40 iters/s

2 VU chậm:
  1 VU chậm = 1 / 0.5 = 2 iters/s
  2 VUs chậm = 2 * 2 = 4 iters/s

peak_iteration_rate_if_all_vus_active = 40 + 4 = 44 iters/s
```

Runtime từng nhóm:

```text
vu_runtime_fast = iterations_per_vu * t_fast
                = 20 * 0.2s
                = 4s

vu_runtime_slow = iterations_per_vu * t_slow
                = 20 * 0.5s
                = 10s
```

Runtime của scenario:

```text
actual_scenario_runtime ≈ max(vu_runtime_fast, vu_runtime_slow)
                        ≈ max(4s, 10s)
                        = 10s
```

Average toàn test:

```text
average_iteration_rate = completed_iterations / summary_runtime_base
                       = 200 / 10s
                       = 20 iters/s
```

## 7. Chạy trực tiếp thì tìm tham số ở đâu?

### 7.1. Tìm trong code trước khi chạy

Command:

```bash
rg -n "const VUS|ITERATIONS_PER_VU|FAST_VUS|FAST_ITERATION|SLOW_ITERATION|executor|vus:|iterations:" examples/per_vu_iterations_throughput_demo.js
```

Kết quả cần đọc:

```text
const VUS = 10;
const ITERATIONS_PER_VU = 20;
const FAST_VUS = 8;
const FAST_ITERATION_SECONDS = 0.2;
const SLOW_ITERATION_SECONDS = 0.5;

executor: "per-vu-iterations"
vus: VUS
iterations: ITERATIONS_PER_VU
```

Từ đó tự dịch:

```text
vus = 10
iterations_per_vu = 20
fast_vus = 8
slow_vus = 10 - 8 = 2
t_fast = 0.2s
t_slow = 0.5s
```

### 7.2. Tìm trong header output của k6

Command:

```bash
k6 run examples/per_vu_iterations_throughput_demo.js
```

Header quan trọng:

```text
scenarios: (100.00%) 1 scenario, 10 max VUs, 32s max duration (incl. graceful stop):
  * per_vu_throughput: 20 iterations for each of 10 VUs (maxDuration: 30s, gracefulStop: 2s)
```

Đọc ra:

```text
10 max VUs
  k6 cần tối đa 10 VU cho scenario này

20 iterations for each of 10 VUs
  iterations_per_vu = 20
  vus = 10

maxDuration: 30s
  trần chạy bình thường là 30 giây

gracefulStop: 2s
  thời gian chờ dừng mềm là 2 giây

32s max duration incl. graceful stop
  maxDuration + gracefulStop = 30s + 2s = 32s
```

### 7.3. Tìm active VUs trong progress output

Progress:

```text
running (04.0s), 10/10 VUs, 166 complete and 0 interrupted iterations
running (05.0s), 02/10 VUs, 178 complete and 0 interrupted iterations
running (06.0s), 02/10 VUs, 182 complete and 0 interrupted iterations
```

Đọc ra:

```text
10/10 VUs
  10 VU active / 10 VU initialized

02/10 VUs
  2 VU active / 10 VU initialized
```

Khi từ `10/10` tụt xuống `02/10`, nghĩa là 8 VU nhanh đã chạy xong và idle.

### 7.4. Tính peak gần đúng từ progress output

Output:

```text
running (01.0s), 10/10 VUs, 34 complete
running (02.0s), 10/10 VUs, 78 complete
running (03.0s), 10/10 VUs, 122 complete
running (04.0s), 10/10 VUs, 166 complete
```

Lấy delta completed iterations mỗi giây:

```text
78 - 34 = 44 iterations/s
122 - 78 = 44 iterations/s
166 - 122 = 44 iterations/s
```

Đây là peak gần đúng từ output. k6 không có metric mặc định tên
`peak_iteration_rate_if_all_vus_active`.

Sau khi VU nhanh xong:

```text
running (05.0s), 02/10 VUs, 178 complete
running (06.0s), 02/10 VUs, 182 complete
running (07.0s), 02/10 VUs, 186 complete
```

Delta:

```text
182 - 178 = 4 iterations/s
186 - 182 = 4 iterations/s
```

Khớp công thức:

```text
2 VUs chậm * (1 / 0.5s) = 2 * 2 = 4 iters/s
```

### 7.5. Tìm average iteration rate trong summary

Summary:

```text
iterations...........: 200 19.980734/s
```

Đọc ra:

```text
completed_iterations = 200
average_iteration_rate ≈ 19.98 iters/s
```

Tự tính lại:

```text
average_iteration_rate = 200 / 10s = 20 iters/s
```

Số output là `19.98/s` thay vì đúng `20/s` vì runtime thực tế không đúng tuyệt đối `10.000000s`.

### 7.6. Tìm thời gian iteration từ `iteration_duration`

Summary demo:

```text
iteration_duration...: avg=260.45ms min=200.05ms med=200.45ms max=502.54ms p(90)=500.39ms
```

Đọc ra:

```text
min ≈ 200ms
  nhóm VU nhanh có iteration khoảng 0.2s

max/p90 ≈ 500ms
  nhóm VU chậm có iteration khoảng 0.5s

avg ≈ 260ms
  trung bình trộn giữa 160 iterations nhanh và 40 iterations chậm
```

Tự kiểm tra average:

```text
fast iterations = 8 VUs * 20 = 160
slow iterations = 2 VUs * 20 = 40

avg_iteration_duration
  ≈ (160 * 0.2s + 40 * 0.5s) / 200
  = (32s + 20s) / 200
  = 52s / 200
  = 0.26s
  = 260ms
```

Khớp summary `avg=260.45ms`.

### 7.7. Demo chạy thật với QuickPizza

File demo:

```text
examples/per_vu_iterations_quickpizza_demo.js
```

Command:

```bash
k6 run examples/per_vu_iterations_quickpizza_demo.js
```

Các tham số chính trong file:

```js
const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const ITERATIONS_PER_VU = 3;
```

Executor:

```js
executor: "per-vu-iterations",
vus: 4,
iterations: 3,
```

Công thức trước khi chạy:

```text
total_iterations = vus * iterations_per_vu
                 = 4 * 3
                 = 12
```

Mỗi iteration trong demo gồm:

```text
http.get("https://quickpizza.grafana.com/")
check(status is 200)
sleep(1)
```

Nên:

```text
iteration_duration
  = thời gian http.get()
  + thời gian check()
  + sleep(1)
  + overhead nhỏ của runtime
```

Output mẫu khi chạy:

```text
checks_total.......: 12      2.713682/s
http_reqs..........: 12      2.713682/s

iteration_duration.: avg=1.47s min=1.26s med=1.26s max=1.88s
iterations.........: 12      2.713682/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4
```

Đọc ra:

```text
checks_total = 12
  vì mỗi iteration có 1 check

http_reqs = 12
  vì mỗi iteration có 1 http.get()

iterations = 12
  vì 4 VUs * 3 iterations mỗi VU

iteration_duration avg ≈ 1.47s
  vì mỗi iteration có request thật + sleep(1)

vus = 4 min=4 max=4
  các sample trong lúc chạy đều thấy 4 VU active

vus_max = 4 min=4 max=4
  k6 initialize 4 VU, không tạo thêm VU
```

Tự kiểm tra average iteration rate:

```text
average_iteration_rate
  = completed_iterations / summary_runtime_base
  ≈ 12 / 4.4s
  ≈ 2.7 iters/s
```

Khớp với summary:

```text
iterations.........: 12      2.713682/s
```

Ghi chú:

- số `http_req_duration` thay đổi theo internet và server tại thời điểm chạy
- số `iteration_duration` lớn hơn `http_req_duration` vì có thêm `sleep(1)`
- đây là test nhỏ để học executor, không phải load test thật

### 7.7.1. Phân tích đúng output bạn vừa chạy

Output:

```text
checks_total.......: 12      2.780988/s
http_req_duration..: avg=255.96ms min=253.04ms med=255.09ms max=259.51ms
http_reqs..........: 12      2.780988/s

iteration_duration.: avg=1.43s min=1.25s med=1.25s max=1.79s p(90)=1.79s p(95)=1.79s
iterations.........: 12      2.780988/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4

running (04.3s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

#### 1. Từ config suy ra ngay được gì?

```text
vus = 4
iterations_per_vu = 3

total_iterations
  = vus * iterations_per_vu
  = 4 * 3
  = 12
```

Vì script có:

```text
1 http.get() / iteration
1 check() / iteration
1 sleep(1) / iteration
```

nên cũng suy ra:

```text
total_http_requests = 12
total_checks = 12
```

Khớp:

```text
http_reqs....: 12
checks_total.: 12
iterations...: 12
```

#### 2. `2.780988/s` có phải là `1 / 2.780988` không?

Không, không nên hiểu như vậy cho `iteration_duration`.

`2.780988/s` ở đây là:

```text
average_iteration_rate
  = completed_iterations / summary_runtime_base
```

Tự tính lại:

```text
actual_scenario_runtime
  = completed_iterations / average_iteration_rate
  = 12 / 2.780988
  ≈ 4.315s
```

Khớp với progress line bị làm tròn:

```text
running (04.3s)
```

Nếu lấy:

```text
1 / 2.780988 ≈ 0.3596s
```

thì số đó chỉ có thể hiểu là:

```text
trung bình toàn hệ thống hoàn thành 1 iteration mỗi khoảng 0.36 giây
```

chứ **không phải** thời gian một VU chạy xong một iteration.

Lý do:

- có 4 VU chạy song song
- nên toàn test có thể hoàn thành khoảng `2.78 iterations mỗi giây`
- trong khi mỗi iteration của từng VU vẫn mất khoảng `1.25s -> 1.79s`

#### 3. `http_req_duration` đọc như thế nào?

```text
http_req_duration avg=255.96ms
min=253.04ms
med=255.09ms
max=259.51ms
```

Đây là thời gian riêng của request HTTP, gần đúng:

```text
thời gian gửi request + chờ server + nhận response
```

Không tính:

- `sleep(1)`
- phần JS khác ngoài request

Nên có thể xem:

```text
http_time ≈ 0.256s
```

#### 4. `iteration_duration` đọc như thế nào?

```text
iteration_duration avg=1.43s
min=1.25s
med=1.25s
max=1.79s
```

Với script này:

```text
iteration_duration
  ≈ http_req_duration
  + check_time
  + sleep(1)
  + overhead
```

Lấy số min để kiểm tra nhanh:

```text
min iteration_duration ≈ 1.25s
min http_req_duration ≈ 0.253s

0.253s + 1s = 1.253s
```

Rất khớp với:

```text
iteration_duration min=1.25s
```

Nghĩa là các iteration nhanh nhất gần như đúng bằng:

```text
1s sleep + ~0.25s request
```

#### 5. Vì sao `avg=1.43s` nhưng `med=1.25s`?

Điều này cho thấy:

- phần lớn iterations nằm quanh `1.25s`
- nhưng có một nhóm chậm hơn kéo `avg` lên

Với test này có 12 iterations tổng cộng:

```text
4 VUs * 3 iterations = 12
```

Và rất có khả năng pattern là:

- nhiều iteration ở khoảng `1.25s`
- một ít iteration đầu chậm hơn, khoảng `1.79s`

Đó là lý do:

```text
med = 1.25s
avg = 1.43s
max = 1.79s
p(90) = 1.79s
p(95) = 1.79s
```

Ghi chú:

- đây là suy luận từ shape của output
- muốn biết iteration nào chậm thật thì xem log `[iter-start]` / `[iter-end]` trong demo

#### 6. `http_reqs`, `checks_total`, `iterations` vì sao cùng rate?

Vì trong script:

```text
1 iteration = 1 request + 1 check
```

nên:

```text
http_reqs rate
  = iterations rate
  = checks_total rate
  ≈ 2.780988/s
```

Nếu sau này một iteration có:

- 2 requests
- 3 checks

thì các rate này sẽ không còn bằng nhau nữa.

#### 7. `vus` và `vus_max`

```text
vus.....: 4 min=4 max=4
vus_max.: 4 min=4 max=4
```

Đọc là:

```text
vus
  mọi sample đều thấy 4 VU đang active

vus_max
  mọi sample đều thấy đã initialize 4 VU
```

Vì test ngắn và 4 VU chạy rất đều, các lần sample 1 giây một lần đều rơi vào lúc cả 4 VU còn đang bận.

#### 8. Gom lại thành bộ công thức của lần chạy này

```text
vus = 4
iterations_per_vu = 3

total_iterations = 4 * 3 = 12
total_http_requests = 12
total_checks = 12

actual_scenario_runtime
  ≈ 12 / 2.780988
  ≈ 4.315s

average_iteration_rate
  = 12 / 4.315
  ≈ 2.780988 iters/s

average_http_request_rate
  = 12 / 4.315
  ≈ 2.780988 req/s

iteration_duration_min
  ≈ http_req_duration_min + sleep(1)
  ≈ 0.253 + 1.0
  ≈ 1.253s

iteration_duration_avg
  ≈ trung bình của
    (request time + sleep + overhead)
  ≈ 1.43s
```

### 7.7.2. Map ngược từ output về các giá trị ở đầu file

Đầu file demo có các giá trị chính:

```js
const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const ITERATIONS_PER_VU = 3;

executor: "per-vu-iterations"
maxDuration: "30s"
gracefulStop: "5s"
sleep(1)
```

Từ output lần chạy của bạn, ta bóc ngược như sau.

#### Bảng tóm tắt nhanh

| Đại lượng | Giá trị ở run này | Lấy từ đâu | Cách tính / ghi chú |
| --- | --- | --- | --- |
| `TARGET_URL` | `https://quickpizza.grafana.com/` | code | Summary không tự cho biết URL. |
| `executor` | `per-vu-iterations` | header + code | Header ghi `3 iterations for each of 4 VUs`. |
| `scenario_name` | `quickpizza_per_vu` | progress / log | Tên scenario đang chạy. |
| `VUS` | `4` | progress / header / `vus_max` | Progress ghi `4 VUs`. |
| `ITERATIONS_PER_VU` | `3` | header hoặc tự tính | `12 / 4 = 3`. |
| `total_iterations` | `12` | summary | `iterations` count. |
| `maxDuration` | `30s` | header + code | Summary cuối không in lại. |
| `gracefulStop` | `5s` | header + code | Summary cuối không in lại. |
| `scenario_max_end` | `35s` | header | `30s + 5s`. |
| `http requests / iteration` | `1` | code, kiểm tra chéo bằng output | `http_reqs / iterations = 12 / 12 = 1`. |
| `checks / iteration` | `1` | code, kiểm tra chéo bằng output | `checks_total / iterations = 12 / 12 = 1`. |
| `sleep / iteration` | `1s` | code, kiểm tra chéo gần đúng bằng output | `1.25s - 0.253s ≈ 1.0s`. |
| `http_req_duration_avg` | `255.96ms` | summary | Thời gian request HTTP trung bình. |
| `http_req_duration_min` | `253.04ms` | summary | Request nhanh nhất. |
| `iteration_duration_avg` | `1.43s` | summary | Request + check + sleep + overhead. |
| `iteration_duration_min` | `1.25s` | summary | Gần `0.253s + 1s = 1.253s`. |
| `per_vu_rate_avg` | `≈ 0.70 iter/s` | tự tính từ summary | `1 / 1.43 ≈ 0.70`. |
| `per_vu_rate_med` | `≈ 0.80 iter/s` | tự tính từ summary | `1 / 1.25 = 0.80`. |
| `estimated_total_rate_from_avg` | `≈ 2.8 iter/s` | tự tính từ summary | `4 * 0.70 ≈ 2.8`. |
| `summary_runtime_base` | `≈ 4.315s` | tự tính từ summary | `12 / 2.780988 ≈ 4.315s`. Đây là mẫu số mà Counter summary dùng cho cột `/s`. |
| `average_iteration_rate` | `2.780988 iters/s` | summary | `iterations / runtime`. |
| `average_http_request_rate` | `2.780988 req/s` | summary | Vì `1 iteration = 1 request`. |
| `total_http_requests` | `12` | summary | `http_reqs` count. |
| `total_checks` | `12` | summary | `checks_total` count. |
| `vus` sample cuối | `4` | summary | Gauge `value = 4`. |
| `vus min/max` | `4 / 4` | summary | Mọi sample đều thấy 4 VU active. |
| `vus_max` sample cuối | `4` | summary | Gauge `value = 4`. |
| `vus_max min/max` | `4 / 4` | summary | Mọi sample đều thấy đã initialize 4 VU. |

#### Cách đọc bảng

`summary` cho bạn biết:

- số lượng đã chạy xong
- các thời gian đo được
- rate trung bình
- các gauge như `vus`, `vus_max`

`header/progress` cho bạn biết:

- scenario đang chạy kiểu gì
- `maxDuration`
- `gracefulStop`
- tổng thời lượng tối đa theo config

`code` cho bạn biết:

- URL nào được gọi
- có `sleep(1)` hay không
- một iteration có bao nhiêu request/check

Chi tiết diễn giải từng nhóm nằm ngay bên dưới.

#### A. Giá trị lấy được trực tiếp hoặc gần trực tiếp từ output

```text
iterations.........: 12     2.780988/s
vus................: 4      min=4       max=4
vus_max............: 4      min=4       max=4
running (04.3s), 0/4 VUs, 12 complete and 0 interrupted iterations
quickpizza_per_vu  [======================================] 4 VUs  04.3s
```

Suy ra:

```text
VUS = 4
  đọc từ progress line: 4 VUs
  hoặc từ vus_max = 4 trong test này

total_iterations = 12
  đọc từ iterations count = 12

iterations_per_vu = 3
  = total_iterations / vus
  = 12 / 4
  = 3

summary_runtime_base ≈ 4.315s
  = 12 / 2.780988
  ≈ 4.315s
  progress line làm tròn thành 04.3s

scenario_name = quickpizza_per_vu
  đọc từ progress line / log line
```

#### B. Giá trị đọc được từ header output hoặc progress, không phải từ summary cuối

Nếu nhìn phần đầu output của k6:

```text
scenarios: (100.00%) 1 scenario, 4 max VUs, 35s max duration (incl. graceful stop):
         * quickpizza_per_vu: 3 iterations for each of 4 VUs (maxDuration: 30s, gracefulStop: 5s)
```

Suy ra:

```text
executor = per-vu-iterations
  vì scenario được mô tả là "3 iterations for each of 4 VUs"
  và trong code nó là executor per-vu-iterations

maxDuration = 30s
  đọc ở header

gracefulStop = 5s
  đọc ở header

scenario_max_end = 35s
  = maxDuration + gracefulStop
  = 30s + 5s
```

Ghi chú:

- `summary` cuối không in lại `maxDuration` và `gracefulStop`
- muốn có 2 giá trị này phải nhìn header hoặc đọc code

#### C. Giá trị không thể biết chính xác chỉ từ summary, phải đọc code

```text
TARGET_URL = "https://quickpizza.grafana.com/"
sleep(1)
1 http.get() mỗi iteration
1 check() mỗi iteration
```

Lý do:

- summary cho bạn biết đã có `http_reqs = 12`
- summary cho bạn biết đã có `checks_total = 12`
- nhưng summary **không nói URL nào**
- summary **không ghi rõ sleep(1)**
- summary **không nói mỗi iteration có đúng 1 request hay 2 request**

Những cái này phải đọc code:

```js
const res = http.get(TARGET_URL);

check(res, {
  "status is 200": (r) => r.status === 200,
});

sleep(1);
```

#### D. Từ code + output suy ra các công thức gì?

Từ code:

```text
1 iteration = 1 request + 1 check + sleep(1)
```

Từ output:

```text
iterations = 12
http_reqs = 12
checks_total = 12
http_req_duration avg = 255.96ms
iteration_duration avg = 1.43s
```

Suy ra:

```text
total_http_requests = total_iterations * 1
                    = 12 * 1
                    = 12

total_checks = total_iterations * 1
             = 12 * 1
             = 12

average_iteration_rate
  = total_iterations / summary_runtime_base
  = 12 / 4.315
  ≈ 2.780988 iters/s

average_http_request_rate
  = total_http_requests / summary_runtime_base
  = 12 / 4.315
  ≈ 2.780988 req/s
```

#### D.1. Công thức riêng cho `http_reqs......................: 12  2.780988/s`

Dòng này có 2 phần:

```text
http_reqs......................: 12     2.780988/s
                                 |      |
                                 |      +-- rate
                                 +--------- count
```

##### Phần `12` được tính như thế nào?

```text
total_http_requests
  = total_iterations * http_requests_per_iteration
```

Với demo này:

```text
total_iterations = 12
http_requests_per_iteration = 1
```

nên:

```text
total_http_requests
  = 12 * 1
  = 12
```

##### Phần `2.780988/s` được tính như thế nào?

```text
http_request_rate
  = total_http_requests / summary_runtime_base
```

Với run này:

```text
total_http_requests = 12
summary_runtime_base ≈ 4.315s
```

nên:

```text
http_request_rate
  = 12 / 4.315
  ≈ 2.780988 req/s
```

##### Vì sao nó bằng `iterations/s` trong demo này?

Vì code đang có:

```text
1 iteration = 1 HTTP request
```

nên:

```text
estimated_http_reqs_rate = iterations/s
```

Trong demo này cách ước lượng trên khớp vì mỗi completed iteration đều chạy đúng 1 HTTP request.
Nếu code có branch/error/interrupt làm số request không cố định, đọc `http_reqs` thực tế.

Nếu sau này script đổi thành:

```text
1 iteration = 2 HTTP requests
```

thì:

```text
http_reqs count = total_iterations * 2
estimated_http_reqs_rate = 2 * iterations/s
```

#### D.2. Nếu lấy `summary_runtime_base` làm gốc thì suy ra gì?

Đoạn này cần nói rất chặt:

```text
core summary của Counter dùng test run duration của cả test làm mẫu số cho cột /s
```

Trong các ví dụ của bài này, vì test thường là:

```text
1 scenario
startTime = 0
không setup/teardown
```

nên mẫu số của summary thường gần với runtime thật của scenario.
Vì vậy để giải thích đời thường, ta hay nhìn:

```text
actual_scenario_runtime ≈ summary_runtime_base
```

Nhưng nếu có nhiều scenario, có `startTime`, có `setup()`, hoặc có phần đuôi khác, đừng đồng nhất
hai đại lượng đó.

Với các metric kiểu `Counter`, summary dùng:

```text
rate = count / summary_runtime_base
```

Nên nếu đã biết mẫu số summary, ta suy ra được:

```text
iterations_rate
  = completed_iterations / summary_runtime_base

http_reqs_rate
  = total_http_requests / summary_runtime_base

checks_total_rate
  = total_checks / summary_runtime_base
```

Chiều ngược lại, nếu biết `count` và `rate` của cùng một Counter:

```text
summary_runtime_base
  = count / rate
```

Ví dụ với run `1 iteration = 2 HTTP requests`:

```text
iterations.........: 12    2.3615/s
http_reqs..........: 24    4.723/s
checks_total.......: 24    4.723/s
```

Ta suy ra cùng một mẫu số summary:

```text
summary_runtime_base
  = 12 / 2.3615
  ≈ 5.0815s

summary_runtime_base
  = 24 / 4.723
  ≈ 5.0815s

summary_runtime_base
  = 24 / 4.723
  ≈ 5.0815s
```

Trong demo sạch này, số đó thường cũng gần `actual_scenario_runtime`.

Nhìn theo kiểu "lấy `summary_runtime_base` làm mẫu số":

```text
completed_iterations ---chia cho summary_runtime_base---> iterations/s
total_http_requests  ---chia cho summary_runtime_base---> http_reqs/s
total_checks         ---chia cho summary_runtime_base---> checks_total/s
```

Hoặc chiều ngược:

```text
iterations/s   * summary_runtime_base = completed_iterations
http_reqs/s    * summary_runtime_base = total_http_requests
checks_total/s * summary_runtime_base = total_checks
```

Ghi chú quan trọng:

- cách này áp dụng rất gọn cho các metric `Counter`
- `iterations`, `http_reqs`, `checks_total` đều thuộc nhóm này
- không áp dụng kiểu `count / runtime` cho:
  - `http_req_duration` vì đó là `Trend`
  - `iteration_duration` vì đó là `Trend`
  - `vus`, `vus_max` vì đó là `Gauge`

#### E. Từ `http_req_duration` và `iteration_duration` suy ra gì?

Output:

```text
http_req_duration avg = 255.96ms
iteration_duration avg = 1.43s
iteration_duration min = 1.25s
```

Suy ra gần đúng:

```text
iteration_duration
  ≈ request_time + sleep(1) + check_time + overhead
```

Kiểm tra với số nhỏ nhất:

```text
http_req_duration min ≈ 0.253s
sleep = 1.000s

0.253 + 1.000 = 1.253s
```

khớp với:

```text
iteration_duration min ≈ 1.25s
```

Tức là:

```text
min iteration gần như = request nhanh nhất + sleep(1)
```

Còn với average:

```text
iteration_duration avg = 1.43s
http_req_duration avg = 0.256s

phan_con_lai
  ≈ 1.43 - 0.256
  ≈ 1.174s
```

Phần còn lại này gồm:

- `sleep(1)`
- `check()`
- JS overhead
- độ chênh do request đầu có thể chậm hơn

#### E.1. Vì sao `1 / http_req_duration` không ra `http_reqs/s`?

Output:

```text
http_req_duration avg = 255.96ms = 0.25596s
http_reqs = 12  2.780988/s
```

Nếu lấy:

```text
1 / 0.25596 ≈ 3.91 req/s
```

thì đây chỉ là:

```text
tốc độ lý thuyết của 1 VU nếu nó chỉ bắn request liên tục,
không sleep, không có code khác, không bị chờ iteration tiếp theo
```

Nhưng script của ta không phải như vậy. Mỗi iteration là:

```text
http.get()
check()
sleep(1)
```

Nên thời gian giữ VU không phải `http_req_duration`, mà gần hơn với:

```text
iteration_duration
```

Trong output:

```text
iteration_duration avg = 1.43s
```

Nếu lấy trung bình đơn giản:

```text
1 VU trung bình ≈ 1 / 1.43 ≈ 0.70 iterations/s
4 VUs trung bình ≈ 4 * 0.70 ≈ 2.8 iterations/s
```

Con số này mới gần với:

```text
iterations/s = 2.780988/s
http_reqs/s = 2.780988/s
```

Vì demo này có:

```text
1 iteration = 1 HTTP request
```

nên:

```text
estimated_http_reqs_rate = iterations/s
```

Đây chỉ là cách nối hai Counter trong clean run 1 request/iteration. Metric `http_reqs/s` thật
vẫn được summary tính bằng `total_http_requests / summary_runtime_base`.

Kết luận:

```text
1 / http_req_duration
  chỉ nói tốc độ request nếu chỉ xét riêng thời gian HTTP

1 / effective_iteration_time
  gần hơn với capacity 1 VU hoàn thành iteration thật
  trong demo không có minIterationDuration nên effective_iteration_time gần bằng iteration_duration

http_reqs/s trong summary
  = total_http_requests / summary_runtime_base
```

#### E.2. Nếu đã biết `iteration_duration`, thì 1 VU 1 giây chạy được bao nhiêu iteration?

Đây chính là đại lượng bạn hay cần nhất khi đọc output.

Nếu một iteration mất `t` giây, thì:

```text
per_vu_rate ≈ 1 / t   iterations/s
```

Nghĩa là:

```text
1 VU trong 1 giây chạy được khoảng bao nhiêu iteration
```

Với output của bạn:

```text
iteration_duration avg = 1.43s
iteration_duration med = 1.25s
iteration_duration min = 1.25s
```

Ta tính được:

```text
per_vu_rate_avg
  ≈ 1 / 1.43
  ≈ 0.70 iter/s

per_vu_rate_med
  ≈ 1 / 1.25
  = 0.80 iter/s
```

Đọc nghĩa:

```text
theo avg:
  1 VU trung bình 1 giây chạy được khoảng 0.70 iteration

theo med:
  1 VU điển hình 1 giây chạy được khoảng 0.80 iteration
```

Vì test có `4 VU`, nên nếu 4 VU đều đang active và nhịp khá giống nhau:

```text
estimated_total_rate_from_avg
  ≈ 4 * 0.70
  ≈ 2.8 iter/s

estimated_total_rate_from_med
  ≈ 4 * 0.80
  ≈ 3.2 iter/s
```

So với summary:

```text
iterations/s = 2.780988/s
```

thì thấy:

- `2.8/s` theo `avg` khớp khá sát
- `3.2/s` theo `med` cao hơn vì run này có vài iteration chậm kéo tổng runtime lên

Nên khi cần nói:

```text
1 VU thực tế chạy được bao nhiêu iteration mỗi giây?
```

thì dùng thời gian VU bị chiếm cho một iteration:

```text
effective_iteration_time_avg
  ~= iteration_duration_avg nếu không có minIterationDuration
  ~= max(iteration_duration_avg, minIterationDuration) nếu có minIterationDuration

per_vu_rate_avg ≈ 1 / effective_iteration_time_avg
```

Còn khi muốn nhìn nhịp "điển hình" hơn:

```text
effective_iteration_time_med
  ~= iteration_duration_med nếu không có minIterationDuration
  ~= max(iteration_duration_med, minIterationDuration) nếu có minIterationDuration

per_vu_rate_med ≈ 1 / effective_iteration_time_med
```

Kết nối 2 mức:

```text
per_vu_rate
  = tốc độ của 1 VU

total_rate
  ≈ active_vus * per_vu_rate

summary iterations/s
  = tốc độ trung bình thật của toàn test
```

#### F. Công thức đầy đủ của lần chạy này

```text
TARGET_URL = https://quickpizza.grafana.com/      (đọc từ code)
executor = per-vu-iterations                      (đọc từ code/header)
scenario_name = quickpizza_per_vu                (đọc từ progress/log)

VUS = 4                                           (đọc từ progress/summary)
ITERATIONS_PER_VU = 3                             (12 / 4)
total_iterations = 12                             (đọc từ summary)

maxDuration = 30s                                 (đọc từ header)
gracefulStop = 5s                                 (đọc từ header)
scenario_max_end = 35s                            (30 + 5)

http requests per iteration = 1                   (đọc từ code)
checks per iteration = 1                          (đọc từ code)
sleep per iteration = 1s                          (đọc từ code)

total_http_requests = 12                          (1 * 12)
total_checks = 12                                 (1 * 12)

http_req_duration_avg = 255.96ms                  (đọc từ summary)
iteration_duration_avg = 1.43s                    (đọc từ summary)

summary_runtime_base ≈ 4.315s                     (12 / 2.780988)
average_iteration_rate ≈ 2.780988 iters/s         (12 / 4.315)
average_http_request_rate ≈ 2.780988 req/s        (12 / 4.315)
```

Kết luận ngắn:

```text
summary cho bạn biết:
  test chạy nhanh hay chậm bao nhiêu
  có bao nhiêu iteration/request/check đã hoàn thành
  iteration trung bình mất bao lâu
  VU active nhìn theo sample là bao nhiêu

code cho bạn biết:
  test gọi URL nào
  mỗi iteration làm những bước gì
  có sleep bao nhiêu giây
  mỗi iteration có bao nhiêu request/check
```

### 7.7.3. Demo QuickPizza với `1 iteration = 2 HTTP requests`

File demo:

```text
examples/per_vu_iterations_quickpizza_two_requests_demo.js
```

Command:

```bash
k6 run examples/per_vu_iterations_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
const res1 = http.get(TARGET_URL);
const res2 = http.get(TARGET_URL);

check(res1, {
  "request 1 status is 200": (r) => r.status === 200,
});

check(res2, {
  "request 2 status is 200": (r) => r.status === 200,
});

sleep(1);
```

Output thực tế:

```text
checks_total.......: 24      4.723/s
http_req_duration..: avg=256.06ms min=254.12ms med=255.83ms max=259ms
http_reqs..........: 24      4.723/s

iteration_duration.: avg=1.68s min=1.5s med=1.51s max=2.04s
iterations.........: 12      2.3615/s
vus................: 4       min=4       max=4
vus_max............: 4       min=4       max=4

running (05.1s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

Từ đây suy ra:

```text
VUS = 4
ITERATIONS_PER_VU = 3
total_iterations = 4 * 3 = 12

http_requests_per_iteration = 2
checks_per_iteration = 2

total_http_requests = 12 * 2 = 24
total_checks = 12 * 2 = 24

summary_runtime_base
  ≈ 12 / 2.3615
  ≈ 5.0815s

average_iteration_rate
  = 12 / 5.0815
  ≈ 2.3615 iter/s

average_http_request_rate
  = 24 / 5.0815
  ≈ 4.723 req/s
```

#### Vì sao có số `5.0815s`?

`5.0815s` không phải số mới từ config. Nó là `summary_runtime_base` được suy ngược từ summary:

```text
iterations.........: 12      2.3615/s
```

Công thức:

```text
summary_runtime_base
  = completed_iterations / average_iteration_rate
  = 12 / 2.3615
  ≈ 5.0815s
```

Trong demo sạch này, `summary_runtime_base` gần với thời gian run bạn nhìn thấy, nên người học dễ có
cảm giác đây là "runtime thật". Nhưng khi cắt nghĩa công thức thì nên giữ tên đúng là
`summary_runtime_base`.

Nó khớp với progress line bị làm tròn:

```text
running (05.1s)
```

#### Vì sao `checks_total = 24` và `http_reqs = 24` không cộng thành `48 iterations`?

Vì đây là **hai metric khác nhau**:

```text
iterations = số vòng default function hoàn thành
http_reqs = số HTTP request đã gửi
checks_total = số lần check/assertion đã chạy
```

Trong demo này:

```text
1 iteration
  = 2 HTTP requests
  + 2 checks
  + sleep(1)
```

Nên:

```text
iterations = 12
http_reqs = 12 * 2 = 24
checks_total = 12 * 2 = 24
```

Không đọc là:

```text
24 checks + 24 requests = 48 iterations
```

Nếu muốn nói tổng số "event được ghi nhận" theo kiểu tự đặt, có thể nói có 24 request events và
24 check events. Nhưng k6 không cộng chúng thành một metric `48` trong summary, vì request và
check là hai loại metric khác nhau.

#### Vì sao `checks_total/s` và `http_reqs/s` đều là `4.723/s`?

Vì cả hai cùng có count `24` và cùng chia cho runtime thật `5.0815s`:

```text
checks_total_rate
  = 24 / 5.0815
  ≈ 4.723/s

http_reqs_rate
  = 24 / 5.0815
  ≈ 4.723/s
```

Còn `iterations/s` thấp hơn vì count của iterations chỉ là `12`:

```text
iterations_rate
  = 12 / 5.0815
  ≈ 2.3615/s
```

Điểm quan trọng nhất:

```text
estimated_http_reqs_rate = 2 * iterations/s
```

vì trong demo này:

```text
1 iteration = 2 HTTP requests
mọi completed iteration đều chạy đủ 2 request
```

Kiểm tra:

```text
2 * 2.3615
= 4.723
```

khớp với summary.

Tốc độ 1 VU:

```text
effective_iteration_time_avg
  ~= iteration_duration_avg vì run này không có minIterationDuration
  ~= 1.68s

per_vu_rate_avg
  ≈ 1 / effective_iteration_time_avg
  ≈ 1 / 1.68
  ≈ 0.595 iter/s

estimated_total_rate_from_avg
  ≈ 4 * 0.595
  ≈ 2.38 iter/s
```

khá sát với:

```text
iterations/s = 2.3615/s
```

### 7.7.4. Khác gì so với case `1 iteration = 1 HTTP request`?

So sánh 2 run QuickPizza:

| Đại lượng | 1 request / iteration | 2 requests / iteration | Ý nghĩa |
| --- | --- | --- | --- |
| `VUS` | `4` | `4` | Giữ nguyên. |
| `ITERATIONS_PER_VU` | `3` | `3` | Giữ nguyên. |
| `total_iterations` | `12` | `12` | Giữ nguyên. |
| `http_requests_per_iteration` | `1` | `2` | Mỗi vòng gọi thêm 1 request. |
| `total_http_requests` | `12` | `24` | Tăng gấp đôi. |
| `total_checks` | `12` | `24` | Tăng gấp đôi vì code có 2 `check()`. |
| `http_req_duration avg` | `255.96ms` | `256.06ms` | Gần như không đổi, vì latency của từng request gần như cũ. |
| `iteration_duration avg` | `1.43s` | `1.68s` | Tăng lên vì mỗi iteration có thêm 1 request. |
| `actual_scenario_runtime` | `≈ 4.315s` | `≈ 5.082s` | Test kéo dài hơn vì mỗi iteration nặng hơn. |
| `iterations/s` | `2.780988/s` | `2.3615/s` | Giảm vì mỗi iteration mất lâu hơn. |
| `http_reqs/s` | `2.780988/s` | `4.723/s` | Tăng vì mỗi iteration tạo 2 request. |

Nhìn theo công thức:

```text
case 1 request:
  estimated_http_reqs_rate = 1 * iterations/s

case 2 requests:
  estimated_http_reqs_rate = 2 * iterations/s
```

Nhưng cần chú ý:

```text
http_reqs/s mới không nhất thiết = 2 * http_reqs/s cũ
```

Vì sao?

Vì khi thêm 1 request vào mỗi iteration:

- `total_http_requests` tăng
- nhưng `iteration_duration` cũng tăng
- nên `actual_scenario_runtime` dài hơn
- do đó `iterations/s` giảm xuống

Trong run thực tế này:

```text
run cũ:
  http_reqs/s ≈ 2.780988

run mới:
  http_reqs/s ≈ 4.723
```

Tăng nhiều, nhưng không gấp đúng 2 lần so với run cũ.

Điểm quan trọng để nhớ:

```text
so sánh trong cùng một run:
  estimated_http_reqs_rate = requests_per_iteration * iterations/s
  chỉ đúng nếu mọi completed iteration chạy đủ số request đó

so sánh giữa hai run khác nhau:
  còn phụ thuộc effective_iteration_time và actual_scenario_runtime
```

Một quan sát hay:

```text
iteration_duration_avg mới
  ≈ iteration_duration_avg cũ + 1 request time
  ≈ 1.43s + 0.256s
  ≈ 1.686s
```

Khớp khá sát với:

```text
iteration_duration avg mới = 1.68s
```

### 7.8. `sample`, `Gauge`, `vus`, `vus_max` là gì?

Summary:

```text
vus..................: 2   min=2       max=10
vus_max..............: 10  min=10      max=10
```

Để đọc 2 dòng này, trước hết cần hiểu 2 từ:

#### `sample` là gì?

`sample` có thể hiểu rất đơn giản là:

```text
một lần k6 ghi nhận giá trị metric tại một thời điểm
```

Ví dụ:

```text
12:00:01 -> vus = 10
12:00:02 -> vus = 10
12:00:03 -> vus = 10
12:00:04 -> vus = 2
```

Mỗi dòng trên là một `sample`.

Với `vus` và `vus_max`, k6 không ghi liên tục từng mili giây. Scheduler phát các metric này theo
chu kỳ 1 giây một lần, nên summary cuối chỉ được dựng từ các sample đã thu được ở những lần đó.

#### `Gauge` là gì?

`Gauge` là loại metric mà giá trị của nó:

- có thể tăng
- có thể giảm
- và thứ thường cần nhìn là giá trị hiện tại / nhỏ nhất / lớn nhất

Ví dụ đời thường:

```text
nhiệt độ phòng
số người đang online
số VU đang active
```

Nó khác với `Counter`:

- `Counter`: chủ yếu chỉ tăng dần, ví dụ `iterations`
- `Gauge`: có thể lên xuống, ví dụ `vus`

#### `vus` là gì?

`vus` là:

```text
số VU đang active tại thời điểm sample
```

Hiểu gần đúng là:

```text
bao nhiêu VU đang thực sự bận chạy test ở thời điểm đó
```

#### `vus_max` là gì?

`vus_max` là:

```text
số VU đã được initialize / hiện đang có sẵn trong execution state
```

Với demo `per-vu-iterations` của ta:

- planned VUs = 10
- k6 tạo sẵn 10 VU
- không có unplanned VU nào được thêm

nên `vus_max` thường sẽ giữ ở 10 suốt test.

#### Với `per-vu-iterations`, sample được collect như nào?

Điểm dễ nhầm: `vus` và `vus_max` không được ghi sau mỗi iteration.

Với 2 metric này, scheduler cứ khoảng 1 giây chụp lại trạng thái hiện tại:

- `vus`: hiện có bao nhiêu VU đang active
- `vus_max`: hiện đã initialize bao nhiêu VU

Core path:

- `Scheduler.emitVUsAndVUsMax()` chạy ticker 1 giây
- `vus = GetCurrentlyActiveVUsCount()`
- `vus_max = GetInitializedVUsCount()`

Còn riêng executor `per-vu-iterations` làm active VU thay đổi như sau:

- lúc `Run()` bắt đầu, executor gọi `GetPlannedVU(..., true)` đúng `numVUs` lần
- mỗi lần lấy VU với `true`, core tăng active VU count lên 1
- mỗi VU chạy quota riêng: `iterations` vòng
- VU nào chạy xong quota thì gọi `ReturnVU(..., true)`
- `ReturnVU(..., true)` trả VU về pool và giảm active VU count xuống 1

Vì vậy trong demo `10 VUs`, nếu 8 VU nhanh xong trước còn 2 VU chậm đang chạy, sample sau đó có thể là:

```text
vus = 2
vus_max = 10
```

Dịch nghĩa:

- `vus = 2`: tại thời điểm sample, còn 2 VU đang bận chạy script
- `vus_max = 10`: tổng số VU đã init vẫn là 10

Các metric khác lại được collect theo kiểu khác:

| Metric | Với `per-vu-iterations`, sample sinh khi nào? |
| --- | --- |
| `vus` | scheduler chụp active VU count mỗi 1 giây |
| `vus_max` | scheduler chụp initialized VU count mỗi 1 giây |
| `iterations` | mỗi completed iteration tạo 1 sample Counter |
| `iteration_duration` | mỗi completed iteration tạo 1 sample Trend thời gian chạy iteration |
| `dropped_iterations` | khi hết `maxDuration` trước lúc VU start đủ quota còn lại |

#### Executor khác nhau thì `vus` sample có khác không?

Cách collect `vus`/`vus_max` giống nhau: scheduler vẫn chụp counter mỗi 1 giây.

Nhưng mỗi executor mượn/trả VU khác nhau, nên giá trị được chụp có thể rất khác.

| Executor | `vus` thường phản ánh gì? | `vus_max` thường phản ánh gì? |
| --- | --- | --- |
| `per-vu-iterations` | số VU còn đang chạy quota riêng; VU nhanh xong thì giảm | planned VUs đã init; thường bằng `vus` config đã scale |
| `shared-iterations` | số VU còn đang bốc work từ tổng iterations chung | planned VUs đã init |
| `constant-vus` | số VU đang loop trong `duration`; thường giữ gần config `vus` tới cuối duration | planned VUs đã init |
| `ramping-vus` | số VU active đi lên/xuống theo ramp target | số VU đã init theo plan ramp |
| `constant-arrival-rate` | số VU đang được dùng để kịp lịch start iteration | planned VUs, và có thể tăng nếu tạo unplanned VUs |
| `ramping-arrival-rate` | số VU đang được dùng để kịp lịch start iteration thay đổi theo stage | planned VUs, và có thể tăng nếu tạo unplanned VUs |

Tóm lại:

- cơ chế ghi sample `vus`/`vus_max` là chung ở scheduler
- hành vi active/initialized VUs là do executor quyết định
- vì vậy đọc `vus` phải đặt trong executor đang chạy
- riêng `per-vu-iterations`: `vus` giảm khi VU nhanh chạy xong quota và trả về pool

### 7.9. Đọc summary này như thế nào?

Từ 2 dòng:

```text
vus..................: 2   min=2       max=10
vus_max..............: 10  min=10      max=10
```

ta đọc ra như sau:

```text
vus
  value = 2
    giá trị sample cuối cùng mà k6 còn giữ được

  min = 2
    trong tất cả sample của metric vus, nhỏ nhất là 2

  max = 10
    trong tất cả sample của metric vus, lớn nhất là 10

vus_max
  value = 10
    sample cuối cùng là 10

  min = 10
  max = 10
    mọi sample đều là 10
```

Ví dụ timeline đơn giản:

```text
t=1s  vus=10  vus_max=10
t=2s  vus=10  vus_max=10
t=3s  vus=10  vus_max=10
t=4s  vus=2   vus_max=10
```

thì summary cuối sẽ rất giống:

```text
vus..................: 2   min=2   max=10
vus_max..............: 10  min=10  max=10
```

Nghĩa là:

- đầu test có lúc cả 10 VU còn active
- cuối test chỉ còn 2 VU chậm đang chạy
- tổng số VU đã initialize vẫn là 10

#### Vì sao `vus` không ra `min=0`?

Vì test kết thúc khá nhanh, và k6 dừng phát metric khi test dừng. Thường nó không kịp ghi thêm
một sample cuối cùng với `vus=0`.

Cho nên:

- thực tế sau khi test xong thì active VUs về 0
- nhưng sample cuối cùng k6 thu được có thể vẫn là 2

#### Nếu nhìn xuống core thì chuyện gì xảy ra?

Scheduler mỗi 1 giây phát ra 2 sample:

- `vus = GetCurrentlyActiveVUsCount()`
- `vus_max = GetInitializedVUsCount()`

Nên về mặt code, nó đúng là:

```text
mỗi giây đo lại một lần rồi đẩy vào hệ metric
```

Sau đó `Gauge` sẽ giữ:

- `Value`: sample cuối cùng
- `Min`: sample nhỏ nhất
- `Max`: sample lớn nhất

Ghi chú quan trọng:

- summary `vus` không phải danh sách đầy đủ mọi khoảnh khắc
- nó chỉ phản ánh các sample đã được ghi nhận
- muốn nhìn timeline trực quan hơn thì xem progress lines hoặc tự `console.log()`

## 8. Cheat sheet — Công thức cần nhớ nhất

> Phần này dành cho người mới. Mỗi công thức có **tên tiếng Việt**, ví dụ
> đời thường, và "khi nào dùng". Đọc xong section này là dùng được ngay
> mà không cần đọc 3-7 chi tiết.

### 8.0. Config chung của `per-vu-iterations`

Đây là **bộ config đầy đủ** cho executor `per-vu-iterations`. Đọc bảng
này trước khi viết test, biết tham số nào BẮT BUỘC, tham số nào có default.

#### Template config đầy đủ

```js
export const options = {
  scenarios: {
    my_scenario: {
      // === BẮT BUỘC ===
      executor: "per-vu-iterations",   // tên executor
      vus: 5,                          // số VU
      iterations: 10,                  // số iter MỖI VU phải chạy

      // === TUỲ CHỌN (có default) ===
      maxDuration: "10m",              // default = "10m"
      gracefulStop: "30s",             // default = "30s" (BaseConfig)
      startTime: "0s",                 // default = "0s"
      exec: "default",                 // default = "default" function
      tags: { test: "demo" },          // default = {}
      env: { DEBUG: "1" },             // default = {}
    },
  },
};

export default function () {
  // code chạy mỗi iter
}
```

#### Bảng tham số chi tiết

| Tham số | Required? | Default | Đơn vị | Ý nghĩa |
| --- | --- | --- | --- | --- |
| `executor` | **BẮT BUỘC** | — | string | Phải đặt là `"per-vu-iterations"` |
| `vus` | **BẮT BUỘC** | — | int | Số Virtual Users |
| `iterations` | **BẮT BUỘC** | — | int | Số iter MỖI VU phải chạy (KHÔNG phải tổng) |
| `maxDuration` | tuỳ chọn | `"10m"` | duration | Trần thời gian, hết thì không start iter mới |
| `gracefulStop` | tuỳ chọn | `"30s"` | duration | Grace cuối scenario cho iter đang chạy |
| `startTime` | tuỳ chọn | `"0s"` | duration | Trễ trước khi scenario bắt đầu |
| `exec` | tuỳ chọn | `"default"` | string | Tên function JS chạy mỗi iter |
| `tags` | tuỳ chọn | `{}` | object | Tag attach vào metric của scenario |
| `env` | tuỳ chọn | `{}` | object | Biến môi trường riêng cho scenario |

#### 3 quy tắc validate (đọc từ core)

```text
1. vus > 0
   (nếu <= 0: lỗi "the number of VUs must be more than 0")

2. iterations > 0
   (nếu <= 0: lỗi "the number of iterations must be more than 0")

3. maxDuration >= minDuration (1s)
   (nếu nhỏ hơn: lỗi "the maxDuration must be at least 1s")
```

Code ref: `lib/executor/per_vu_iterations.go:71-88` (function `Validate()`).

#### Khác `shared-iterations` ở đâu?

Đây là điểm dễ nhầm nhất. Cùng `vus=5, iterations=10`:

```text
per-vu-iterations:
  MỖI VU chạy ĐÚNG 10 iter
  -> tổng = 5 × 10 = 50 iter
  -> VU nhanh xong sớm thì IDLE, KHÔNG lấy việc của VU chậm

shared-iterations:
  TỔNG TOÀN SCENARIO = 10 iter
  -> 5 VU CHIA NHAU 10 iter
  -> VU nào rảnh thì lấy iter tiếp theo
```

Code ref: `lib/executor/per_vu_iterations.go:55-61` (comment trong `GetIterations()`):
"per-VU iteration executor affects only the number of VUs. If we also
scaled the iterations, scaling would have quadratic effects".

#### Config tối thiểu (chạy được)

Nếu chỉ muốn config gọn nhất:

```js
export const options = {
  scenarios: {
    minimal: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 5,
    },
  },
};
```

5 dòng đủ chạy. Các field khác lấy default. Tổng iter = 3 × 5 = 15.

### 8.1. 7 công thức TOP cần thuộc lòng

#### Bản đồ 7 công thức nối với nhau như nào (đọc cái này trước)

Thay vì phải nhảy xuống cuối từng CT để đọc "Liên hệ với CT khác", nhìn
1 sơ đồ này là thấy hết luồng phụ thuộc:

```text
            ┌── CT 1: total_iter = vus × iterations
            │        (số iter THEO KẾ HOẠCH, không cần đo gì)
 INPUT      │
 (config) ──┤── CT 2: T_vu_i = iterations × iter_time_i
            │        (cần iter_time -> phải ĐO iteration_duration)
            │              │
            │              ▼
            └────── CT 3: T_max = max(T_vu_i)
                          │   (VU chậm nhất quyết định)
                          │
        CT 4: peak_rate = vus / iter_time   (đứng RIÊNG, chỉ cần vus + iter_time)
                          │
                          ▼
                   CT 5: T_total_max = min(maxDuration, T_max) + gracefulStop
                          │   (trần wall-clock thực sự)
                          ▼
            ┌─────────────────────────────────────────────┐
            │ SAU TEST verify (đọc summary):               │
            │   N_done (= iterations count) so với:        │
            │     • total_iter (CT 1) -> đủ hay thiếu?     │
            │     • T_max (CT 3)      -> chạy đúng giờ?    │
            │     • T_total_max (CT 5)-> footer running()? │
            └──────────────────┬──────────────────────────┘
                               ▼
        CT 6: average_rate = N_done / runtime_base   (LUÔN ≤ peak CT 4)
                               │   runtime_base = count / rate
                               ▼
        CT 7: http_reqs = total_iter × req_per_iter  (rate = count / runtime_base)
              checks_total = total_iter × checks_per_iter
```

Đọc luồng theo lời:

```text
CT 1 ─────────────────────► CT 5   (total_iter là mốc kỳ vọng để verify N_done)
CT 2 ──► CT 3 ────────────► CT 5   (T_vu_i -> T_max -> trần wall-clock)
CT 4                                (độc lập, chỉ để ước lượng load đỉnh)
CT 1 + CT 6 ──────────────► CT 7   (đếm request/check, chia ra rate)
CT 4 ≥ CT 6                         (peak luôn ≥ average; chênh = đuôi idle)
```

Hai nhóm CT theo lúc dùng:

| Dùng được TRƯỚC test (chỉ cần config) | Phải ĐO mới có (cần `iter_time` / summary) |
| --- | --- |
| CT 1 (total_iter) | CT 2 (T_vu_i) |
| CT 7 phần count (`total_iter × N`) | CT 3 (T_max, vì lấy từ CT 2) |
| CT 5 phần `maxDuration`, `gracefulStop` | CT 4 (peak_rate, cần iter_time) |
| — | CT 5 phần `T_max` (từ CT 3) |
| — | CT 6 (average_rate, cần N_done + runtime_base) |
| — | CT 7 phần rate (cần runtime_base) |

Ghi nhớ 1 câu: **CT 1 là cái duy nhất biết chắc trước khi chạy** (phép
nhân 2 số config); CT 7 phần count cũng suy ra trước được nếu code path
cố định. Các CT còn lại cần `iter_time` đo từ `iteration_duration` hoặc
số đọc từ summary. Vì vậy CT 1 vừa dùng để sizing (trước), vừa dùng làm
mốc verify (sau) — xem chi tiết ở cuối CT 1.

Phân nhóm theo MỤC ĐÍCH (nhớ theo cụm dễ hơn nhớ rời):

```text
Nhóm SỐ LƯỢNG (count) : CT 1 (iter), CT 7 (request/check)
Nhóm THỜI GIAN        : CT 2 (per-VU), CT 3 (scenario), CT 5 (trần)
Nhóm TỐC ĐỘ (rate)    : CT 4 (peak), CT 6 (average)
```

#### Công thức 1: "Tổng việc cần làm?" (Total iterations)

```text
total_iter = vus × iterations
```

**Tiếng Việt**: "Tổng số iter = số VU × số iter mỗi VU phải chạy"

**Ví dụ đời thường**:

```text
QA team có 4 nhân viên, mỗi người được giao kiểm 5 test case riêng.
=> tổng test case team chạy = 4 × 5 = 20 test case

Nhân viên A xong sớm KHÔNG được "lấy thêm" test case của nhân viên B.
   (Mỗi người tự kiểm phần được giao, không gộp chung)
```

**Áp vào k6**:

```text
vus=4, iterations=5
=> total_iter = 4 × 5 = 20 iter

Nếu vus=10, iterations=20:
=> total_iter = 10 × 20 = 200 iter (mỗi VU chạy đúng 20 iter)
```

**Vì sao KHÔNG cần buffer?**

Đây là phép nhân CHÍNH XÁC của 2 số config — không có yếu tố ngẫu nhiên,
không có jitter. `total_iter` đếm SỐ LỊCH GIAO, không phải số đã làm xong.
Nếu test có drop hoặc interrupt thì `N_done < total_iter`, dùng `total_iter`
làm mốc kỳ vọng để so với output (xem CT 5).

**Khác `shared-iterations` ở chỗ nào?**

```text
per-vu-iterations:
  total_iter = vus × iterations   (phép NHÂN, đếm RIÊNG mỗi VU)
  Mỗi VU chạy ĐÚNG N iter của mình, không lấy việc VU khác.

shared-iterations:
  total_iter = iterations          (1 con số, CHIA CHUNG cho cả pool VU)
  VU rảnh thì lấy iter tiếp theo, đến khi pool trống thì xong.
```

**Khi nào dùng**: trước khi viết test, để biết tổng tải hệ thống sẽ chịu
(vd: 4 user × 5 scenario = 20 lượt request); hoặc sau khi chạy, để so với
`iterations` count trong summary (verify test có chạy đủ không).

**Liên hệ với CT khác**:

```text
CT 1 (total_iter) -> mốc kỳ vọng để verify ở CT 5.

Sau khi chạy, gọi N_done = số ở cột trái dòng `iterations` trong summary:
  N_done == total_iter  -> chạy ĐỦ, không drop, không interrupt
  N_done <  total_iter  -> THIẾU, đi tìm nguyên nhân:
       thiếu = dropped_iterations + interrupted_iterations
       (drop: iter chưa kịp start vì hết maxDuration -> xem CT 5 / CT 3)

CT 1 KHÔNG phụ thuộc iter_time:
  -> dùng TRƯỚC test  : sizing (chốt vus, iterations)
  -> dùng SAU  test  : làm mốc so với summary
  (4 CT còn lại đều cần iter_time đo được mới tính ra số)
```

Ví dụ verify bằng số:

```text
config: vus=10, iterations=20
  -> total_iter = 10 × 20 = 200      (CT 1, biết trước khi chạy)

Sau khi chạy, summary ghi: iterations....: 188
  -> N_done = 188 < 200
  -> thiếu 12 iter
  -> nhìn thêm: dropped_iterations = 12  -> đúng là bị cắt ở maxDuration
  -> sang CT 5 xem maxDuration có < T_max không (nguyên nhân drop)
```

#### Công thức 2: "Mỗi nhân viên cần bao lâu?" (Per-VU runtime)

```text
T_vu_i = iterations × iter_time_i
```

**Tiếng Việt**: "Thời gian VU thứ i làm xong việc = số iter mỗi VU × thời
gian 1 iter của VU đó"

**Ví dụ đời thường**:

```text
QA team có 3 nhân viên, mỗi người kiểm 5 test case:
  - Nhân viên A nhanh, mỗi case 4 phút  -> tổng = 5 × 4 = 20 phút
  - Nhân viên B trung bình, mỗi case 6 phút -> tổng = 5 × 6 = 30 phút
  - Nhân viên C chậm, mỗi case 8 phút  -> tổng = 5 × 8 = 40 phút

A xong lúc 20 phút, ngồi không.
B xong lúc 30 phút.
C còn đang làm tới 40 phút mới xong.
```

**Áp vào k6**:

```text
config: vus=3, iterations=5

Nếu mỗi VU có iter_time khác nhau (do server lag, GC pause, ...):
  T_vu_1 = 5 × 0.4s = 2.0s   <- VU nhanh
  T_vu_2 = 5 × 0.5s = 2.5s   <- VU trung bình
  T_vu_3 = 5 × 0.6s = 3.0s   <- VU chậm

VU 1 xong lúc 2.0s -> IDLE đến hết scenario (không lấy việc VU khác)
VU 2 xong lúc 2.5s -> IDLE
VU 3 chạy đến 3.0s mới xong
```

**Vì sao KHÔNG cần buffer?**

`T_vu_i` là PHÉP NHÂN xác định: số iter (cố định) × iter_time đo được.
Iter_time có thể biến thiên theo từng iter (jitter), nhưng khi đã có
con số `iter_time_i` (lấy từ avg, p95, hay đo cụ thể từng VU), CT 2
chỉ là phép nhân cuối cùng. Buffer (nếu cần) đặt ở `iter_time` đầu vào
(vd dùng p95 thay vì avg), không phải ở CT 2.

**Khi nào dùng**: trước test để ước lượng từng VU mất bao lâu (giúp đặt
`maxDuration` đủ lớn); sau test để hiểu vì sao scenario chạy lâu hơn dự
kiến (do VU chậm nhất kéo dài).

**Liên hệ với CT khác**:

```text
CT 2 (T_vu_i) -> input cho CT 3 (T_max = max của các T_vu_i)
CT 2 cần biết iter_time -> đo từ Summary `iteration_duration` (xem 8.6)
```

#### Công thức 3: "Scenario kết thúc lúc nào?" (Scenario duration)

```text
T_max = max(T_vu_i)
```

**Tiếng Việt**: "Scenario kết thúc khi VU CHẬM NHẤT làm xong → lấy con số
LỚN NHẤT trong tất cả T_vu"

**Ví dụ đời thường**:

```text
QA team có 3 nhân viên (lấy lại từ CT 2):
  Nhân viên A xong lúc 20 phút
  Nhân viên B xong lúc 30 phút
  Nhân viên C xong lúc 40 phút    <- chậm nhất

Team meeting tổng kết tổ chức khi NÀO?
  -> Phải đợi C xong (lúc 40 phút)
  -> A và B đã rảnh từ trước, ngồi chờ C
  => T_team = max(20, 30, 40) = 40 phút
```

**Áp vào k6**:

```text
Lấy T_vu_i từ CT 2:
  T_vu_1 = 2.0s, T_vu_2 = 2.5s, T_vu_3 = 3.0s

T_max = max(2.0, 2.5, 3.0) = 3.0s

=> Scenario chạy đến 3.0s mới kết thúc.
   VU 1 và 2 IDLE từ giây 2.0 - 3.0 (waste 1s và 0.5s).
```

**Vì sao KHÔNG cần buffer?**

`T_max` là phép `max()` thuần — không có yếu tố ngẫu nhiên ngoài bản
thân `T_vu_i` đã có jitter rồi. Nếu cần dự phòng "VU chậm nhất chậm hơn
dự kiến", buffer đặt ở CT 5 (`maxDuration` đủ lớn so với `T_max`), không
phải ở CT 3.

**Đặc thù closed model (per-vu-iterations)**:

```text
Closed model: số việc CỐ ĐỊNH, scheduler ĐỢI VU chậm nhất xong.
  -> không có "drop khi đỉnh" như open model
  -> nhưng có IDLE TIME (VU nhanh xong sớm thì ngồi không)

Open model (constant-arrival-rate): rate cố định, scheduler ĐỀU NHỊP.
  -> không đợi ai, đến giờ thì fire slot
  -> có drop nếu VU không kịp nhận
```

**Khi nào dùng**: trước test để đặt `maxDuration` đủ lớn cho VU chậm
nhất; sau test để verify scenario có chạy đúng `T_max` không (so với
footer `running (X.Xs)`).

**Liên hệ với CT khác**:

```text
CT 2 (T_vu_i) -> input cho CT 3 (T_max = max)
CT 3 (T_max)  -> input cho CT 5 (T_total_max = min(maxDuration, T_max))
```

#### Công thức 4: "Throughput đỉnh là bao nhiêu?" (Peak rate)

```text
peak_rate ≈ vus / iter_time
```

**Tiếng Việt**: "Số iter hoàn thành mỗi giây ở đỉnh điểm ≈ số VU chia cho
thời gian 1 iter"

**Ví dụ đời thường**:

```text
QA team có 3 nhân viên, mỗi case làm 5 phút:
  - Cùng lúc 3 người làm song song
  - Mỗi 5 phút, team xong 3 case
  => throughput ≈ 3 / 5 = 0.6 case/phút (= 36 case/giờ)

Tăng nhân viên lên 6:
  => throughput ≈ 6 / 5 = 1.2 case/phút (= 72 case/giờ)
```

**Áp vào k6**:

```text
config: vus=5, iter_time=0.5s
=> peak_rate = 5 / 0.5 = 10 iter/s

Tức là khi cả 5 VU đều đang chạy:
  Mỗi 0.5s có 5 iter xong (1 iter/VU)
  => 10 iter/s tổng team
```

**Vì sao KHÔNG cần buffer?**

Đây là CÔNG THỨC ƯỚC LƯỢNG THƯỢNG GIỚI (upper bound), không phải dự
phòng. Throughput THỰC TẾ luôn ≤ peak_rate này:

```text
1. Có overhead VU (init, teardown, scheduler) -> giảm vài %
2. Có jitter iter_time -> 1 vài iter chậm kéo trung bình xuống
3. Cuối scenario VU xong sớm thì IDLE -> rate giảm về 0

=> peak_rate = "đỉnh điểm có thể chạm được", không phải con số trung bình.
   Số trung bình thực tế = N_done / T_max (xem CT 5).
```

**Khác `constant-arrival-rate` ở chỗ nào?**

```text
per-vu-iterations: rate là HỆ QUẢ của (vus, iter_time)
  -> không config trực tiếp được
  -> tăng vus hoặc giảm iter_time để tăng rate

constant-arrival-rate: rate là MỤC TIÊU config trực tiếp
  -> đặt rate=10/s trong config
  -> scheduler tự fire slot đều nhịp 10/s
  -> VU nhiều/ít chỉ ảnh hưởng có drop hay không
```

**Khi nào dùng**: ước lượng load đỉnh server sẽ chịu (vd `peak=10/s`,
mỗi iter có 2 HTTP request → server chịu peak 20 req/s); so sánh với
năng lực server (DB, API gateway) để biết test có realistic không.

**Liên hệ với CT khác**:

```text
CT 4 (peak_rate) chỉ phụ thuộc (vus, iter_time)
   -> không liên quan trực tiếp tới CT 1 (total_iter)
   -> không liên quan trực tiếp tới CT 3 (T_max)

CT 4 hữu ích để so với "rate target" khi chuyển sang executor open model:
   - Nếu chuyển per-vu-iterations sang constant-arrival-rate
   - Đặt target_rate ≤ peak_rate để không drop
```

#### Công thức 5: "Trần wall-clock" (Maximum runtime)

```text
T_total_max = min(maxDuration, T_max) + gracefulStop
```

**Tiếng Việt**: "Trần wall-clock của scenario = nhỏ hơn giữa `maxDuration`
(config) và `T_max` (thực tế từ CT 3), CỘNG `gracefulStop`"

**Ví dụ đời thường**:

```text
Văn phòng có quy định: làm việc tối đa 8h/ngày, hết giờ có 30 phút "đệm"
để đóng máy và viết báo cáo.

Trường hợp 1: Team xong việc lúc 6h (T_max = 6h)
  -> work_time = min(8h, 6h) = 6h
  -> total = 6h + 30 phút đệm = 6h30
  (Xong sớm, dùng đệm để dọn dẹp)

Trường hợp 2: Team chậm, đến 9h vẫn còn việc (T_max = 9h)
  -> work_time = min(8h, 9h) = 8h    (BỊ CẮT ở mốc 8h)
  -> total = 8h + 30 phút đệm = 8h30
  -> Việc còn dở phải hoãn ngày mai (= dropped iterations)
```

**Áp vào k6**:

```text
Trường hợp 1 — bình thường (config dư):
  maxDuration = 10m (default), T_max = 3s, gracefulStop = 30s
  T_total_max = min(10m, 3s) + 30s = 3s + 30s = 33s
  -> scenario chạy ~3s rồi dùng grace, không có drop

Trường hợp 2 — config cắt sớm:
  maxDuration = 2s (cố tình ngắn), T_max = 3s, gracefulStop = 30s
  T_total_max = min(2s, 3s) + 30s = 2s + 30s = 32s
  -> scenario bị cắt ở 2s, có thể có dropped + interrupted iterations
```

**Vì sao có dấu `min()`?**

```text
maxDuration = TRẦN config (k6 sẽ hard-stop ở mốc này)
T_max       = THỜI GIAN VU CHẬM NHẤT cần để xong (CT 3)

Nếu T_max < maxDuration:
  -> scenario tự xong sớm -> dùng T_max
Nếu T_max > maxDuration:
  -> bị cắt -> dùng maxDuration (k6 không cho chạy quá)

=> min() lấy con số NHỎ HƠN = mốc thực sự scenario kết thúc.
```

**Vì sao cộng `gracefulStop`?**

```text
gracefulStop = thời gian đệm SAU khi scenario "kết thúc" (theo nghĩa
                không start iter mới), CHO PHÉP iter đang chạy hoàn tất.

Nếu iter đang chạy không xong trong grace -> bị cancel = INTERRUPTED.
Default 30s, tăng lên nếu iter dài.
```

**Khi nào dùng**:

```text
- Trước test: ước lượng test sẽ tốn bao lâu trên CI/local
  vd: T_total_max = 3s + 30s = 33s -> CI cần ít nhất 33s timeout
- Sau test: verify footer "running (X.Xs)" khớp với T_total_max
- Diagnose drop: nếu maxDuration < T_max -> đó là nguyên nhân drop
```

**Liên hệ với CT khác**:

```text
CT 3 (T_max)        -> input cho CT 5 (so với maxDuration)
CT 5 < T_max        -> báo có drop (xem 8.3 "Có dropped_iterations")
CT 5 = T_max + grace -> test chạy trọn, có thể có interrupted ở grace
```

#### Công thức 6: "Throughput TRUNG BÌNH thực tế?" (Average rate)

```text
average_rate = N_done / runtime_base        (luôn ≤ peak_rate của CT 4)

trong đó:
  runtime_base = count / rate    (suy ngược từ bất kỳ Counter nào trong summary)
```

**Tiếng Việt**: "Tốc độ trung bình cả test = số iter hoàn thành chia cho
thời gian mà summary dùng làm mẫu số. Con số này LUÔN nhỏ hơn peak (CT 4)."

**Ví dụ đời thường**:

```text
QA team 10 người, mỗi case 5 phút. Lúc cả 10 cùng chạy: đỉnh = 2 case/phút
(CT 4). NHƯNG người nhanh xong sớm ngồi không, cuối buổi chỉ còn 2 người
chậm đang làm.

Cả buổi: 200 case xong trong 100 phút
  -> trung bình thực tế = 200 / 100 = 2 case/phút... KHÔNG, chờ đã:
  -> nếu xong trong 110 phút (vì đuôi chậm) = 200 / 110 ≈ 1.8 case/phút

=> trung bình (1.8) < đỉnh (2.0) vì giai đoạn cuối ít người làm.
```

**Áp vào k6**:

```text
Summary ghi:  iterations....: 200    19.98/s

-> N_done = 200, average_rate = 19.98/s  (k6 tự in, KHÔNG cần nhân vus)

Suy ngược mẫu số:
  runtime_base = count / rate = 200 / 19.98 ≈ 10.01s

So với peak (CT 4, demo 8 VU nhanh + 2 chậm):
  peak_rate ≈ 44/s  (lúc cả 10 VU active)
  average  ≈ 20/s   (cả test)
  -> average < peak vì 8 VU nhanh xong sớm rồi idle
```

**Vì sao average LUÔN ≤ peak?**

```text
peak_rate (CT 4) = lúc TẤT CẢ vus còn active, đỉnh tức thời
average_rate     = trải đều trên CẢ test, gồm cả đuôi ít VU

Trong per-vu-iterations: VU nhanh xong quota -> idle (không steal work).
-> số VU active GIẢM DẦN về cuối -> rate tụt -> kéo trung bình xuống.
-> đây chính là câu docs nói "maximum throughput reached but NOT maintained"
   (xem mục 5).

Dấu "=" chỉ xảy ra khi mọi VU có iter_time GIỐNG HỆT và xong cùng lúc
(không có đuôi idle). Thực tế gần như không bao giờ đạt.
```

**Vì sao `runtime_base = count / rate`?**

```text
Mọi metric Counter trong summary (iterations, http_reqs, checks_total)
đều in dạng:  count    rate/s
k6 tính rate = count / test_run_duration.

=> đảo lại: runtime_base = count / rate
   lấy từ Counter nào cũng ra CÙNG một mẫu số (xem 7.7.2 D.2).

Lưu ý: runtime_base là mẫu số của summary, KHÔNG luôn = T_max (CT 3).
Trong demo 1 scenario, startTime=0, không setup/teardown thì chúng gần
nhau. Có nhiều scenario / có setup() thì đừng đồng nhất 2 số này.
```

**Khi nào dùng**:

```text
- Sau test: đọc throughput trung bình THẬT đã đạt (cột /s trong summary)
- So sánh với peak (CT 4): chênh nhiều -> đuôi idle dài -> VU jitter cao
- Suy runtime_base để bắc cầu sang CT 7 (đếm request/check)
```

**Liên hệ với CT khác**:

```text
CT 6 (average_rate) ≤ CT 4 (peak_rate)   luôn đúng, dấu = hiếm
CT 6 cần N_done (từ CT 1 verify) và runtime_base
CT 6 (runtime_base) -> input cho CT 7 (tính rate của http_reqs, checks)
```

#### Công thức 7: "Đếm request / check là bao nhiêu?" (Derived counters)

```text
http_reqs    = total_iter × req_per_iter
checks_total = total_iter × checks_per_iter

rate mỗi cái = count / runtime_base    (runtime_base từ CT 6)
```

**Tiếng Việt**: "Tổng request = tổng iter × số request mỗi iter. Tổng check
tương tự. Muốn rate thì chia cho cùng mẫu số runtime_base."

**Ví dụ đời thường**:

```text
QA team chạy 20 test case (total_iter). Mỗi case gọi API 2 lần + kiểm 2
điều kiện.
  -> tổng lượt gọi API = 20 × 2 = 40
  -> tổng lượt kiểm    = 20 × 2 = 40

Số case (20) KHÁC số lượt gọi API (40). Đừng cộng 40+40 thành "80 case".
```

**Áp vào k6**:

```text
config: vus=4, iterations=3  -> total_iter = 12 (CT 1)
code:   1 iteration = 2 http.get() + 2 check()

http_reqs    = 12 × 2 = 24
checks_total = 12 × 2 = 24

Summary thật:
  iterations...: 12   2.3615/s
  http_reqs....: 24   4.723/s    <- = 2 × iterations/s
  checks_total.: 24   4.723/s

Verify mẫu số chung:
  runtime_base = 12 / 2.3615 ≈ 5.08s
  runtime_base = 24 / 4.723  ≈ 5.08s   <- cùng số, đúng
```

**Vì sao KHÔNG cộng `http_reqs + checks` thành 1 số?**

```text
iterations   = số vòng default() xong       (Counter riêng)
http_reqs    = số HTTP request đã gửi        (Counter riêng)
checks_total = số lần check chạy             (Counter riêng)

Ba metric ĐỘC LẬP, đo 3 thứ khác nhau. 24 request + 24 check KHÔNG phải
48 iteration. Xem 7.7.3.
```

**Cảnh báo: chỉ đúng khi code path CỐ ĐỊNH**

```text
http_reqs = total_iter × req_per_iter  CHỈ đúng khi mọi completed
iteration chạy đủ N request trên cùng nhánh code.

Nếu có if/else, retry, hoặc request lỗi giữa chừng -> số request mỗi iter
KHÔNG cố định -> phải đọc http_reqs THỰC TẾ trong summary, đừng tự nhân.
```

**Khi nào dùng**:

```text
- Trước test: ước lượng load HTTP server sẽ chịu
  vd: peak_rate=44/s (CT 4) × 2 req/iter = server peak ~88 req/s
- Sau test: verify http_reqs count khớp total_iter × req_per_iter
            (lệch -> có branch/lỗi làm thiếu request)
```

**Liên hệ với CT khác**:

```text
CT 1 (total_iter) -> input cho CT 7 (nhân với req_per_iter)
CT 6 (runtime_base) -> input cho CT 7 (chia ra rate)
CT 7 + CT 4: peak request rate = peak_rate × req_per_iter
```

### 8.2. Bảng tra nhanh: gặp tình huống nào, dùng công thức nào

7 tình huống hay gặp với `per-vu-iterations`, mỗi tình huống dùng công
thức nào:

```text
| Tình huống                                | Công thức chính | Phụ trợ      |
| ----------------------------------------- | --------------- | ------------ |
| 1. Sắp viết config, sizing iter mỗi VU    | CT 1, 2         | CT 3 verify  |
| 2. Có sẵn N VU, hỏi total iter chịu được  | CT 1 (đảo)      | CT 3, 5      |
| 3. Muốn biết VU nào chậm nhất kéo scenario| CT 2, 3         | -            |
| 4. Thiết kế ngược từ T_max mong muốn      | CT 2, 3         | CT 5         |
| 5. Đã chạy xong, đọc summary              | CT 5, 6         | CT 1, 3 verify |
| 6. Hỏi throughput thực tế đạt bao nhiêu   | CT 6            | CT 4 (so peak) |
| 7. Ước lượng load HTTP server sẽ chịu     | CT 7            | CT 1, 4      |
```

#### Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"

```text
Bước 1: Quyết định total_iter cần                          [Công thức 1]
   total_iter = số_user × số_test_case_mỗi_user
   vd: 4 user × 50 test case = 200

Bước 2: Phân chia (per-vu mapping)                         [Công thức 1]
   vus = số_user = 4
   iterations = số_test_case_mỗi_user = 50
   verify: vus × iterations = 4 × 50 = 200 ✓

Bước 3: Đo iter_time (chạy thử 1 VU, xem iteration_duration)
   W = iter_time = 0.5s (giả sử)

Bước 4: Ước lượng T_max                                    [Công thức 2 + 3]
   T_vu_i ≈ iterations × iter_time = 50 × 0.5 = 25s
   T_max ≈ T_vu_i (giả định các VU iter_time gần nhau)
   T_max ≈ 25s

Bước 5: Đặt maxDuration                                    [Công thức 5]
   maxDuration >= T_max × 1.2 (buffer cho VU chậm)
                = 25 × 1.2 = 30s
   vd: maxDuration = "1m" (60s, rất dư)
```

#### Tình huống 2: "Đã có sẵn N VU, hỏi total iter chịu được trong T phút?"

Câu hỏi điển hình: "Có 10 VU, muốn test trong 5 phút, đặt iterations
bao nhiêu để vừa thời lượng?"

```text
Bước 1: Đo iter_time
   W = 0.5s (chạy thử)

Bước 2: Tính iterations tối đa mỗi VU                      [Công thức 2 đảo]
   T_max <= maxDuration
   iterations × iter_time <= maxDuration
   iterations <= maxDuration / iter_time
              = (5 × 60) / 0.5 = 600

Bước 3: Áp buffer (đề phòng VU chậm)
   iterations_an_toàn = floor(600 × 0.83) ≈ 500
   (chừa 17% buffer = 1.2 nghịch đảo)

Bước 4: Tính total_iter                                    [Công thức 1]
   total_iter = vus × iterations = 10 × 500 = 5000 iter

Bước 5: Verify peak_rate                                   [Công thức 4]
   peak_rate ≈ vus / iter_time = 10 / 0.5 = 20 iter/s
   -> server có chịu được 20/s không? Nếu không, giảm iterations.
```

#### Tình huống 3: "Muốn biết VU nào chậm nhất kéo scenario"

Câu hỏi: "Sau test thấy `running 8s` mà tính trung bình chỉ 5s, vì
sao?"

```text
Bước 1: Đo iter_time TRUNG BÌNH (avg) và CỰC ĐẠI (max)
   avg = 0.5s (Summary iteration_duration avg)
   max = 0.8s (Summary iteration_duration max)

Bước 2: Tính T_vu_avg và T_vu_max                          [Công thức 2]
   T_vu_avg = iterations × avg = 10 × 0.5 = 5s
   T_vu_max = iterations × max = 10 × 0.8 = 8s

Bước 3: T_max thực tế = T_vu của VU CHẬM NHẤT             [Công thức 3]
   T_max = max(T_vu_i) ≈ T_vu_max = 8s
   (Khớp với footer "running 8s")

Bước 4: Tính tỷ lệ IDLE
   T_idle_avg = T_max - T_vu_avg = 8 - 5 = 3s
   -> VU trung bình ngồi không 3s (= 37.5% thời gian)
   -> Đây là cost của closed model với jitter cao.

Bước 5: Quyết định
   Nếu IDLE chấp nhận được -> giữ per-vu-iterations
   Nếu muốn giảm IDLE      -> chuyển sang shared-iterations
                              (VU nhanh "lấy việc" của VU chậm)
```

#### Tình huống 4: "Thiết kế ngược từ T_max mong muốn"

Câu hỏi: "Muốn test chạy đúng 1 phút, đặt iterations bao nhiêu?"

```text
Bước 1: Đo iter_time (chạy thử)
   W = 0.5s

Bước 2: Tính iterations từ T_max target                    [Công thức 2 đảo]
   T_max = 60s (target)
   iterations = T_max / iter_time = 60 / 0.5 = 120

Bước 3: Trừ buffer cho jitter
   iterations_an_toàn = 120 / 1.2 = 100
   (T_vu_avg = 50s, để VU chậm nhất xong trong 60s)

Bước 4: Tính total_iter dự kiến                            [Công thức 1]
   total_iter = vus × iterations
   vd vus=5: total = 5 × 100 = 500 iter

Bước 5: Đặt maxDuration đủ dư                              [Công thức 5]
   maxDuration = T_max × 1.2 = 60 × 1.2 = 72s
   vd: maxDuration = "1m20s"
```

#### Tình huống 5: "Đã chạy xong, đọc summary"

```text
Bước 1: Đọc 3 con số từ Summary + Footer
   N_done = iterations count            (Summary)
   N_drop = dropped_iterations           (Summary)
   N_int  = "X interrupted iterations"   (Footer)

Bước 2: Tính total_iter dự kiến                            [Công thức 1]
   total_iter = vus × iterations (config)

Bước 3: Verify quan hệ                                     [Công thức 5]
   N_done + N_drop + N_int = total_iter (chính xác trong closed model)

Bước 4: 3 câu hỏi diagnose
   1) N_done == total_iter?           -> hoàn hảo, dừng
   2) N_drop > 0?                     -> maxDuration ngắn (CT 5)
                                          → tăng maxDuration hoặc giảm
                                            iterations
   3) N_int > 0?                      -> grace ngắn (CT 5)
                                          → tăng gracefulStop

Bước 5: So actual_rate với peak_rate                       [Công thức 4]
   actual_rate = N_done / T_run (footer "running X.Xs")
   peak_rate   = vus / iter_time (CT 4)
   actual_rate / peak_rate gần 100% -> không có VU IDLE đáng kể
   actual_rate << peak_rate         -> VU jitter cao, có IDLE nhiều
```

### 8.3. Hành động khi gặp vấn đề

#### "Có dropped_iterations!"

Nguyên nhân: `maxDuration` quá ngắn so với `T_max` thực tế (CT 5: scenario
bị cắt trước khi VU chậm nhất xong).

```text
1. (DỄ NHẤT) Tăng maxDuration                              [verify CT 5]
   -> Cho VU đủ thời gian chạy hết iterations
   -> vd: từ "30s" lên "1m"
   -> Verify: maxDuration > T_max + buffer 20%

2. Giảm iterations                                         [verify CT 1, 2]
   -> Mỗi VU chạy ít iter hơn, T_vu_i giảm theo
   -> Total iter (CT 1) cũng giảm theo
   -> Tính lại T_max = iterations_mới × iter_time

3. Tối ưu code (giảm iter_time)                            [verify CT 2]
   -> Bỏ sleep dư, giảm số HTTP request
   -> T_vu_i = iterations × iter_time_mới (CT 2) -> nhỏ đi

4. Tăng vus, giữ iterations                                [verify CT 1]
   -> Đây là CÁCH SAI nếu mục đích chỉ là né drop
   -> Tăng vus chỉ tăng peak_rate (CT 4), KHÔNG giảm T_max
   -> Vì T_vu_i không phụ thuộc vus (mỗi VU chạy độc lập)
   -> total_iter SẼ TĂNG (vus × iterations) -> không phải fix tốt
```

#### "VU chậm kéo dài scenario" (T_max lớn hơn dự kiến)

Đây là behavior bình thường của closed model: scenario PHẢI đợi VU chậm
nhất xong (CT 3: `T_max = max(T_vu_i)`). Nếu khó chịu vì IDLE time:

```text
1. Chuyển sang shared-iterations (FIX TRIỆT ĐỂ)            [thay đổi CT 1]
   -> per-vu-iterations: total_iter = vus × iterations (CT 1)
                          T_max = max(T_vu_i)            (CT 3)
   -> shared-iterations: total_iter = iterations         (1 con số)
                          VU nhanh "lấy việc" của VU chậm
                          -> không có IDLE time

2. Giảm iterations                                         [verify CT 2]
   -> VU chậm cũng xong nhanh hơn -> T_max nhỏ đi

3. Tối ưu code (giảm jitter iter_time)                     [verify CT 2]
   -> Sleep ngẫu nhiên thay vì cố định -> giảm worst-case
   -> Cache token/connection -> latency ổn định hơn

4. Chấp nhận IDLE                                          [-]
   -> Đây là "giá phải trả" để đảm bảo MỖI VU chạy đúng N iter
   -> Use case: mỗi user N test case, không thể chia chung
```

#### "Có interrupted iterations cuối"

Nguyên nhân: iter cuối VU đang chạy thì grace hết (CT 5: cuối T_total_max
rơi vào giữa iter).

```text
1. (DỄ NHẤT) Tăng gracefulStop                             [verify CT 5]
   -> Default 30s, có thể tăng lên "1m" hoặc "2m"
   -> Iter đang chạy có thêm thời gian xong sạch

2. Đảm bảo iter_time × iterations < maxDuration            [verify CT 2 + 5]
   -> Tức là T_vu_i < maxDuration
   -> Iter cuối kịp xong trước maxDuration, không cần grace

3. Tối ưu iter cuối                                        [verify CT 2]
   -> iter_time nhỏ hơn -> iter cuối xong nhanh hơn
   -> Đặc biệt quan trọng nếu iter có HTTP timeout dài
```

#### "Tăng throughput đỉnh trong cùng iter_time"

Câu hỏi: "Đang có peak=10/s, muốn lên 20/s. Đổi config gì?"

```text
1. (CHỦ ĐẠO) Tăng vus                                      [áp CT 4]
   -> peak_rate = vus / iter_time (CT 4)
   -> Để peak=20/s, iter_time=0.5s -> vus = 10
   -> Tăng vus 2x -> peak_rate 2x

2. Giảm iter_time                                          [áp CT 4]
   -> peak_rate = vus / iter_time
   -> vus=5, iter_time=0.25s -> peak=20/s
   -> Tối ưu code, bỏ sleep dư

3. KHÁC shared-iterations                                  [-]
   -> per-vu-iterations: tăng vus -> total_iter TĂNG (vus × iter)
                          mỗi VU vẫn chạy đủ N iter
                          peak_rate tăng theo
   -> shared-iterations: tăng vus -> total_iter KHÔNG ĐỔI
                          chỉ chia nhỏ iter cho nhiều VU hơn
                          peak_rate tăng tới giới hạn iterations / iter_time
```

### 8.4. Bảng từ vựng: ký hiệu nào nghĩa là gì?

| Ký hiệu | Đọc là | Nghĩa | Đơn vị |
| --- | --- | --- | --- |
| `vus` | "vê u ét" | Số VU pin cố định trong scenario | VU |
| `iterations` | "i-tờ-rê-sần" | Số iter MỖI VU phải chạy (khác shared!) | iter |
| `total_iter` | "tô-tồ" | `vus × iterations` = tổng iter scenario | iter |
| `iter_time` | "i-tờ tham" | Thời gian 1 VU chạy 1 iter | giây/iter |
| `T_vu_i` | "ti vê u i" | Thời gian VU thứ i chạy hết N iter | giây |
| `T_max` | "ti mác" | `max(T_vu_i)` = thời gian VU chậm nhất | giây |
| `maxDuration` | "mặc ru-rây-sần" | Trần thời gian, VU bị cắt nếu vượt | giây |
| `gracefulStop` | "gờ-rây-sờ-ful" | Grace cuối scenario | giây |
| `peak_rate` | "pích rết" | `vus / iter_time` = throughput đỉnh | iter/giây |
| `N_done` | "ren đần" | Iter đã hoàn thành (summary) | iter |
| `N_drop` | "ren đờ-rốp" | Iter bị cắt (chưa kịp xong) | iter |
| `N_int` | "ren in-tờ" | Iter đã start nhưng bị cancel | iter |

### 8.5. 3 công thức "1 dòng" để giải mọi case (nhớ vĩnh viễn)

```text
Tổng việc?         total iter = số VU × số iter mỗi VU
Hết bao lâu?       thời gian ≈ số iter × thời gian 1 iter (VU chậm nhất)
Throughput đỉnh?   tốc độ đỉnh ≈ số VU / thời gian 1 iter
```

Học thuộc 3 dòng này là dùng được 80% nhu cầu thực tế. KHÁC
shared-iterations: ở đó "tổng việc" = `iterations` (1 con số chia chung),
không phải phép nhân.

### 8.6. Đọc output sau test: tìm số ở đâu?

Sau khi `k6 run` xong, output có 3 nhóm số liệu. Phải biết tìm từng con
số ở đâu để **áp vào đúng công thức** đã học ở 8.1.

**Bảng mapping nhanh: số ở đâu → dùng cho công thức nào**:

```text
| Số liệu                    | Đọc ở đâu                     | Dùng cho công thức |
| -------------------------- | ----------------------------- | ------------------ |
| vus                        | Header "X max VUs"            | CT 1, 4 (verify)   |
| iterations (mỗi VU)        | Header "N iterations for each"| CT 1, 2 (verify)   |
| total_iter dự kiến         | (tính: vus × iterations)      | CT 1               |
| maxDuration                | Header "(maxDuration: ...)"   | CT 5 (verify)      |
| gracefulStop               | Header "(gracefulStop: ...)"  | CT 5 (verify)      |
| W (iter_time avg)          | Summary iteration_duration avg| CT 2, 4 (sizing)   |
| W (iter_time max)          | Summary iteration_duration max| CT 2, 3 (worst-case)|
| N_done                     | Summary iterations count      | CT 5 (verify total)|
| N_drop                     | Summary dropped_iterations    | CT 5 (verify total)|
| actual_rate                | Summary iterations rate (X/s) | CT 4 (so peak)     |
| T_run                      | Footer "running (X.Xs)"       | CT 3 (T_max thực)  |
| N_int                      | Footer "X interrupted"        | CT 5 (verify total)|
```

#### Nhóm 1: Header (in ra ngay đầu test)

```text
scenarios: (100.00%) 1 scenario, 3 max VUs, 40s max duration (incl. graceful stop):
         * my_scenario: 5 iterations for each of 3 VUs (maxDuration: 10s, gracefulStop: 30s)
```

Đọc các con số:

```text
| Output                          | Biến         | Dùng để                              |
|---------------------------------|--------------|--------------------------------------|
| "3 max VUs"                     | vus          | INPUT cho CT 1 (total_iter), CT 4    |
| "40s max duration"              | T_total_max  | verify CT 5 = maxDuration + grace    |
| "5 iterations for each"         | iterations   | INPUT cho CT 1 (total), CT 2 (T_vu)  |
| "of 3 VUs"                      | vus          | trùng với "3 max VUs", verify config |
| "(maxDuration: 10s)"            | maxDuration  | INPUT cho CT 5 (so với T_max)        |
| "(gracefulStop: 30s)"           | gracefulStop | INPUT cho CT 5 (cộng vào T_total_max)|
```

**Khi nào đọc**: ngay đầu để verify config đã parse đúng. Đây là input
cho CT 1, 5 (chuẩn bị tính total_iter và T_total_max).

#### Nhóm 2: Summary cuối test (block "TOTAL RESULTS")

```text
EXECUTION
iteration_duration...: avg=505ms min=500ms max=520ms p(95)=515ms
iterations...........: 15    1.5/s
dropped_iterations...: 0
vus..................: 3     min=3  max=3
vus_max..............: 3     min=3  max=3
```

Đọc các con số:

```text
| Output                  | Biến         | Dùng để                              |
|-------------------------|--------------|--------------------------------------|
| iteration_duration avg  | W (avg)      | INPUT CT 2 (T_vu_avg), CT 4 (peak)   |
| iteration_duration max  | W (max)      | INPUT CT 2, 3 (T_vu của VU chậm nhất)|
| iterations (count)      | N_done       | OUTPUT CT 5 (verify với total_iter)  |
| iterations (rate)       | actual_rate  | OUTPUT CT 4 (so với peak_rate)       |
| dropped_iterations      | N_drop       | OUTPUT CT 5 (iter bị cắt)            |
| vus (max)               | M_active     | verify = vus config (per-vu pin VU)  |
| vus_max                 | preAllocated | verify pool init đúng config         |
```

**Khi nào đọc**: sau test xong, áp công thức ngược:

```text
- W từ Summary -> verify Bước 2 (T_vu_i = iterations × W)
- N_done so với total_iter (CT 1) -> tính tỷ lệ thành công (CT 5)
- W max / W avg cao hơn 1.5x -> báo VU jitter cao -> IDLE nhiều
- N_drop > 0 -> maxDuration ngắn -> tăng (xem 8.3)
```

#### Nhóm 3: Progress/footer (ngay trước summary)

```text
running (10.0s), 0/3 VUs, 15 complete and 0 interrupted iterations
```

Đọc các con số:

```text
| Output                      | Biến      | Dùng để                          |
|-----------------------------|-----------|----------------------------------|
| "10.0s"                     | T_run     | OUTPUT CT 3 (T_max thực tế)      |
| "0/3 VUs"                   | -         | snapshot lúc test xong (cosmetic)|
| "15 complete"               | N_done    | trùng với Summary, dùng CT 5     |
| "0 interrupted iterations"  | N_int     | OUTPUT CT 5 (iter bị cancel)     |
```

**Lưu ý**: `N_int` CHỈ xuất hiện ở footer, KHÔNG có metric Counter riêng
trong Summary. Phải đọc dòng progress cuối cùng.

**Tổng hợp luồng đọc số → áp công thức**:

```text
Header   -> vus, iterations, maxDuration, gracefulStop  [INPUT cho CT 1, 5]
Summary  -> W (avg/max), N_done, N_drop, actual_rate    [OUTPUT cho CT 1, 2, 4, 5]
Footer   -> T_run, N_int                                [OUTPUT cho CT 3, 5]

Áp công thức theo thứ tự:
   CT 1: total_iter = vus × iterations (từ Header)
   CT 2: T_vu_avg = iterations × W_avg, T_vu_max = iterations × W_max
   CT 3: T_max ≈ T_vu_max ≈ T_run (footer)
   CT 4: peak_rate = vus / W_avg, so với actual_rate (Summary)
   CT 5: N_done + N_drop + N_int = total_iter (kiểm tra đẳng thức)
```

### 8.7. Quy trình 5 bước phân tích output

Sau khi có đủ số liệu từ 8.6, làm 5 bước theo thứ tự. Mỗi bước **dùng
đúng 1 công thức từ 8.1**.

**Bảng mapping nhanh: Bước → Công thức → Số liệu cần**:

```text
| Bước | Công thức dùng       | Input cần               | Output                |
|------|----------------------|-------------------------|-----------------------|
| 1    | verify Header        | Header + config         | Verify config OK      |
| 2    | CT 1 (total)         | vus, iterations         | total dự kiến         |
| 3    | CT 5 (so N_done)     | N_done từ summary       | Tỷ lệ N_done/total    |
| 4    | CT 5 (drop/int)      | N_drop, N_int           | Diagnose drop/int     |
| 5    | CT 2/3 (suy ngược)   | iter_time + T_run       | T_max thực tế vs ước  |
```

Output mẫu để phân tích.

**Config đã chạy**:

```js
export const options = {
  scenarios: {
    demo_analyze: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 5,
      maxDuration: "10s",
      gracefulStop: "30s",
    },
  },
};

import { sleep } from "k6";
export default function () { sleep(0.5); }
```

**Output đầy đủ k6 in ra**:

```text
scenarios: (100.00%) 1 scenario, 3 max VUs, 40s max duration (incl. graceful stop):
         * demo_analyze: 5 iterations for each of 3 VUs (maxDuration: 10s, gracefulStop: 30s)

running (02.5s), 0/3 VUs, 15 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iteration_duration...: avg=502ms min=500ms max=510ms p(95)=508ms
    iterations...........: 15    6.0/s
    dropped_iterations...: 0
    vus..................: 3     min=3  max=3
    vus_max..............: 3     min=3  max=3
```

#### Bước 1: Verify config có chạy đúng không

```text
Header in:    "5 iterations for each of 3 VUs"
Config có:    vus=3, iterations=5 ✓

Header in:    "maxDuration: 10s, gracefulStop: 30s"
Config có:    đúng như vậy ✓

KẾT LUẬN: config đã parse đúng -> sang Bước 2
```

#### Bước 2: Tính total_iter dự kiến

```text
total_iter = vus × iterations = 3 × 5 = 15 iter
```

#### Bước 3: So với N_done thực tế

```text
Summary cho:  iterations = 15
Tính từ Bước 2: total_iter = 15

So sánh:
  N_done / total_iter = 15 / 15 = 100%
  -> hoàn hảo, mọi VU đều xong đủ 5 iter
```

#### Bước 4: Verify dropped/interrupted

```text
Summary cho:  dropped_iterations = 0
Footer cho:   "0 interrupted iterations" -> N_int = 0

Verify:
  N_done + N_drop + N_int = 15 + 0 + 0 = 15 = total_iter ✓

KẾT LUẬN: test "hoàn hảo" - không có vấn đề
```

#### Bước 5: Đo iter_time thực tế và suy ngược

```text
iteration_duration avg = 502ms = 0.502s

So với code: sleep(0.5) + console.log overhead
=> iter_time thực tế ≈ 502ms (overhead 2ms)

Tính lại T_max:
  T_max = iterations × iter_time = 5 × 0.502 = 2.51s

So với T_run:
  T_run = 2.5s (footer)
  T_max ≈ 2.51s
  -> khớp (chỉ chênh ms)

Đánh giá maxDuration:
  maxDuration = 10s, T_max = 2.5s
  -> dư 7.5s, an toàn (có thể giảm nhưng không cần)

Có thể tăng iter cho mỗi VU không?
  iterations_max = maxDuration / iter_time
                 = 10 / 0.502
                 ≈ 19 iter mỗi VU (giới hạn maxDuration)
  -> có thể đặt iterations = 18 (buffer 5%)
  -> tổng iter = 3 × 18 = 54 iter
```

