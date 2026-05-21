# TPS, Throughput, RPS: so sánh JMeter và k6

File này trả lời một câu rất hay bị lẫn:

```text
TPS là gì?
throughput là gì?
trong JMeter và k6 thì phải nhìn metric nào?
```

## 1. Kết luận ngắn trước

Nếu nói rất ngắn:

```text
throughput
  = số đơn vị công việc hoàn thành trên một đơn vị thời gian

RPS
  = requests per second
  = số HTTP request mỗi giây

TPS
  = transactions per second
  = số business transaction mỗi giây
```

Trong k6:

```text
http_reqs/s
  = request throughput
  = RPS

iterations/s
  = iteration throughput
  = TPS nếu 1 iteration đúng bằng 1 business flow / 1 transaction
```

Trong JMeter:

```text
Throughput ở Aggregate Report
  thường là throughput của sample đang nhìn

Nếu sample là HTTP Request
  => gần nghĩa RPS

Nếu sample là Transaction Controller generated sample
  => gần nghĩa TPS theo business flow
```

## 2. Vì sao dễ lẫn?

Vì nhiều team nói:

```text
TPS
```

nhưng mỗi người lại ngầm hiểu khác nhau:

```text
người A:
  1 request = 1 transaction

người B:
  1 flow nghiệp vụ = 1 transaction

người C:
  1 iteration script = 1 transaction
```

Nên trước khi đọc số, phải chốt:

```text
"transaction" trong bài test này là gì?
```

Nếu không chốt câu đó, rất dễ:

- gọi `http_reqs/s` là TPS
- hoặc gọi `iterations/s` là TPS
- nhưng thực ra hai con số khác nhau

## 3. Công thức gốc

Công thức gốc của throughput luôn là:

```text
throughput = completed_units / elapsed_time
```

Khác nhau nằm ở chỗ:

```text
completed_units là cái gì?
```

Ví dụ:

```text
completed_units = HTTP requests
  => request throughput / RPS

completed_units = business transactions
  => TPS

completed_units = iterations
  => iteration throughput
```

## 3.1. Peak throughput và average throughput khác nhau

Khi đọc k6 docs, có hai kiểu throughput rất dễ bị trộn:

```text
peak_total_rate
  = throughput cao nhất nếu tất cả VU còn active và chạy đều

average_total_rate
  = throughput trung bình của cả run
  = số summary `iterations/s`
```

Công thức đúng:

```text
per_vu_rate
  ≈ 1 / effective_iteration_time

peak_total_rate
  ≈ active_vus * per_vu_rate

average_total_rate
  = completed_iterations / summary_runtime_base
```

Trong đó:

```text
summary_runtime_base
  = khoảng thời gian của test run mà k6 summary dùng làm mẫu số cho Counter rate
  = không phải thời gian của riêng 1 VU
```

Không lấy:

```text
lấy summary iterations/s rồi nhân thêm vus
```

vì `summary iterations/s` đã là throughput của **toàn metric/run mà summary đang báo** rồi.
Trong demo 1 scenario sạch thì nó gần như cũng chính là throughput của scenario đó.

Ví dụ docs Grafana:

```text
1 iteration ≈ 515ms = 0.515s
```

Ở ví dụ docs này không có `minIterationDuration`, nên có thể xem:

```text
effective_iteration_time ≈ iteration_duration ≈ 0.515s
```

Nếu có `minIterationDuration`, phải dùng:

```text
effective_iteration_time ≈ max(iteration_duration, minIterationDuration)
```

Suy ra tốc độ của 1 VU:

```text
per_vu_rate
  ≈ 1 / 0.515
  ≈ 1.94 iter/s
  ≈ 2 iter/s
```

Nếu có:

```text
active_vus = 10
```

thì peak lý thuyết:

```text
peak_total_rate
  ≈ 10 * 1.94
  ≈ 19.4 iter/s
  ≈ 20 iter/s
```

Đó là lý do docs nói:

```text
Maximum throughput is expected to be ~20 iters/s
```

Nhưng nếu summary in:

```text
iterations.........: 12      2.317275/s
```

thì:

```text
average_total_rate = 2.317275 iter/s
```

con số này đã là tốc độ trung bình của toàn test, không nhân thêm `vus`.

Nếu muốn suy ngược tốc độ trung bình của 1 VU, mới chia:

```text
per_vu_rate_avg
  ≈ average_total_rate / active_vus
  ≈ 2.317275 / 4
  ≈ 0.579 iter/s
```

hoặc từ duration:

```text
iteration_duration avg = 1.72s

effective_iteration_time_avg
  ~= iteration_duration avg vì run này không có minIterationDuration

per_vu_rate_avg
  ≈ 1 / effective_iteration_time_avg
  ≈ 1 / 1.72
  ≈ 0.581 iter/s

estimated_total_rate_from_avg
  ≈ 4 * 0.581
  ≈ 2.32 iter/s
```

## 3.2. Vì sao docs nói peak có lúc không maintained?

Với `per-vu-iterations`:

```text
mỗi VU có quota riêng
VU nhanh xong quota trước thì idle
số active VU giảm dần về cuối test
throughput cuối test giảm
```

Nên docs nói:

```text
maximum throughput is reached, but not maintained
```

Với `shared-iterations`:

```text
có một pool iteration chung
VU nhanh xong thì lấy tiếp việc
các VU có xu hướng bận lâu hơn
throughput gần peak được giữ lâu hơn
```

Nên docs nói:

```text
maximum throughput is maintained for a larger portion of the test
```

Với `constant-vus`:

```text
số VU active được giữ cố định theo duration
```

nên nếu server và script ổn định, throughput có thể giữ plateau rõ hơn.

## 4. JMeter hiểu thế nào?

## 4.1. Throughput trong JMeter là gì?

Trong `Aggregate Report`, JMeter ghi:

```text
Throughput
```

và tài liệu chính thức mô tả nó là throughput gần đúng theo:

```text
request/second
```

hoặc theo phút/giờ nếu rate nhỏ.

Ý thực tế là:

```text
JMeter lấy số sample cùng label
chia cho tổng thời gian phát sinh các sample đó
```

Nên trong JMeter:

```text
Throughput là throughput của sample label đang nhìn
```

không phải mặc định luôn là:

```text
TPS theo business
```

## 4.2. Nếu sample là HTTP Request

Ví dụ row đang nhìn là:

```text
GET /
```

thì `Throughput` của row đó nên hiểu là:

```text
số request GET / mỗi giây
```

tức là gần với:

```text
RPS
```

## 4.3. Nếu sample là Transaction Controller

Nếu bạn dùng `Transaction Controller`, JMeter có thể tạo thêm:

```text
1 sample cha
```

đo tổng thời gian của cả block con.

Khi đó:

```text
1 sample cha = 1 business transaction
```

nếu bạn định nghĩa block đó là một flow nghiệp vụ.

Lúc đó throughput của sample cha này mới gần nghĩa:

```text
TPS
```

## 4.4. Hai note rất quan trọng bên JMeter

### A. `Throughput Controller` không phải controller để giữ TPS/RPS

Tên nó dễ gây hiểu nhầm.

Official docs nói thẳng:

```text
Throughput Controller is badly named,
as it does not control throughput
```

Nó chỉ quyết định:

- chạy bao nhiêu phần trăm iteration
- hoặc chạy tổng bao nhiêu lần

chứ không phải pacing theo `req/s`.

### B. Muốn target throughput trong JMeter thì thường nhìn `Constant Throughput Timer`

`Constant Throughput Timer` cố gắng giữ:

```text
samples per minute
```

gần với target đã set.

Nó vẫn có thể hụt target nếu:

- server chậm
- thiếu thread
- think time quá lớn
- có timer khác chen vào

## 5. k6 hiểu thế nào?

## 5.1. `http_reqs`

Trong k6:

```text
http_reqs..........: 24      4.634551/s
```

đọc là:

```text
toàn bộ run đã hoàn thành 24 HTTP requests
và tốc độ trung bình là 4.634551 request mỗi giây
```

Nên:

```text
http_reqs/s
  = request throughput
  = RPS
```

## 5.2. `iterations`

Trong k6:

```text
iterations.........: 12      2.317275/s
```

đọc là:

```text
toàn bộ run đã hoàn thành 12 iteration
và tốc độ trung bình là 2.317275 iteration mỗi giây
```

Nên:

```text
iterations/s
  = iteration throughput
```

Nó chỉ được gọi là:

```text
TPS
```

nếu bạn định nghĩa:

```text
1 iteration = 1 business transaction
```

## 5.3. `http_req_duration` và `iteration_duration` không phải throughput

Ví dụ:

```text
http_req_duration..: avg=253.37ms
iteration_duration.: avg=1.72s
```

đây là:

```text
latency / duration
```

không phải:

```text
throughput
```

Đọc đúng là:

```text
http_req_duration avg=253.37ms
  = trung bình 1 request mất 253.37ms

iteration_duration avg=1.72s
  = trung bình 1 iteration mất 1.72s
```

## 6. So sánh nhanh JMeter và k6

