# k6 metric types and formulas

File này chỉ trả lời một câu:

```text
metric trong k6 có những loại nào
và mỗi loại đọc / tính theo công thức nào
```

Nếu đang học từ đầu hoặc muốn xem phần giải thích rất chi tiết theo core, đọc thêm:

```text
docs/20260520_00_k6-metrics-types-builtins-core-guide.md
```

File này giữ vai trò bản tra nhanh, nhưng vẫn có ví dụ cực ngắn ngay trong từng loại:

```text
nhìn công thức nhanh
đối chiếu nhanh khi đang đọc các bài executor
đọc tới type nào là thấy ví dụ ngắn của type đó ngay
```

Phạm vi của file:

- bám theo core k6
- ưu tiên các metric hay gặp khi học executor
- không đi sâu vào output backend khác

Xem thêm bài so sánh thuật ngữ:

```text
docs/20260515_06_tps-throughput-jmeter-vs-k6.md
```

## 1. Bốn loại metric chính trong k6

Trong core k6, các metric builtin hay gặp rơi vào 4 loại:

| Loại | Ý nghĩa ngắn | Ví dụ |
| --- | --- | --- |
| `Counter` | đếm tổng số event | `iterations`, `http_reqs` |
| `Gauge` | giá trị thay đổi lên xuống theo thời điểm | `vus`, `vus_max` |
| `Trend` | tập các giá trị đo được để lấy `avg/min/max/p95...` | `http_req_duration`, `iteration_duration` |
| `Rate` | tỉ lệ `true / total` | `checks`, `http_req_failed` |

Một vài mapping builtin trong core:

```text
Iterations        -> Counter
HTTPReqs          -> Counter
VUs               -> Gauge
VUsMax            -> Gauge
IterationDuration -> Trend
HTTPReqDuration   -> Trend
Checks            -> Rate
HTTPReqFailed     -> Rate
```

## 2. `Counter`

### 2.1. Ý nghĩa

`Counter` dùng để đếm:

```text
đã có bao nhiêu event xảy ra
```

Ví dụ:

- `iterations`: đã hoàn thành bao nhiêu iteration
- `http_reqs`: đã gửi bao nhiêu request

Ví dụ mini:

```text
demo_orders.add(1)
demo_orders.add(2)

=> Counter cuối cùng = 3
```

Demo cực ngắn trong script:

```js
import { Counter } from "k6/metrics";

const demoOrders = new Counter("demo_orders");

export default function () {
  demoOrders.add(1);
  demoOrders.add(2);
}
```

Nếu script chỉ chạy đúng 1 iteration thì cuối test, metric custom này sẽ có hình dạng như:

```text
demo_orders........: 3    ...
```

Đọc rất thẳng:

```text
ta add 2 sample có value 1 và 2
Counter cộng dồn 1 + 2
nên tổng cuối cùng là 3
```

### 2.2. Summary thường in gì?

Ví dụ:

```text
iterations.........: 12    2.255308/s
http_reqs..........: 24    4.510616/s
```

Ta đọc là:

```text
count = số event
rate  = số event mỗi giây
```

Ví dụ nếu thấy:

```text
iterations.........: 12      2.317275/s
```

thì đọc là:

```text
toàn bộ run đã hoàn thành 12 iteration
và cột /s của Counter đang cho biết trung bình khoảng 2.317275 iteration mỗi giây
```

`2.317275/s` nghĩa là:

```text
trung bình mỗi giây, cả test hoàn thành khoảng 2.31 iteration
```

Nó **không có nghĩa**:

```text
giây nào cũng đúng 2.317275 iteration
```

và cũng **không phải**:

```text
tốc độ của riêng 1 VU
```

Để tránh nhầm, ta đặt tên mẫu số đó là:

```text
summary_runtime_base
```

Ví dụ:

```text
summary_runtime_base
  = 12 / 2.317275
  ≈ 5.18s
```

Nên có thể đọc thành câu:

```text
Counter summary này đang lấy 12 chia cho khoảng 5.18 giây
nên in ra tốc độ trung bình 2.317275 iteration/s
```

Với demo một scenario sạch thì `summary_runtime_base` thường gần với thời gian test bạn nhìn thấy.
Nhưng nói chính xác theo core thì đây là:

```text
mẫu số mà Counter summary dùng cho cột /s
không phải lúc nào cũng là runtime thật của riêng scenario
```

### 2.3. Công thức từ core

Core tính:

```text
rate = count / duration
```

Suy ngược:

```text
summary_runtime_base = count / rate
```

Ở file tra nhanh này, nên đọc `duration` đó thành:

```text
summary_runtime_base
```

Phân biệt nhanh với `Trend`:

```text
iteration_duration avg=1.72s
  = trung bình 1 iteration hoàn thành mất 1.72 giây

iterations.........: 12      2.317275/s
  = trung bình cả scenario hoàn thành 2.317275 iteration mỗi giây
```

### 2.4. Ví dụ

```text
iterations.........: 12    2.255308/s
```

Suy ra:

```text
summary_runtime_base
  = 12 / 2.255308
  ≈ 5.3208s
```

Với:

```text
http_reqs..........: 24    4.510616/s
```

thì cũng ra cùng mẫu số:

```text
summary_runtime_base
  = 24 / 4.510616
  ≈ 5.3208s
```

### 2.5. Khi nào dùng `Counter`?

Dùng khi bạn muốn biết:

- đã chạy xong bao nhiêu iteration
- đã gửi bao nhiêu request
- tốc độ trung bình mỗi giây là bao nhiêu

## 3. `Gauge`

### 3.1. Ý nghĩa

`Gauge` là metric có thể:

- tăng
- giảm
- và được sample theo thời điểm

Ví dụ:

- `vus`
- `vus_max`

Ví dụ mini:

```text
queue_depth lần lượt nhận các sample: 5, 9, 3

=> value cuối = 3
=> min = 3
=> max = 9
```

Demo cực ngắn trong script:

```js
import { Gauge } from "k6/metrics";

const queueDepth = new Gauge("queue_depth");

export default function () {
  queueDepth.add(5);
  queueDepth.add(9);
  queueDepth.add(3);
}
```

Nếu script chỉ chạy đúng 1 iteration thì metric custom này sẽ có hình dạng như:

```text
queue_depth........: 3    min=3 max=9
```

Đọc rất thẳng:

```text
Gauge không cộng 5 + 9 + 3
nó giữ giá trị cuối là 3
đồng thời nhớ min là 3 và max là 9
```

### 3.2. Summary thường in gì?

Ví dụ:

```text
vus................: 4    min=4   max=4
vus_max............: 4    min=4   max=4
```

Ta đọc là:

```text
value = sample cuối cùng
min   = sample nhỏ nhất
max   = sample lớn nhất
```

### 3.3. Công thức / cách đọc

`Gauge` không có công thức kiểu:

```text
rate = count / summary_runtime_base
```

Nó không phải metric để chia theo runtime.

Với `Gauge`, điều quan trọng là:

```text
value
min
max
```

### 3.4. Ví dụ

```text
vus: 2 min=2 max=10
```

Đọc là:

```text
sample cuối cùng thấy 2 VU active
sample nhỏ nhất thấy 2
sample lớn nhất thấy 10
```

## 4. `Trend`

### 4.1. Ý nghĩa

`Trend` lưu một tập giá trị đo được, rồi summary lấy thống kê:

- `avg`
- `min`
- `med`
- `max`
- `p(90)`
- `p(95)`

Ví dụ:

- `http_req_duration`
- `iteration_duration`

Ví dụ mini:

```text
demo_latency có 4 sample: 100, 200, 300, 400

=> avg = 250
=> min = 100
=> max = 400
=> med = p50 = 250
```