| Ý muốn đo | JMeter thường nhìn | k6 thường nhìn | Gọi chuẩn hơn là gì? |
| --- | --- | --- | --- |
| Số request mỗi giây | Throughput của HTTP Request sample | `http_reqs/s` | `RPS` / request throughput |
| Số business flow mỗi giây | Throughput của Transaction Controller sample | `iterations/s` nếu `1 iteration = 1 flow` | `TPS` |
| Thời gian 1 request | Average / Median / Percentiles của HTTP sample | `http_req_duration` | latency |
| Thời gian 1 flow | Average / Median / Percentiles của transaction sample | `iteration_duration` nếu `1 iteration = 1 flow` | transaction latency |
| Điều khiển target throughput | `Constant Throughput Timer` | thường là arrival-rate executors nếu mục tiêu là target iteration start rate | pacing / rate control |

Với k6 cần nhớ thêm:

```text
arrival-rate executor target nhịp start của iteration
muốn đổi sang RPS hay TPS thì còn phải biết 1 iteration chứa bao nhiêu request
hoặc đại diện cho bao nhiêu business transaction
```

## 7. Ví dụ đầy đủ: cùng một business flow

Ta dùng cùng ý tưởng cho cả hai tool:

```text
1 business flow
  = mở QuickPizza lần 1
  + mở QuickPizza lần 2
  + nghĩ 1 giây
```

Nên:

```text
1 business flow = 2 HTTP requests
```

## 7.1. JMeter bên trái sẽ model thế nào?

Lưu ý:

```text
phần JMeter dưới đây là cấu hình mẫu và cách đọc
không phải output vừa được chạy trong repo này
```

Ví dụ cấu trúc test plan:

```text
Test Plan
└── Thread Group
    ├── Number of Threads = 4
    ├── Ramp-Up = 1s
    ├── Loop Count = 3
    └── Transaction Controller: Open QuickPizza Twice
        ├── HTTP Request: GET https://quickpizza.grafana.com/
        ├── HTTP Request: GET https://quickpizza.grafana.com/
        └── Constant Timer: 1000ms
```

Nếu định nghĩa:

```text
Transaction Controller: Open QuickPizza Twice
  = 1 business transaction
```

thì:

```text
4 threads * 3 loops = 12 business transactions
12 business transactions * 2 requests = 24 HTTP requests
```

Lúc đó:

```text
throughput của HTTP Request rows
  => request throughput / RPS

throughput của Transaction Controller row
  => business TPS
```

## 7.2. k6 bên phải sẽ model thế nào?

File đang có sẵn:

```text
examples/shared_iterations_quickpizza_two_requests_demo.js
```

Code cốt lõi:

```js
const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const TOTAL_ITERATIONS = 12;

export const options = {
  scenarios: {
    quickpizza_shared_two_requests: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL_ITERATIONS,
      maxDuration: "30s",
      gracefulStop: "5s",
    },
  },
};

export default function () {
  const res1 = http.get(TARGET_URL);
  const res2 = http.get(TARGET_URL);

  check(res1, { "request 1 status is 200": (r) => r.status === 200 });
  check(res2, { "request 2 status is 200": (r) => r.status === 200 });

  sleep(1);
}
```

Ở đây ta định nghĩa:

```text
1 iteration = 1 business flow
           = 2 HTTP requests + sleep(1)
```

Nên:

```text
12 iterations = 12 business transactions
24 http_reqs = 24 HTTP requests
```

## 7.3. Output k6 thực tế

Run mẫu:

```text
http_req_duration..: avg=253.37ms min=251.26ms med=252.76ms max=258.88ms p(90)=255.7ms p(95)=255.98ms
http_reqs..........: 24      4.634551/s

iteration_duration.: avg=1.72s min=1.5s med=1.5s max=2.15s p(90)=2.14s p(95)=2.15s
iterations.........: 12      2.317275/s

running (05.2s), 0/4 VUs, 12 complete and 0 interrupted iterations
```

## 7.4. Bóc nghĩa của từng dòng

### Dòng request

```text
http_reqs..........: 24      4.634551/s
```

đọc là:

```text
đã có 24 HTTP requests hoàn thành
throughput request trung bình là 4.634551 request/s
```

Dòng này gọi chuẩn là:

```text
RPS
```

hoặc:

```text
request throughput
```

### Dòng business flow

```text
iterations.........: 12      2.317275/s
```

đọc là:

```text
đã có 12 iteration hoàn thành
throughput iteration trung bình là 2.317275 iteration/s
```

Vì bài này ta định nghĩa:

```text
1 iteration = 1 business transaction
```

nên dòng này chính là:

```text
TPS của business flow
```

### Dòng latency request

```text
http_req_duration..: avg=253.37ms
```

đọc là:

```text
trung bình 1 request mất 253.37ms
```

### Dòng latency business flow

```text
iteration_duration.: avg=1.72s
```

đọc là:

```text
trung bình 1 business flow mất 1.72s
```