Demo cực ngắn trong script:

```js
import { Trend } from "k6/metrics";

const demoLatency = new Trend("demo_latency", true);

export default function () {
  demoLatency.add(100);
  demoLatency.add(200);
  demoLatency.add(300);
  demoLatency.add(400);
}
```

Nếu script chỉ chạy đúng 1 iteration thì metric custom này sẽ có hình dạng như:

```text
demo_latency.......: avg=250ms min=100ms med=250ms max=400ms ...
```

Đọc rất thẳng:

```text
Trend không cộng dồn thành một số duy nhất như Counter
nó giữ cả tập [100, 200, 300, 400]
rồi từ tập đó mới tính avg, med, p95...
```

### 4.2. Summary thường in gì?

Ví dụ:

```text
http_req_duration........: avg=260.76ms min=258.73ms med=260.77ms max=262.43ms p(90)=262ms p(95)=262.07ms
iteration_duration.......: avg=1.77s    min=1.52s    med=1.52s    max=2.27s    p(90)=2.27s p(95)=2.27s
```

### 4.3. Cách đọc `avg/min/med/max/p(90)/p(95)`

Trước hết phải hiểu: `Trend` là một **tập nhiều sample**.

`sample` ở đây **không phải**:

```text
cứ mỗi 1 giây k6 lấy 1 mẫu
```

`sample` ở đây là:

```text
mỗi event hoàn thành tạo ra 1 giá trị duration
```

Ví dụ với `iteration_duration`, mỗi iteration hoàn thành tạo ra 1 sample:

```text
sample 1 = iteration 1 mất bao lâu
sample 2 = iteration 2 mất bao lâu
sample 3 = iteration 3 mất bao lâu
...
```

Với `http_req_duration`, mỗi HTTP request hoàn thành tạo ra 1 sample.

Nên nếu summary ghi:

```text
iteration_duration avg=1.72s
```

thì phải đọc là:

```text
trung bình một iteration hoàn thành mất 1.72 giây
```

chứ không phải:

```text
trung bình mỗi 1 giây k6 đo được 1.72 giây
```

Cách đọc:

```text
avg
  = average / trung bình cộng
  = tổng tất cả sample / số sample
  = nhìn "mặt bằng chung", nhưng dễ bị kéo lệch bởi vài sample rất chậm

min
  = minimum / nhỏ nhất
  = sample nhanh nhất trong cả run

med
  = median / p(50)
  = mốc giữa của tập sample
  = khoảng 50% sample nhanh hơn hoặc bằng số này

max
  = maximum / lớn nhất
  = sample chậm nhất trong cả run

p(90)
  = percentile 90
  = khoảng 90% sample nhanh hơn hoặc bằng số này
  = khoảng 10% sample còn lại chậm hơn số này

p(95)
  = percentile 95
  = khoảng 95% sample nhanh hơn hoặc bằng số này
  = khoảng 5% sample còn lại chậm hơn số này
```

Nói ngắn:

```text
avg  đọc "trung bình mất bao lâu"
min  đọc "nhanh nhất mất bao lâu"
med  đọc "mốc giữa mất bao lâu"
max  đọc "chậm nhất mất bao lâu"
p90  đọc "90% lần đo không chậm hơn số này"
p95  đọc "95% lần đo không chậm hơn số này"
```

Core `TrendSink` tính như sau:

```text
Avg()
  = sum / count

Min()
  = min đã ghi nhận khi Add(sample)

Max()
  = max đã ghi nhận khi Add(sample)

P(0.90), P(0.95)
  = sort toàn bộ values
  = lấy vị trí percentile
  = nếu rơi giữa 2 sample thì nội suy tuyến tính
```

Vì có nội suy, `p(90)` / `p(95)` không nhất thiết đúng bằng một sample gốc.

### 4.4. Ví dụ đọc một dòng summary

Output:

```text
iteration_duration.......: avg=1.77s min=1.52s med=1.52s max=2.27s p(90)=2.27s p(95)=2.27s
```

Đọc là:

```text
avg=1.77s
  trung bình một iteration mất 1.77 giây

min=1.52s
  iteration nhanh nhất mất 1.52 giây

med=1.52s
  khoảng một nửa số iteration mất <= 1.52 giây

max=2.27s
  iteration chậm nhất mất 2.27 giây

p(90)=2.27s
  khoảng 90% iteration mất <= 2.27 giây

p(95)=2.27s
  khoảng 95% iteration mất <= 2.27 giây
```

Nếu sample ít, `p(90)` và `p(95)` rất dễ gần hoặc bằng `max`, vì phần đuôi chỉ có vài sample.

### 4.5. Điều quan trọng

`Trend` không nói:

```text
bao nhiêu event mỗi giây
```

Nó nói:

```text
mỗi event mất bao lâu
```

Nên:

- `http_req_duration` = thời gian của request
- `iteration_duration` = thời gian của cả iteration

### 4.6. Ví dụ suy luận tốc độ gần đúng

Nếu:

```text
iteration_duration avg = 1.77s
```

thì có thể suy luận gần đúng:

```text
1 VU rate ≈ 1 / 1.77 ≈ 0.565 iter/s
```

Nhưng đây là suy luận phân tích, không phải field summary gốc của core.

## 5. `Rate`

### 5.1. Ý nghĩa

`Rate` không phải "event per second".

`Rate` trong k6 nghĩa là:

```text
tỉ lệ số sample true / tổng số sample
```

Ví dụ:

- `checks`
- `http_req_failed`

Ví dụ mini:

```text
checkout_ok lần lượt add: true, false, true

=> total = 3
=> trues = 2
=> rate = 2 / 3 = 66.67%
```

Demo cực ngắn trong script:

```js
import { Rate } from "k6/metrics";

const checkoutOk = new Rate("checkout_ok");

export default function () {
  checkoutOk.add(true);
  checkoutOk.add(false);
  checkoutOk.add(true);
}
```

Nếu script chỉ chạy đúng 1 iteration thì metric custom này sẽ có hình dạng như:

```text
checkout_ok........: 66.67% 2 out of 3
```

Đọc rất thẳng:

```text
Rate không hỏi mỗi giây có bao nhiêu event
nó hỏi trong 3 lần ghi nhận thì có 2 lần là true
nên rate = 2 / 3 = 66.67%
```

### 5.2. Công thức từ core

Core tính:

```text
rate = trues / total
passes = trues
fails = total - trues
```

### 5.3. Ví dụ `http_req_failed`

Nếu output là:

```text
http_req_failed......: 0.00% 0 out of 24
```

thì:

```text
trues = số request fail
total = tổng request
rate = failed_requests / total_requests
```

Run này:

```text
0 / 24 = 0%
```

### 5.4. Ví dụ `checks`

`checks` trong core là `Rate`, nhưng summary text thường tách thành:

- `checks_total`
- `checks_succeeded`
- `checks_failed`

Ví dụ:

```text
checks_total.......: 24      4.510616/s
checks_succeeded...: 100.00% 24 out of 24
checks_failed......: 0.00%   0 out of 24
```

Ở đây cần tách ra:

```text
checks_total rate
  = total_checks / summary_runtime_base
```

đây là summary phụ trợ để dễ đọc,

còn `checks_succeeded` / `checks_failed` mới là cách hiển thị đúng tinh thần `Rate`:

```text
success_rate = successful_checks / total_checks
failed_rate = failed_checks / total_checks
```

## 6. Bảng công thức nhanh theo loại metric

| Loại | Summary hay thấy | Công thức chính |
| --- | --- | --- |
| `Counter` | `count`, `rate/s` | `rate = count / summary_runtime_base` |
| `Gauge` | `value`, `min`, `max` | không chia theo runtime |
| `Trend` | `avg`, `min`, `med`, `max`, `p(90)`, `p(95)` | `avg = sum / count`, `med = p50` |
| `Rate` | `%`, `x out of y`, `passes`, `fails` | `rate = trues / total` |