## 7.5. Công thức nối 2 dòng lại với nhau

Ở bài này:

```text
1 iteration = 2 HTTP requests
```

nên:

```text
estimated_http_reqs_rate = 2 * iterations/s
```

Công thức này chỉ đúng cho run sạch này vì mỗi completed iteration đều chạy đủ 2 HTTP requests.
Nếu code có branch/error/interrupt làm số request không cố định, đọc `http_reqs` thực tế từ summary
hoặc custom metric.

Kiểm tra:

```text
2 * 2.317275
= 4.63455
```

khớp gần như hoàn toàn:

```text
http_reqs/s = 4.634551/s
```

Đây là chỗ rất quan trọng:

```text
TPS và RPS không nhất thiết bằng nhau
```

Nếu 1 transaction gọi nhiều request:

```text
RPS > TPS
```

Nếu 1 transaction chỉ có 1 request:

```text
RPS ≈ TPS
```

## 8. Vậy khi nào gọi cái nào?

## 8.1. Khi nói về server/API layer

Thường nói:

```text
RPS
request throughput
http_reqs/s
```

vì ta đang quan tâm:

```text
server nhận bao nhiêu HTTP requests mỗi giây
```

## 8.2. Khi nói về nghiệp vụ

Thường nói:

```text
TPS
transaction throughput
business flow throughput
```

vì ta đang quan tâm:

```text
mỗi giây hoàn thành bao nhiêu flow nghiệp vụ
```

Ví dụ:

```text
login + xem dashboard + checkout + logout
```

là 1 transaction nghiệp vụ, dù bên trong có thể có rất nhiều HTTP requests.

## 8.3. Trong k6

Nên nói khá chặt:

```text
http_reqs/s
  = request throughput / RPS

iterations/s
  = iteration throughput
```

và chỉ gọi `iterations/s` là TPS nếu:

```text
iteration của bạn thực sự đại diện cho 1 business transaction
```

## 9. Trường hợp `iterations/s` không phải TPS

Ví dụ code của bạn:

```js
export default function () {
  login();
  search();
  addToCart();
  checkout();
  logout();
}
```

Nếu team định nghĩa:

```text
transaction chỉ là checkout
```

thì:

```text
iterations/s
```

không còn là TPS chuẩn của `checkout`.

Khi đó bạn cần:

- định nghĩa lại `1 iteration = 1 checkout flow`
- hoặc tạo custom metric riêng cho transaction bạn muốn đếm

## 10. So sánh rất ngắn kiểu đi phỏng vấn / đi giải thích team

Bạn có thể nói ngắn như này:

```text
JMeter và k6 đều có throughput,
nhưng phải hỏi "throughput của đơn vị nào?".

Nếu đơn vị là HTTP request:
  đó là RPS

Nếu đơn vị là business transaction:
  đó là TPS

Trong k6:
  http_reqs/s = RPS
  iterations/s = TPS nếu 1 iteration = 1 business flow
```

## 11. Những chỗ hay nhầm nhất

### Nhầm 1. `http_req_duration` là throughput

Sai.

```text
http_req_duration
  = thời gian của request

http_reqs/s
  = số request mỗi giây
```

### Nhầm 2. `iteration_duration` là TPS

Sai.

```text
iteration_duration
  = thời gian 1 iteration

iterations/s
  = số iteration mỗi giây
```

### Nhầm 3. `http_reqs/s` luôn bằng TPS

Sai.

Chỉ đúng nếu:

```text
1 transaction = 1 request
```

Nếu:

```text
1 transaction = 2 requests
```

thì:

```text
RPS = 2 * TPS
```

### Nhầm 4. `Throughput Controller` của JMeter là thứ dùng để set target TPS

Sai.

Theo official docs:

```text
Throughput Controller không control throughput theo req/s
```

Muốn pacing gần target throughput thì thường xem:

```text
Constant Throughput Timer
```

## 12. Chốt cách nhớ

Nhớ bằng 3 câu:

```text
latency trả lời:
  một việc mất bao lâu

throughput trả lời:
  mỗi giây xong bao nhiêu việc

TPS hay RPS phụ thuộc:
  "việc" ở đây là request hay business transaction
```

## 13. Nguồn tham khảo

- Apache JMeter Component Reference:
  <https://jmeter.apache.org/usermanual/component_reference.html>
- k6 script demo trong repo:
  [examples/shared_iterations_quickpizza_two_requests_demo.js](../examples/shared_iterations_quickpizza_two_requests_demo.js)
- k6 worked example liên quan:
  [20260515_shared_iterations_quickpizza_two_requests_worked_example.md](./20260515_shared_iterations_quickpizza_two_requests_worked_example.md)