## 7. Các metric hay gặp nên đọc theo loại nào?

| Metric | Loại | Đọc như nào? |
| --- | --- | --- |
| `iterations` | `Counter` | bao nhiêu iteration đã xong, tốc độ bao nhiêu iter/s |
| `http_reqs` | `Counter` | bao nhiêu request đã gửi, tốc độ bao nhiêu req/s |
| `checks_total` | summary phụ trợ | tổng số check và tốc độ checks/s |
| `checks_succeeded` | `Rate` style | bao nhiêu check pass |
| `checks_failed` | `Rate` style | bao nhiêu check fail |
| `http_req_failed` | `Rate` | tỉ lệ request fail |
| `http_req_duration` | `Trend` | request mất bao lâu |
| `iteration_duration` | `Trend` | iteration mất bao lâu |
| `vus` | `Gauge` | tại các sample, có bao nhiêu VU active |
| `vus_max` | `Gauge` | tại các sample, có bao nhiêu VU initialized |

## 8. Nhìn output thì nên hỏi theo thứ tự nào?

### Nếu hỏi "Counter summary đang dùng mẫu số thời gian nào cho cột /s?"

Nhìn `Counter`:

```text
summary_runtime_base = count / rate
```

Nếu là single-scenario clean run thì số này thường gần với thời gian test bạn nhìn thấy.

### Nếu hỏi "1 iteration mất bao lâu?"

Nhìn `Trend`:

```text
iteration_duration
```

### Nếu hỏi "1 giây gửi bao nhiêu request?"

Nhìn `Counter`:

```text
http_reqs/s
```

### Nếu hỏi "1 giây 1 VU chạy được bao nhiêu iteration?"

Suy luận từ thời gian VU bị chiếm cho một iteration:

```text
effective_iteration_time ~= iteration_duration nếu không có minIterationDuration
effective_iteration_time ~= max(iteration_duration, minIterationDuration) nếu có minIterationDuration

per_vu_rate ≈ 1 / effective_iteration_time
```

### Nếu hỏi "có bao nhiêu VU đang active?"

Nhìn `Gauge`:

```text
vus
```

### Nếu hỏi "tỉ lệ fail là bao nhiêu?"

Nhìn `Rate`:

```text
http_req_failed
checks_failed
```

## 9. Chỗ dễ nhầm nhất

### Nhầm `Rate` với `rate/s`

Không giống nhau:

```text
Counter rate/s
  = số event mỗi giây

Rate metric
  = tỉ lệ true / total
```

### Nhầm `http_req_duration` với `http_reqs/s`

Không giống nhau:

```text
http_req_duration
  = request mất bao lâu

http_reqs/s
  = mỗi giây gửi được bao nhiêu request
```

### Nhầm `iterations` với `http_reqs`

Không phải lúc nào:

```text
iterations = http_reqs
```

Chỉ đúng nếu mỗi completed iteration luôn chạy đúng 1 request:

```text
1 iteration = 1 request
```

Nếu:

```text
1 iteration = 2 requests
```

và mỗi completed iteration luôn chạy đủ 2 request thì có thể ước lượng:

```text
http_reqs = 2 * iterations
estimated_http_reqs_rate ≈ 2 * iterations/s
```

Nếu code có branch/error/interrupt làm số request mỗi completed iteration không cố định, đọc
`http_reqs` thực tế thay vì nhân máy móc.

## 10. Nguồn core nên nhớ

Nếu cần check lại tận code:

- `metrics/builtin.go`: metric nào thuộc loại nào
- `metrics/sink.go`: công thức của `Counter`, `Gauge`, `Trend`, `Rate`
- `internal/output/summary/data.go`: summary lấy giá trị nào để in ra
