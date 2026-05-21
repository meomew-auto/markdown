# k6 metrics căn bản: metric types, built-in metrics, và cách core tính

Bài này là bài nền về `metrics` trong k6.

Mục tiêu:

```text
đọc được output k6
biết metric đó thuộc loại nào
biết vì sao nó in ra count/rate/avg/p95/min/max
biết metric đó nằm ở đâu trong core
biết khi nào nên tự tạo custom metric
có demo chi tiết cho từng loại metric
```

Bài này khác bài công thức ngắn:

```text
docs/20260515_k6_metric_types_and_formulas.md
```

File cũ dùng để tra nhanh. File này giải thích từ đầu và list đầy đủ hơn theo official docs và core code.

## Mục lục nhanh

- [1. Metric là gì?](#1-metric-là-gì)
- [2. Core nhìn metric như nào?](#2-core-nhìn-metric-như-nào)
- [3. Bốn loại metric trong k6](#3-bốn-loại-metric-trong-k6)
- [4. Cách đọc từng loại metric](#4-cách-đọc-từng-loại-metric)
- [4.5 Tổng hợp: chọn type theo câu hỏi](#45-tổng-hợp-chọn-type-theo-câu-hỏi)
- [5. Value type: default, time, data](#5-value-type-default-time-data)
- [6. Built-in metrics đầy đủ theo docs và core](#6-built-in-metrics-đầy-đủ-theo-docs-và-core)
- [7. Custom metrics trong script](#7-custom-metrics-trong-script)
- [8. Tags, submetrics, thresholds](#8-tags-submetrics-thresholds)
- [9. Các nhầm lẫn hay gặp](#9-các-nhầm-lẫn-hay-gặp)
- [10. Checklist đọc output](#10-checklist-đọc-output)
- [References](#references)

## 1. Metric là gì?

`Metric` là một đại lượng đo.

Nói đời thường:

```text
metric = thứ k6 ghi nhận trong lúc test chạy
```

Ví dụ:

```text
iterations
  = đã chạy xong bao nhiêu iteration

http_reqs
  = đã gửi bao nhiêu HTTP request

http_req_duration
  = mỗi request mất bao lâu

http_req_failed
  = tỉ lệ request bị xem là failed

vus
  = tại thời điểm đo, đang có bao nhiêu VU đang hoạt động
```

Điểm quan trọng: metric không phải lúc nào cũng là request.

Một test k6 có thể có nhiều loại thứ cần đo:

```text
execution metrics
  đo việc chạy script: iterations, iteration_duration, vus

HTTP metrics
  đo request HTTP: http_reqs, http_req_duration, http_req_failed

network metrics
  đo byte gửi/nhận: data_sent, data_received

protocol metrics
  WebSocket, gRPC, browser

custom metrics
  do chính bạn tự tạo trong script
```

## 2. Core nhìn metric như nào?

Trong core, một metric không chỉ có tên.
Nó có:

```text
Name      = tên metric, ví dụ "http_reqs"
Type      = loại metric, ví dụ Counter / Gauge / Trend / Rate
Contains  = kiểu giá trị, ví dụ default / time / data
Sink      = nơi gom các sample lại để tính summary/threshold
```

Code chính:

```text
metrics/metric.go
metrics/metric_type.go
metrics/value_type.go
metrics/sink.go
metrics/registry.go
metrics/sample.go
```

### 2.1 Metric không tự có số, nó nhận sample

Muốn hiểu metric trong k6, phải tách 2 lớp:

```text
Metric
  = định nghĩa đại lượng cần đo
  = tên gì, type gì, value type gì
  = ví dụ: http_reqs là Counter, http_req_duration là Trend

Sample
  = một lần ghi nhận giá trị cho metric đó
  = ví dụ: request này xong, ghi http_reqs value=1
```

Nói đời thường:

```text
metric giống cái cột trong bảng
sample giống một dòng dữ liệu được ghi vào cột đó tại một thời điểm
summary là kết quả đã gom rất nhiều dòng dữ liệu lại
```

Core định nghĩa `Sample` trong `metrics/sample.go`.

Đọc sát code:

```text
type Sample struct {
    TimeSeries
    Time
    Value
    Metadata
}
```

Hiểu ngắn:

```text
sample = một lần đo cụ thể, tại một thời điểm cụ thể, thuộc một metric cụ thể
```

Một sample có:

```text
Metric
  sample này thuộc metric nào

Value
  giá trị đo được

Time
  thời điểm đo

Tags
  nhãn để chia nhỏ dữ liệu, ví dụ status=200, method=GET, scenario=default

Metadata
  thông tin phụ, thường dành cho dữ liệu có số lượng giá trị lớn
```

Điểm dễ nhầm:

```text
sample không phải là dòng summary cuối test
sample không phải lúc nào cũng là "mỗi giây lấy một mẫu"
sample là mỗi lần k6 có một giá trị cần ghi
```

Ví dụ:

```text
1 HTTP request kết thúc
  -> sinh ra sample cho http_reqs
  -> sinh ra sample cho http_req_duration
  -> sinh ra sample cho http_req_waiting
  -> ...

1 iteration kết thúc
  -> sinh ra sample cho iterations
  -> sinh ra sample cho iteration_duration

customMetric.add(123)
  -> sinh ra 1 sample cho custom metric đó
```

#### 2.1.1 Một request có thể sinh nhiều sample

Trong `lib/netext/httpext/tracer.go`, khi một HTTP request kết thúc,
`Trail.SaveSamples()` append nhiều `metrics.Sample`.

Ví dụ cùng một request HTTP có thể sinh ra:

```text
http_reqs              value=1
http_req_duration      value=117.55
http_req_waiting       value=80.20
http_req_sending       value=0.50
http_req_receiving     value=36.85
http_req_failed        value=0 hoặc 1
```

Cùng một request nhưng sinh ra nhiều metric khác nhau.

Đọc từng dòng:

```text
http_reqs value=1
  = request này được tính là 1 request
  = vì http_reqs là Counter, sink sẽ cộng 1 vào tổng

http_req_duration value=117.55
  = request này mất khoảng 117.55ms
  = vì http_req_duration là Trend, sink sẽ đưa 117.55 vào tập duration

http_req_failed value=0 hoặc 1
  = request này failed hay không
  = vì http_req_failed là Rate, value khác 0 được tính là true/fail
```

Vậy một request không phải chỉ tăng mỗi `http_reqs`.
Nó là một event ở runtime, nhưng event đó tạo ra nhiều sample cho nhiều metric.

#### 2.1.2 Một sample đi qua sink như nào?

Luồng đơn giản:

```text
runtime có một giá trị cần ghi
  -> tạo Sample
  -> push vào output/sample channel
  -> metric sink nhận Sample
  -> sink gom theo type của metric
  -> cuối test summary format kết quả đã gom
```

Điểm quan trọng: cùng là `sample.Value`, nhưng type khác nhau thì cách hiểu khác nhau.

| Metric type | Sink làm gì với mỗi sample? | Ví dụ |
| --- | --- | --- |
| `Counter` | cộng `sample.Value` vào tổng | `http_reqs value=1`, `data_sent value=500` |
| `Gauge` | lấy `sample.Value` làm giá trị mới nhất, đồng thời nhớ min/max | `vus value=4`, `queue_depth value=9` |
| `Rate` | tăng `Total`, nếu `sample.Value != 0` thì tăng `Trues` | `checks value=1`, `http_req_failed value=0` |
| `Trend` | đưa `sample.Value` vào tập values để tính avg/min/max/p95 | `http_req_duration value=117.55` |

Ví dụ cùng một dãy value:

```text
samples: 1, 2, 3
```

Nếu metric là `Counter`:

```text
count = 1 + 2 + 3 = 6
```

Nếu metric là `Gauge`:

```text
value cuối = 3
min = 1
max = 3
```

Nếu metric là `Rate`:

```text
Total = 3
Trues = 3 vì cả 1, 2, 3 đều khác 0
rate = 3 / 3 = 100%
```

Nếu metric là `Trend`:

```text
values = [1, 2, 3]
avg = 2
min = 1
max = 3
med = 2
```

Vì vậy không thể chỉ nhìn `sample.Value` rồi kết luận ngay.
Phải hỏi thêm:

```text
sample này thuộc metric nào?
metric đó có type gì?
sink của type đó gom value như nào?
```

#### 2.1.3 Custom metric `.add()` tạo sample ra sao?

Với custom metric, mỗi lần gọi `.add()` là một lần k6 tạo sample cho metric đó.

Ví dụ:

```js
import { Counter, Gauge, Trend, Rate } from "k6/metrics";

const orders = new Counter("orders");
const queueDepth = new Gauge("queue_depth");
const checkoutDuration = new Trend("checkout_duration", true);
const checkoutOk = new Rate("checkout_ok");

export default function () {
  orders.add(1, { flow: "checkout" });
  queueDepth.add(5, { flow: "checkout" });
  checkoutDuration.add(250, { flow: "checkout" });
  checkoutOk.add(true, { flow: "checkout" });
}
```

Bốn dòng `.add()` ở trên tạo bốn sample khác nhau:

```text
orders
  Metric = orders
  Type   = Counter
  Value  = 1
  Tags   = flow=checkout

queue_depth
  Metric = queue_depth
  Type   = Gauge
  Value  = 5
  Tags   = flow=checkout

checkout_duration
  Metric = checkout_duration
  Type   = Trend
  Value  = 250
  Tags   = flow=checkout

checkout_ok
  Metric = checkout_ok
  Type   = Rate
  Value  = 1
  Tags   = flow=checkout
```

Trong core custom metrics, `.add(value, tags)` tạo `metrics.Sample` có:

```text
Metric = metric custom đang gọi add
Tags = current tags + tags truyền vào add()
Time = time.Now()
Value = value đã convert sang float
Metadata = metadata hiện tại nếu có
```

Nói ngắn hơn:

```text
gọi .add() 1 lần
  -> tạo 1 sample
  -> sample đó sẽ được sink của metric type đó gom theo kiểu riêng của nó
```

Với `Rate`, nếu bạn truyền boolean:

```text
true  -> value = 1
false -> value = 0
```

Nên:

```js
checkoutOk.add(true);
checkoutOk.add(false);
checkoutOk.add(true);
```

tạo logic:

```text
Total = 3
Trues = 2
rate = 2 / 3 = 66.67%
```

`Gauge` cũng cùng một model sample đó, nhưng sink của nó không cộng dồn:

```js
queueDepth.add(5);
queueDepth.add(9);
queueDepth.add(3);
```

Tạo các sample:

```text
queue_depth sample 1: value = 5
queue_depth sample 2: value = 9
queue_depth sample 3: value = 3
```

Rồi summary đọc ra:

```text
value = 3
min = 3
max = 9
```

Lưu ý thêm:

```text
custom metric dùng .add()
built-in metric như http_reqs, http_req_duration, iterations... cũng dùng cùng model Sample
chỉ khác là built-in sample do core tự sinh ra thay vì do script gọi .add()
```

#### 2.1.4 Tags làm sample bị tách thành nhiều chuỗi dữ liệu

Hai sample có cùng metric name nhưng khác tags thì không còn là cùng một chuỗi dữ liệu.

Ví dụ:

```text
http_req_duration{status:200} value=100
http_req_duration{status:500} value=900
```

Cả hai đều thuộc metric `http_req_duration`, nhưng tags khác nhau:

```text
status=200
status=500
```

Trong code JS, tags thường là một object kiểu:

```js
{ status: "200", method: "GET" }
```

Nó là object nhãn của sample, không phải object theo tên metric.
Metric name vẫn là phần riêng, ví dụ `http_req_duration`.

Nên khi viết threshold theo tag:

```js
export const options = {
  thresholds: {
    "http_req_duration{status:200}": ["p(95)<300"],
  },
};
```

k6 chỉ xét các sample có tag `status=200`, không xét sample `status=500`.

Đây là lý do phần sau cần học `TimeSeries = Metric + Tags`.

#### 2.1.5 Ví dụ từ sample thô ra summary

Giả sử script chỉ chạy đúng 1 iteration và có custom metrics như sau:

```js
import { Counter, Gauge, Rate, Trend } from "k6/metrics";

const orders = new Counter("orders");
const queueDepth = new Gauge("queue_depth");
const checkoutOk = new Rate("checkout_ok");
const checkoutDuration = new Trend("checkout_duration", true);

export default function () {
  orders.add(1);
  orders.add(2);

  queueDepth.add(5);
  queueDepth.add(9);
  queueDepth.add(3);

  checkoutOk.add(true);
  checkoutOk.add(false);

  checkoutDuration.add(100);
  checkoutDuration.add(300);
}
```

Nếu bỏ qua tags để nhìn đơn giản, runtime đã tạo các sample như sau:

```text
orders              value=1
orders              value=2
queue_depth         value=5
queue_depth         value=9
queue_depth         value=3
checkout_ok         value=1
checkout_ok         value=0
checkout_duration   value=100
checkout_duration   value=300
```

k6 không in từng sample này trong summary mặc định.
k6 gom chúng qua sink rồi mới in kết quả cuối.

Submetric là metric đã được tách theo một bộ tags cố định.

Ví dụ:

```text
http_req_duration{status:200}
  = submetric của http_req_duration
  = chỉ xét sample có status=200

http_req_duration{status:500}
  = submetric khác của cùng metric http_req_duration
  = chỉ xét sample có status=500
```

Với `orders`:

```text
type = Counter
sample values = [1, 2]
count = 1 + 2 = 3
```

Summary sẽ có dạng:

```text
orders................: 3    .../s
```

Với `queue_depth`:

```text
type = Gauge
sample values = [5, 9, 3]
value cuối = 3
min = 3
max = 9
```

Summary sẽ có dạng:

```text
queue_depth..........: 3    min=3 max=9
```

Với `checkout_ok`:

```text
type = Rate
sample values = [1, 0]
Total = 2
Trues = 1
rate = 1 / 2 = 50%
```

Summary sẽ có dạng:

```text
checkout_ok...........: 50.00% 1 out of 2
```

Với `checkout_duration`:

```text
type = Trend
sample values = [100, 300]
avg = (100 + 300) / 2 = 200ms
min = 100ms
max = 300ms
med = 200ms
```

Summary sẽ có dạng:

```text
checkout_duration.....: avg=200ms min=100ms med=200ms max=300ms ...
```

Nếu đổi qua built-in metric thì cách đọc vẫn y hệt:

```text
http_reqs
  = Counter, cộng dồn số request sample

vus
  = Gauge, lấy value hiện tại và nhớ min/max

http_req_failed
  = Rate, true/false trên tổng sample

http_req_duration
  = Trend, giữ nhiều value để tính avg/min/max/p95
```

Điểm cần nhớ:

```text
sample là dữ liệu thô lúc runtime ghi nhận
summary là dữ liệu đã được sink gom lại
```

Note nhanh:

```text
1 dòng summary = 1 metric hoặc 1 submetric của metric đó
1 dòng summary không phải 1 sample
1 metric name có thể sinh nhiều dòng summary nếu có tags khác nhau
```

Ví dụ:

```text
http_req_duration{status:200}  -> 1 dòng summary
http_req_duration{status:500}  -> 1 dòng summary khác
```

Vì vậy khi đọc summary, đừng tưởng dòng summary là một sample.
Nó thường là kết quả của rất nhiều sample đã được sink gom lại.

#### 2.1.6 Checklist đọc sample cho đúng

Khi thấy một dòng metric hoặc khi tự viết custom metric, đọc theo thứ tự này:

```text
1. Metric name là gì?
   ví dụ http_reqs, http_req_duration, checkout_ok

2. Type là gì?
   Counter, Gauge, Rate, hay Trend

3. sample.Value nghĩa là gì?
   1 request, số ms, true/false, số byte, queue depth...

4. sample này sinh ra khi nào?
   request kết thúc, iteration kết thúc, hay lúc mình gọi .add()

5. Tags là gì?
   status, method, url, scenario, group, custom tag...

6. Sink sẽ gom nó ra sao?
   cộng dồn, lấy value cuối, tính true/total, hay đưa vào tập duration
```

### 2.2 TimeSeries là gì?

Trong `metrics/sample.go`, `TimeSeries` được hiểu là:

```text
Metric + Tags
```

Ví dụ:

```text
http_req_duration{status:200,method:GET}
http_req_duration{status:500,method:GET}
```

Hai dòng này cùng là metric `http_req_duration`, nhưng khác tags nên là hai chuỗi dữ liệu khác nhau.

Nói đơn giản:

```text
cùng metric name
nhưng tags khác nhau
thì k6 có thể tách riêng khi lọc, threshold, output
```

### 2.3 Sink là gì?

`Sink` là phần gom nhiều sample lại để tính kết quả.

Trong `metrics/sink.go`, k6 có 4 sink chính:

```text
CounterSink
GaugeSink
TrendSink
RateSink
```

Tên metric quyết định bạn thấy dòng gì trong output.
Type của metric quyết định k6 gom số kiểu gì.

Ví dụ:

```text
http_reqs là Counter
  -> dùng CounterSink
  -> cộng dồn sample
  -> summary có count và rate mỗi giây

http_req_duration là Trend
  -> dùng TrendSink
  -> lưu nhiều giá trị thời gian
  -> summary có avg, min, med, max, p(90), p(95)
```

## 3. Bốn loại metric trong k6

Theo official docs và core `metrics/metric_type.go`, k6 có 4 loại metric:

| Loại | Dịch dễ hiểu | Dùng để đo gì? | Ví dụ |
| --- | --- | --- | --- |
| `Counter` | bộ đếm cộng dồn | số lần xảy ra, số byte | `iterations`, `http_reqs`, `data_sent` |
| `Gauge` | giá trị hiện tại | số đang có tại một thời điểm | `vus`, `vus_max` |
| `Rate` | tỉ lệ đúng trên tổng | pass/fail, true/false | `checks`, `http_req_failed` |
| `Trend` | tập nhiều giá trị để tính thống kê | duration, latency, phân phối giá trị | `http_req_duration`, `iteration_duration` |

Trong core:

```go
const (
    Counter = MetricType(iota) // A counter that sums its data points
    Gauge                      // A gauge that displays the latest value
    Trend                      // A trend, min/max/avg/med are interesting
    Rate                       // A rate, displays % of values that aren't 0
)
```

Đọc bằng tiếng Việt:

```text
Counter
  cộng các sample lại

Gauge
  giữ giá trị mới nhất, đồng thời nhớ min/max

Trend
  giữ nhiều giá trị để tính avg/min/max/median/percentile

Rate
  đếm bao nhiêu sample khác 0 trên tổng số sample
```

## 4. Cách đọc từng loại metric

Mục này cố ý đặt demo ngay bên trong từng type.
Nghĩa là học `Counter` thì có script `Counter` ngay dưới đó, học `Gauge` thì có script
`Gauge` ngay dưới đó.
Đừng đợi tới cuối bài mới xem ví dụ, vì mỗi type có cách cộng sample khác nhau.

### 4.1 `Counter`

`Counter` dùng khi bạn muốn đếm tổng.

Ví dụ:

```text
iterations.........: 13    1.729617/s
http_reqs..........: 26    3.459234/s
data_sent..........: 8.4 kB 1.1 kB/s
```

Với `Counter`, core làm việc này:

```go
func (c *CounterSink) Add(s Sample) {
    c.Value += s.Value
}
```

Tức là:

```text
mỗi sample đến
  -> lấy sample.Value
  -> cộng vào tổng hiện tại
```

Với `iterations` và `http_reqs`, mỗi event thường add `1`.

Ví dụ:

```text
iteration xong 1 lần
  -> iterations.add(1)

request HTTP xong 1 lần
  -> http_reqs.add(1)
```

Nhưng `Counter` không bắt buộc lúc nào cũng cộng 1.
Với `data_sent` và `data_received`, sample value là số byte.

Ví dụ:

```text
request A gửi 500 bytes
request B gửi 700 bytes

data_sent = 500 + 700 = 1200 bytes
```

#### `Counter` in ra gì?

Trong `CounterSink.Format()`:

```go
return map[string]float64{
    "count": c.Value,
    "rate":  c.Rate(t),
}
```

Công thức:

```text
count = tổng cộng dồn
rate  = count / duration_seconds
```

Ví dụ:

```text
iterations.........: 13    1.729617/s
```

Đọc là:

```text
tổng cộng có 13 iteration hoàn thành
tính trung bình trên toàn thời gian chạy thì khoảng 1.729617 iteration mỗi giây
```

Không đọc thành:

```text
mỗi giây luôn đúng 1.729617 iteration
```

Đây là trung bình trên cả run.

Ví dụ suy ngược:

```text
summary_runtime_base ~= count / rate
                     ~= 13 / 1.729617
                     ~= 7.52s
```

`summary_runtime_base` ở đây là:

```text
khoảng thời gian mà Counter summary dùng làm mẫu số cho cột /s
```

Nó thường gần với thời gian bạn nhìn thấy ở demo đơn giản một scenario, `startTime=0`,
không `setup()`/`teardown()`.

Nhưng về nghĩa chính xác thì phải đọc là:

```text
đây là mẫu số của Counter summary
không phải lúc nào cũng là "runtime thật của riêng scenario"
```

#### Demo `Counter` ngay tại đây

Script nhỏ:

```js
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    demo_counter: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
};

const demoOrders = new Counter("demo_orders");

export default function () {
  demoOrders.add(1);
  demoOrders.add(2);
}
```

Output cuối test sẽ có hình dạng tương tự:

```text
demo_orders.............: 3      123.456/s
```

Số `/s` có thể khác trên máy bạn vì test chạy rất nhanh.
Trong demo này, điểm cần đọc trước là:

```text
demo_orders = 3
```

Cắt nghĩa từng dòng:

```js
demoOrders.add(1);
demoOrders.add(2);
```

Nghĩa là ta đẩy 2 sample vào metric `demo_orders`:

```text
sample 1: value = 1
sample 2: value = 2
```

Core dùng `CounterSink`.
Logic chính:

```go
c.Value += s.Value
```

Diễn biến:

```text
ban đầu:
  Value = 0

sau demoOrders.add(1):
  Value = 0 + 1 = 1

sau demoOrders.add(2):
  Value = 1 + 2 = 3
```

Vì vậy summary in:

```text
demo_orders: 3 ...
```

Đọc đúng:

```text
trong toàn bộ test, demo_orders được cộng tổng cộng 3 đơn vị
```

Nếu đây là business metric:

```text
demo_orders = 3
```

có thể hiểu là:

```text
test đã ghi nhận tổng cộng 3 order
```

Nhưng phải nhớ:

```text
Counter cộng theo value bạn add
```

Nếu bạn viết:

```js
demoOrders.add(10);
```

thì counter tăng 10, không phải tăng 1.

Đối chiếu built-in:

```text
http_reqs
  thường mỗi request add 1

iterations
  thường mỗi iteration hoàn thành add 1

data_sent
  mỗi sample add số byte gửi đi
```

Vậy `Counter` không có nghĩa là "cứ event là cộng 1".
Nó có nghĩa là:

```text
tổng = tổng tất cả sample.Value
```

#### Khi nào dùng `Counter` custom?

Dùng khi câu hỏi của bạn là:

```text
đã xảy ra bao nhiêu lần?
đã gửi/nhận tổng cộng bao nhiêu?
trung bình mỗi giây xảy ra bao nhiêu?
```

Ví dụ business:

```text
orders_created
login_attempts
checkout_started
payment_api_calls
```

### 4.2 `Gauge`

`Gauge` dùng cho giá trị có thể tăng hoặc giảm.

Ví dụ:

```text
vus................: 4    min=1   max=4
vus_max............: 6    min=6   max=6
```

Với `Gauge`, core làm việc này:

```go
func (g *GaugeSink) Add(s Sample) {
    g.Value = s.Value
    if s.Value > g.Max {
        g.Max = s.Value
    }
    if s.Value < g.Min || !g.minSet {
        g.Min = s.Value
        g.minSet = true
    }
}
```

Đọc bằng tiếng Việt:

```text
Value = giá trị mới nhất
Min   = giá trị nhỏ nhất từng thấy
Max   = giá trị lớn nhất từng thấy
```

Khác với `Counter`, `Gauge` không cộng dồn.

Ví dụ queue length:

```text
t=1s: queue_depth = 5
t=2s: queue_depth = 9
t=3s: queue_depth = 3
```

Kết quả:

```text
value = 3
min   = 3
max   = 9
```

Không phải:

```text
5 + 9 + 3 = 17
```

#### Demo `Gauge` ngay tại đây

Script nhỏ:

```js
import { Gauge } from "k6/metrics";

export const options = {
  scenarios: {
    demo_gauge: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
};

const demoQueueDepth = new Gauge("demo_queue_depth");

export default function () {
  demoQueueDepth.add(5);
  demoQueueDepth.add(9);
  demoQueueDepth.add(3);
}
```

Output cuối test sẽ có hình dạng tương tự:

```text
demo_queue_depth........: 3      min=3      max=9
```

Cắt nghĩa từng dòng:

```js
demoQueueDepth.add(5);
demoQueueDepth.add(9);
demoQueueDepth.add(3);
```

Ta đang mô phỏng queue thay đổi theo thời gian:

```text
lần đo 1: queue đang có 5 item
lần đo 2: queue đang có 9 item
lần đo 3: queue đang có 3 item
```

Core dùng `GaugeSink`.
Logic chính:

```go
g.Value = s.Value
if s.Value > g.Max {
    g.Max = s.Value
}
if s.Value < g.Min || !g.minSet {
    g.Min = s.Value
    g.minSet = true
}
```

Diễn biến:

```text
ban đầu:
  chưa có value
  min chưa set
  max = 0

sau add(5):
  value = 5
  min   = 5
  max   = 5

sau add(9):
  value = 9
  min   = 5
  max   = 9

sau add(3):
  value = 3
  min   = 3
  max   = 9
```

Vì vậy summary in:

```text
demo_queue_depth: 3 min=3 max=9
```

Đọc đúng:

```text
giá trị cuối cùng đo được là 3
trong cả test, nhỏ nhất từng thấy là 3
trong cả test, lớn nhất từng thấy là 9
```

Không đọc thành:

```text
5 + 9 + 3 = 17
```

Đó là cách đọc sai vì `Gauge` không cộng dồn.

#### Vì sao `vus` là Gauge?

`vus` là số VU đang hoạt động tại thời điểm đo.

Nó có thể:

```text
tăng khi k6 dùng thêm VU
giảm khi scenario giảm VU hoặc kết thúc
```

Nên nó là `Gauge`, không phải `Counter`.

Nếu `vus` là `Counter` thì mỗi lần tăng/giảm sẽ bị cộng dồn và không còn nghĩa là "đang có bao nhiêu VU".

#### Khi nào dùng `Gauge` custom?

Dùng khi câu hỏi là:

```text
hiện tại đang là bao nhiêu?
giá trị này có thể tăng rồi giảm không?
ta cần biết min/max trong quá trình test không?
```

Ví dụ:

```text
queue_depth
cache_items
open_connections
remaining_stock
```

### 4.3 `Rate`

`Rate` trong k6 rất dễ bị hiểu nhầm.

`Rate` ở đây không phải là "mỗi giây bao nhiêu request".
Nó là:

```text
tỉ lệ sample có value khác 0 trên tổng số sample
```

Core làm việc này:

```go
func (r *RateSink) Add(s Sample) {
    r.Total++
    if s.Value != 0 {
        r.Trues++
    }
}
```

Công thức:

```text
rate = Trues / Total
```

Ví dụ:

```text
samples = [1, 1, 0, 1, 0]

Total = 5
Trues = 3
rate  = 3 / 5 = 0.6 = 60%
```

Trong summary, `Rate` thường in dạng phần trăm:

```text
http_req_failed.....: 1.25%  5 out of 400
checks..............: 98.00% 490 out of 500
```

Đọc là:

```text
http_req_failed = trong 400 request, có 5 request bị xem là failed
checks          = trong 500 check, có 490 check pass
```

#### Demo `Rate` ngay tại đây

Script nhỏ:

```js
import { Rate } from "k6/metrics";

export const options = {
  scenarios: {
    demo_rate: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
};

const demoCheckoutOk = new Rate("demo_checkout_ok");

export default function () {
  demoCheckoutOk.add(true);
  demoCheckoutOk.add(false);
  demoCheckoutOk.add(true);
}
```

Output cuối test sẽ có hình dạng tương tự:

```text
demo_checkout_ok........: 66.67% 2 out of 3
```

Cắt nghĩa từng dòng:

```js
demoCheckoutOk.add(true);
demoCheckoutOk.add(false);
demoCheckoutOk.add(true);
```

Core custom metric đổi boolean như sau:

```text
true  -> 1
false -> 0
```

Nên 3 sample thật sự là:

```text
sample 1: value = 1
sample 2: value = 0
sample 3: value = 1
```

Core dùng `RateSink`.
Logic chính:

```go
r.Total++
if s.Value != 0 {
    r.Trues++
}
```

Diễn biến:

```text
ban đầu:
  Total = 0
  Trues = 0

sau add(true):
  sample.Value = 1
  Total = 1
  Trues = 1

sau add(false):
  sample.Value = 0
  Total = 2
  Trues = 1

sau add(true):
  sample.Value = 1
  Total = 3
  Trues = 2
```

Công thức:

```text
rate = Trues / Total
     = 2 / 3
     = 0.666666...
     = 66.67%
```

Vì vậy summary in:

```text
demo_checkout_ok: 66.67% 2 out of 3
```

Đọc đúng:

```text
có 3 lần đo checkout_ok
trong đó 2 lần là true
tỉ lệ true là 66.67%
```

Không đọc thành:

```text
66.67 request mỗi giây
```

Sai, vì đây là `Rate` metric.

Đối chiếu built-in:

```text
checks
  Rate của các check pass

http_req_failed
  Rate của request bị xem là failed
```

Ví dụ:

```text
http_req_failed: 2.00% 10 out of 500
```

Đọc là:

```text
500 request được xét
10 request failed
tỉ lệ failed là 2%
```

Không phải:

```text
2 request/s
```

#### `Rate` khác `Counter rate` như nào?

Đây là điểm rất quan trọng.

Từ `rate` xuất hiện ở 2 nơi:

| Chỗ xuất hiện | Nghĩa |
| --- | --- |
| `Counter` có field `rate` | tốc độ trung bình mỗi giây, ví dụ `http_reqs/s` |
| `Rate` metric | tỉ lệ đúng/sai, ví dụ `http_req_failed=1.25%` |

Ví dụ:

```text
http_reqs..........: 400    80/s
http_req_failed....: 1.25%  5 out of 400
```

Đọc đúng:

```text
http_reqs 80/s
  = trung bình 80 request mỗi giây

http_req_failed 1.25%
  = 1.25% request bị failed
```

Không đọc:

```text
http_req_failed 1.25% = 1.25 request/s
```

Sai.

#### Khi nào dùng `Rate` custom?

Dùng khi bạn muốn đo pass/fail:

```text
checkout_ok
payment_success
search_has_result
response_has_expected_field
```

Ví dụ:

```js
import { Rate } from "k6/metrics";

const checkoutOk = new Rate("checkout_ok");

export default function () {
  checkoutOk.add(true);  // pass
  checkoutOk.add(false); // fail
}
```

Trong core custom metric, boolean sẽ được đổi thành số:

```text
true  -> 1
false -> 0
```

### 4.4 `Trend`

`Trend` dùng cho một tập nhiều giá trị.

Nó trả lời kiểu câu hỏi:

```text
nhanh nhất là bao nhiêu?
chậm nhất là bao nhiêu?
trung bình là bao nhiêu?
giá trị giữa là bao nhiêu?
p95 là bao nhiêu?
```

Ví dụ:

```text
http_req_duration.....: avg=117.55ms min=50ms med=100ms max=400ms p(90)=250ms p(95)=300ms
iteration_duration....: avg=1.76s    min=1.51s med=1.52s max=2.09s p(90)=2.05s p(95)=2.07s
```

Core `TrendSink.Add()` làm việc này:

```go
t.values = append(t.values, s.Value)
t.count++
t.sum += s.Value
```

Nó giữ nhiều giá trị, rồi tính:

```text
avg = sum / count
min = nhỏ nhất
max = lớn nhất
med = percentile 50
p(90), p(95) = percentile 90, percentile 95
```

#### Demo `Trend` ngay tại đây

Script nhỏ:

```js
import { Trend } from "k6/metrics";

export const options = {
  scenarios: {
    demo_trend: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)"],
};

const demoLatency = new Trend("demo_latency", true);

export default function () {
  demoLatency.add(100);
  demoLatency.add(200);
  demoLatency.add(300);
  demoLatency.add(400);
}
```

Output cuối test sẽ có hình dạng tương tự:

```text
demo_latency............: avg=250ms min=100ms med=250ms max=400ms p(90)=370ms p(95)=385ms
```

Cắt nghĩa từng dòng:

```js
demoLatency.add(100);
demoLatency.add(200);
demoLatency.add(300);
demoLatency.add(400);
```

Ta tạo 4 sample:

```text
100ms
200ms
300ms
400ms
```

Vì constructor viết:

```js
new Trend("demo_latency", true)
```

nên metric này có `Contains = Time`.
Các số `100`, `200`, `300`, `400` được hiểu là milliseconds trong output.

Core dùng `TrendSink`.
Logic chính:

```go
t.values = append(t.values, s.Value)
t.count++
t.sum += s.Value
```

Sau 4 lần add:

```text
values = [100, 200, 300, 400]
count  = 4
sum    = 100 + 200 + 300 + 400 = 1000
min    = 100
max    = 400
```

Tính `avg`:

```text
avg = sum / count
    = 1000 / 4
    = 250ms
```

Tính `med`:

```text
med = percentile 50
```

Với 4 giá trị:

```text
[100, 200, 300, 400]
```

điểm giữa nằm giữa `200` và `300`, nên:

```text
med = 250ms
```

Core tính percentile trong `TrendSink.P()` bằng nội suy tuyến tính.
Với `p(90)`:

```text
count = 4
pct   = 0.90

i = pct * (count - 1)
  = 0.90 * 3
  = 2.7
```

Index 2 là `300`, index 3 là `400`.
Vì `i = 2.7`, nó nằm 70% đường từ `300` tới `400`:

```text
p(90) = 300 + (400 - 300) * 0.7
      = 370ms
```

Với `p(95)`:

```text
i = 0.95 * 3
  = 2.85

p(95) = 300 + (400 - 300) * 0.85
      = 385ms
```

Vì vậy summary in:

```text
demo_latency: avg=250ms min=100ms med=250ms max=400ms p(90)=370ms p(95)=385ms
```

Đọc đúng:

```text
trung bình latency là 250ms
nhanh nhất là 100ms
chậm nhất là 400ms
giá trị giữa là 250ms
90% sample nhỏ hơn hoặc bằng khoảng 370ms
95% sample nhỏ hơn hoặc bằng khoảng 385ms
```

Không đọc:

```text
p(95)=385ms nghĩa là 95% pass
```

Sai.
`p(95)` chỉ nói vị trí trong tập giá trị latency.
Pass hay fail phải dùng `Rate` hoặc threshold.

Đối chiếu built-in:

```text
http_req_duration
  Trend thời gian request HTTP

iteration_duration
  Trend thời gian một iteration

group_duration
  Trend thời gian một group

grpc_req_duration
  Trend thời gian request gRPC
```

#### `p(95)` là gì?

`p(95)` nghĩa là percentile 95.

Đọc dễ hiểu:

```text
95% sample có giá trị <= p(95)
5% sample còn lại có thể lớn hơn p(95)
```

Ví dụ có 100 request:

```text
http_req_duration p(95)=300ms
```

Đọc là:

```text
khoảng 95 request nhanh hơn hoặc bằng 300ms
khoảng 5 request chậm hơn 300ms
```

Không đọc thành:

```text
95% request pass
```

`p(95)` không phải tỉ lệ pass/fail. Nó là vị trí trong phân phối thời gian.

#### `avg` có đủ không?

Không nên chỉ nhìn `avg`.

Ví dụ 10 request:

```text
9 request mất 100ms
1 request mất 5000ms
```

`avg` có thể bị kéo lên bởi request rất chậm.
`p(95)` hoặc `max` giúp thấy đuôi chậm.

Với performance test, thường nhìn:

```text
http_reqs
http_req_failed
http_req_duration p(95)
```

Tức là:

```text
traffic
error rate
latency
```

#### Trend columns lấy từ đâu?

Trong `metrics/sample.go`, core hỗ trợ các trend stat:

```text
avg
min
med
max
count
p(x)
```

Ví dụ:

```text
p(90)
p(95)
p(99)
```

Trong summary mặc định, bạn thường thấy:

```text
avg min med max p(90) p(95)
```

Nếu config `summaryTrendStats`, k6 sẽ dùng danh sách bạn chọn.

### 4.5 Tổng hợp: chọn type theo câu hỏi

Khi viết script thật, đừng chọn metric type theo cảm giác.
Hãy bắt đầu từ câu hỏi bạn muốn trả lời.

| Câu hỏi | Nên dùng | Vì sao |
| --- | --- | --- |
| Tổng cộng tạo bao nhiêu order? | `Counter` | cần cộng dồn |
| Trung bình mỗi giây có bao nhiêu order? | `Counter` | summary có `rate = count / duration` |
| Hiện tại queue đang dài bao nhiêu? | `Gauge` | cần giá trị mới nhất, có thể tăng/giảm |
| Checkout thành công bao nhiêu phần trăm? | `Rate` | cần true/total |
| API checkout chậm như nào? | `Trend` | cần avg/p95/max |

Ví dụ một flow checkout:

```js
import http from "k6/http";
import { Counter, Gauge, Rate, Trend } from "k6/metrics";

const checkoutStarted = new Counter("checkout_started");
const cartItems = new Gauge("cart_items");
const checkoutOk = new Rate("checkout_ok");
const checkoutDuration = new Trend("checkout_duration", true);

export default function () {
  checkoutStarted.add(1);
  cartItems.add(3);

  const start = Date.now();
  const res = http.get("https://quickpizza.grafana.com");
  const duration = Date.now() - start;

  checkoutOk.add(res.status >= 200 && res.status < 400);
  checkoutDuration.add(duration);
}
```

Cắt nghĩa:

```text
checkoutStarted
  dùng Counter vì mỗi lần bắt đầu checkout thì cộng tổng lên

cartItems
  dùng Gauge vì tại thời điểm đó giỏ hàng có bao nhiêu item

checkoutOk
  dùng Rate vì kết quả chỉ là thành công/thất bại

checkoutDuration
  dùng Trend vì mỗi lần checkout có một duration,
  ta cần avg, p95, max để biết độ chậm
```

Nếu output là:

```text
checkout_started........: 1000   50/s
cart_items..............: 3      min=1 max=8
checkout_ok.............: 99.20% 992 out of 1000
checkout_duration.......: avg=180ms min=80ms med=150ms max=1200ms p(90)=260ms p(95)=400ms
```

Đọc thành câu đời thường:

```text
test đã bắt đầu checkout 1000 lần
tốc độ trung bình là 50 checkout/s
giỏ hàng cuối cùng có 3 item, nhỏ nhất từng thấy là 1, lớn nhất từng thấy là 8
992/1000 checkout thành công, tức 99.20%
95% checkout hoàn thành trong khoảng 400ms hoặc nhanh hơn
có ít nhất một checkout chậm tới 1200ms
```

## 5. Value type: default, time, data

Ngoài `MetricType`, core còn có `ValueType` trong `metrics/value_type.go`.

Có 3 loại:

| Value type | Dịch dễ hiểu | Ví dụ |
| --- | --- | --- |
| `Default` | số bình thường | `checks`, `http_req_failed`, `browser_web_vital_cls` |
| `Time` | thời gian, core lưu theo milliseconds | `http_req_duration`, `iteration_duration` |
| `Data` | dung lượng bytes | `data_sent`, `data_received` |

Core helper:

```go
const timeUnit = time.Millisecond

func D(d time.Duration) float64 {
    return float64(d) / float64(timeUnit)
}
```

Nghĩa là các duration trong core được emit ra dưới dạng milliseconds.

Ví dụ:

```text
time.Duration = 250ms
metrics.D(...) = 250
```

Sau đó summary/output có thể format lại thành:

```text
250ms
1.76s
```

Với `Data`, core cộng bytes.
Summary có thể format ra:

```text
541 B
6.8 kB
1.5 kB/s
```

## 6. Built-in metrics đầy đủ theo docs và core

Official docs chia built-in metrics theo protocol:

```text
standard
HTTP
browser
WebSocket
gRPC
```

Core thì nằm ở nhiều nơi:

```text
metrics/builtin.go
  standard, HTTP, WebSocket, grpc_req_duration, network

internal/js/modules/k6/browser/k6ext/metrics.go
  browser metrics và web vitals

internal/js/modules/k6/grpc/metrics.go
  grpc_streams, grpc_streams_msgs_sent, grpc_streams_msgs_received
```

Vì vậy khi đối chiếu code, đừng chỉ nhìn mỗi `metrics/builtin.go`.

### 6.1 Standard metrics

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `iterations` | `Counter` | `Default` | tổng số lần VU chạy xong function của scenario, thường là `default()` |
| `iteration_duration` | `Trend` | `Time` | thời gian hoàn thành một iteration |
| `dropped_iterations` | `Counter` | `Default` | số iteration không khởi động được do thiếu VU ở arrival-rate executor hoặc hết thời gian ở iteration-based executor |
| `vus` | `Gauge` | `Default` | số VU đang hoạt động hiện tại |
| `vus_max` | `Gauge` | `Default` | số VU tối đa k6 có thể dùng theo allocation |
| `checks` | `Rate` | `Default` | tỉ lệ check pass |
| `group_duration` | `Trend` | `Time` | thời gian chạy một `group()` |
| `data_sent` | `Counter` | `Data` | tổng bytes gửi đi |
| `data_received` | `Counter` | `Data` | tổng bytes nhận về |

Ghi chú về `checks`:

```text
core metric thật là checks, type Rate
summary có thể hiển thị checks_total / checks_succeeded / checks_failed
những dòng hiển thị phụ đó không phải metric độc lập để threshold
```

Ghi chú về `group_duration`:

```text
core có metric group_duration trong metrics/builtin.go
summary mặc định có thể không hiện dòng này nếu không có group hoặc bị skip trong cách render summary
```

Nói rõ hơn: `group_duration` vẫn là metric thật trong registry.
Nhưng phần dựng summary cuối test có logic riêng trong `internal/output/summary/data.go`,
nên không phải cứ có metric trong core là bạn luôn thấy một dòng tổng giống `http_req_duration`.

### 6.2 HTTP metrics

Các metric này sinh ra khi script dùng HTTP API.

Core chính:

```text
metrics/builtin.go
lib/netext/httpext/tracer.go
js/modules/k6/http/response_callback_test.go
```

Trong `lib/netext/httpext/tracer.go`, một request HTTP kết thúc thì `Trail.SaveSamples()` append các sample:

```text
http_reqs
http_req_duration
http_req_blocked
http_req_connecting
http_req_tls_handshaking
http_req_sending
http_req_waiting
http_req_receiving
```

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `http_reqs` | `Counter` | `Default` | tổng số HTTP request k6 tạo ra |
| `http_req_failed` | `Rate` | `Default` | tỉ lệ request bị xem là lỗi theo `setResponseCallback` |
| `http_req_duration` | `Trend` | `Time` | tổng thời gian request, bằng `sending + waiting + receiving`, không gồm DNS/connect/TLS |
| `http_req_blocked` | `Trend` | `Time` | thời gian bị chặn trước khi request bắt đầu, ví dụ chờ một chỗ kết nối TCP rảnh |
| `http_req_connecting` | `Trend` | `Time` | thời gian tạo kết nối TCP |
| `http_req_tls_handshaking` | `Trend` | `Time` | thời gian bắt tay TLS |
| `http_req_sending` | `Trend` | `Time` | thời gian gửi dữ liệu request |
| `http_req_waiting` | `Trend` | `Time` | thời gian chờ byte đầu tiên từ server, thường gọi là TTFB |
| `http_req_receiving` | `Trend` | `Time` | thời gian nhận nội dung response |

Một request có thể hiểu theo timeline:

```text
blocked
  -> connecting
  -> tls_handshaking
  -> sending
  -> waiting
  -> receiving
```

Riêng:

```text
http_req_duration = sending + waiting + receiving
```

Vì vậy nếu muốn đo "server xử lý và trả response mất bao lâu" thì thường nhìn:

```text
http_req_duration
http_req_waiting
```

Nếu muốn xem tắc ở khâu chuẩn bị kết nối mạng thì nhìn thêm:

```text
http_req_blocked
http_req_connecting
http_req_tls_handshaking
```

Ghi chú từ official docs:

```text
thời điểm ghi sample của http_req_* nằm ở cuối request
tức là khi k6 nhận xong nội dung response hoặc request hết thời gian chờ
```

### 6.3 Network metrics

Trong official docs, `data_sent` và `data_received` nằm trong standard built-in metrics.
Trong phần summary cuối test, k6 thường nhóm chúng vào mục `NETWORK`, nên bài này tách lại một mục riêng để dễ đọc output.

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `data_sent` | `Counter` | `Data` | tổng bytes gửi đi |
| `data_received` | `Counter` | `Data` | tổng bytes nhận về |

Hai metric này là `Counter`, nhưng không phải đếm số request.
Nó cộng byte.

Ví dụ:

```text
data_received....: 6.8 kB 19 kB/s
```

Đọc là:

```text
tổng cộng nhận 6.8 kB
trung bình khoảng 19 kB mỗi giây trong thời gian test
```

### 6.4 WebSocket metrics

Core chính:

```text
metrics/builtin.go
internal/js/modules/k6/ws/ws.go
internal/js/modules/k6/websockets/websockets.go
```

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `ws_sessions` | `Counter` | `Default` | tổng số phiên WebSocket đã bắt đầu |
| `ws_msgs_sent` | `Counter` | `Default` | tổng số message gửi đi |
| `ws_msgs_received` | `Counter` | `Default` | tổng số message nhận về |
| `ws_connecting` | `Trend` | `Time` | thời gian thiết lập kết nối WebSocket |
| `ws_session_duration` | `Trend` | `Time` | thời gian tồn tại của phiên WebSocket |
| `ws_ping` | `Trend` | `Time` | thời gian từ ping đến pong |

Ví dụ đọc:

```text
ws_msgs_sent
  = đã gửi bao nhiêu message

ws_ping p(95)
  = 95% lần ping-pong có thời gian nhỏ hơn hoặc bằng giá trị này
```

### 6.5 gRPC metrics

gRPC có 2 nhóm trong core:

```text
metrics/builtin.go
  grpc_req_duration

internal/js/modules/k6/grpc/metrics.go
  grpc_streams*
```

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `grpc_req_duration` | `Trend` | `Time` | thời gian nhận response từ máy chủ đích |
| `grpc_streams` | `Counter` | `Default` | tổng số stream đã bắt đầu |
| `grpc_streams_msgs_sent` | `Counter` | `Default` | tổng số stream message gửi đi |
| `grpc_streams_msgs_received` | `Counter` | `Default` | tổng số stream message nhận về |

Trong `internal/lib/netext/grpcext/conn.go`, khi RPC kết thúc, core push sample:

```text
grpc_req_duration = EndTime - BeginTime
```

### 6.6 Browser metrics

Official docs gọi đây là browser metrics.
Trong core, chúng được register trong:

```text
internal/js/modules/k6/browser/k6ext/metrics.go
```

Browser metrics không nằm trong `metrics/builtin.go`, nhưng khi dùng browser module thì k6 register chúng vào registry.

| Metric | Type trong core | Contains | Nghĩa |
| --- | --- | --- | --- |
| `browser_data_sent` | `Counter` | `Data` | bytes browser gửi đi |
| `browser_data_received` | `Counter` | `Data` | bytes browser nhận về |
| `browser_http_req_duration` | `Trend` | `Time` | thời gian của HTTP request do browser tạo |
| `browser_http_req_failed` | `Rate` | `Default` | tỉ lệ HTTP request của browser bị xem là lỗi |
| `browser_web_vital_ttfb` | `Trend` | `Time` | thời gian tới byte đầu tiên |
| `browser_web_vital_fcp` | `Trend` | `Time` | thời điểm browser render nội dung đầu tiên |
| `browser_web_vital_lcp` | `Trend` | `Time` | thời điểm phần tử nội dung lớn nhất hiển thị |
| `browser_web_vital_inp` | `Trend` | `Time` | thời gian phản hồi từ tương tác đến lần vẽ tiếp theo |
| `browser_web_vital_cls` | `Trend` | `Default` | điểm đo độ xê dịch bố cục, là điểm số chứ không phải thời gian |

Điểm cần nhớ:

```text
CLS không phải duration
nên core dùng Contains = Default cho browser_web_vital_cls
```

Còn các web vital như `ttfb`, `fcp`, `lcp`, `inp` là thời gian nên dùng `Time`.

## 7. Custom metrics trong script

Ngoài built-in metrics, bạn có thể tự tạo metric.

Official docs nói custom metrics phải tạo trong init context.
Core cũng check điều này trong:

```text
internal/js/modules/k6/metrics/metrics.go
```

Nếu tạo metric ngoài init context, core báo lỗi:

```text
metrics must be declared in the init context
```

Nếu gọi `.add()` trong init context, core cũng không cho:

```text
Adding to metrics in the init context is not supported
```

### 7.1 Ví dụ đủ 4 loại custom metric

```js
import { Counter, Gauge, Rate, Trend } from "k6/metrics";

const orders = new Counter("orders");
const queueDepth = new Gauge("queue_depth");
const checkoutOk = new Rate("checkout_ok");
const searchLatency = new Trend("search_latency", true);

export default function () {
  orders.add(1);
  queueDepth.add(7);
  checkoutOk.add(true);
  searchLatency.add(123);
}
```

Cắt nghĩa:

```text
orders
  Counter, vì muốn đếm số order

queue_depth
  Gauge, vì giá trị queue có thể tăng hoặc giảm

checkout_ok
  Rate, vì muốn biết tỉ lệ checkout thành công

search_latency
  Trend, vì muốn đo nhiều giá trị latency rồi đọc avg/p95
```

Tham số `true` trong:

```js
new Trend("search_latency", true)
```

nghĩa là:

```text
metric này chứa giá trị thời gian
core set Contains = Time
summary sẽ format theo kiểu thời gian
```

### 7.2 `.add(value, tags)` hoạt động như nào?

Custom metric có thể add tags:

```js
orders.add(1, { flow: "checkout" });
checkoutOk.add(false, { reason: "payment_rejected" });
searchLatency.add(180, { endpoint: "search" });
```

Hiểu là:

```text
vẫn cùng metric
nhưng sample có thêm tag để sau này lọc hoặc threshold
```

Ví dụ threshold theo tag:

```js
export const options = {
  thresholds: {
    "search_latency{endpoint:search}": ["p(95)<300"],
  },
};
```

Trong core, submetric dạng này được parse ở:

```text
metrics/metric.go
AddSubmetric()
ParseMetricName()
```

### 7.3 Value trong `.add()` nhận gì?

Trong custom metric core:

```text
value có thể là number hoặc boolean
true được đổi thành 1
false được đổi thành 0
NaN/null/không truyền value thì bị xem là lỗi
```

Vì `Rate` tính "value khác 0", nên:

```js
checkoutOk.add(true);  // tính là pass
checkoutOk.add(false); // tính là fail
```

Với `Counter`, nếu bạn add:

```js
orders.add(3);
```

thì tổng counter tăng 3, không phải tăng 1.

### 7.4 Tên custom metric hợp lệ

Tên custom metric nên đặt bằng ASCII:

```text
chữ cái
số
dấu gạch dưới _
```

Và nên bắt đầu bằng:

```text
chữ cái hoặc _
```

Ví dụ nên dùng:

```text
checkout_ok
search_latency
orders_created
payment_api_calls
```

Không nên dùng:

```text
checkout-ok
search latency
đơn_hàng
```

Official docs nói metric name bị giới hạn theo bộ ký tự an toàn cho output như OpenTelemetry/Prometheus.
Trong core, phần check tên nằm ở:

```text
metrics/registry.go
checkName()
nameRegexString
```

Điểm thực tế khi viết bài học:

```text
dùng chữ tiếng Anh không dấu
dùng snake_case
đừng dùng khoảng trắng
đừng dùng dấu gạch ngang
đừng dùng tiếng Việt có dấu trong metric name
```

## 8. Tags, submetrics, thresholds

### 8.1 Tags dùng để chia nhỏ metric

Ví dụ cùng `http_req_duration`, nhưng có tags:

```text
status=200
status=500
method=GET
method=POST
scenario=smoke
```

Khi đó bạn có thể đọc:

```text
http_req_duration toàn bộ
http_req_duration chỉ status=200
http_req_duration chỉ status=500
```

### 8.2 Submetric là metric đã lọc theo tag

Ví dụ:

```js
export const options = {
  thresholds: {
    "http_req_duration{status:200}": ["p(95)<300"],
    "http_req_failed{scenario:checkout}": ["rate<0.01"],
  },
};
```

Core hiểu:

```text
http_req_duration{status:200}
  = lấy metric http_req_duration
  = chỉ xét sample có tag status=200
```

Đây là lý do `Metric` trong core có:

```text
Submetrics []*Submetric
```

### 8.3 Threshold dùng aggregation nào?

Core `metrics/metric_type.go` quy định mỗi metric type dùng được aggregation nào:

| Type | Threshold aggregation hợp lệ |
| --- | --- |
| `Counter` | `count`, `rate` |
| `Gauge` | `value` |
| `Rate` | `rate` |
| `Trend` | `avg`, `min`, `max`, `med`, `p(x)` |

Ví dụ đúng:

```js
export const options = {
  thresholds: {
    http_reqs: ["rate>100"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
    vus: ["value<=50"],
  },
};
```

Ví dụ sai về mặt ý nghĩa:

```js
export const options = {
  thresholds: {
    http_req_failed: ["p(95)<300"],
  },
};
```

Vì:

```text
http_req_failed là Rate
Rate không có p(95)
```

## 9. Các nhầm lẫn hay gặp

### 9.1 `Rate` không phải luôn là `/s`

```text
http_reqs..........: 400    80/s
```

Ở đây `80/s` là `Counter rate`.

```text
http_req_failed....: 1.25%  5 out of 400
```

Ở đây `1.25%` là `Rate metric`.

Hai chữ `rate` giống nhau nhưng nghĩa khác nhau.

### 9.2 `iteration_duration avg` không phải iteration/s

Ví dụ:

```text
iteration_duration.............: avg=1.76s
iterations.....................: 13    1.729617/s
```

Đọc đúng:

```text
iteration_duration avg=1.76s
  = trung bình một iteration mất 1.76 giây để hoàn thành

iterations 1.729617/s
  = toàn test hoàn thành trung bình 1.729617 iteration mỗi giây
```

Hai số này liên quan nhưng không phải một đại lượng.

Nếu nhiều VU chạy song song:

```text
mỗi iteration có thể mất 1.76s
nhưng cả test vẫn có thể hoàn thành hơn 1 iteration mỗi giây
```

Vì nhiều VU cùng chạy.

### 9.3 `http_req_duration` không phải toàn bộ từ DNS đến nhận xong response

Theo docs:

```text
http_req_duration = http_req_sending + http_req_waiting + http_req_receiving
```

Nó không gồm:

```text
blocked
connecting
tls_handshaking
```

Muốn xem các phần đó thì đọc các metric riêng.

### 9.4 `http_req_failed` là Rate, không phải Counter

```text
http_req_failed
```

không cộng tổng failed request như `Counter`.
Nó tính:

```text
failed_samples / total_samples
```

Summary có thể in thêm:

```text
5 out of 400
```

nhưng type thật vẫn là `Rate`.

### 9.5 `checks` cũng là Rate

`checks` là tỉ lệ check pass.

Ví dụ:

```text
checks.............: 98.00% 490 out of 500
```

Đọc là:

```text
500 lần check được chạy
490 lần pass
tỉ lệ pass = 98%
```

Không đọc là:

```text
490 request thành công
```

Vì `check` là assertion do script viết, không nhất thiết là request.

### 9.6 `Gauge` không dùng để đếm tổng

Nếu muốn biết "đã tạo tổng cộng bao nhiêu order", dùng `Counter`.

Nếu muốn biết "hiện tại queue còn bao nhiêu item", dùng `Gauge`.

Sai thường gặp:

```text
dùng Gauge để add(1) mỗi lần có order
```

Khi đó output chỉ phản ánh giá trị cuối/min/max, không phải tổng order.

### 9.7 Browser metrics trong docs nhưng không nằm ở `metrics/builtin.go`

Nếu search:

```text
browser_web_vital_lcp
```

mà không thấy trong `metrics/builtin.go`, không có nghĩa là docs sai.

Nó được register ở:

```text
internal/js/modules/k6/browser/k6ext/metrics.go
```

Tương tự:

```text
grpc_streams
grpc_streams_msgs_sent
grpc_streams_msgs_received
```

nằm ở:

```text
internal/js/modules/k6/grpc/metrics.go
```

## 10. Checklist đọc output

Khi thấy một dòng metric trong k6 output, đọc theo thứ tự:

```text
1. Metric name là gì?
2. Type của nó là Counter, Gauge, Rate hay Trend?
3. Contains của nó là default, time hay data?
4. Summary đang in aggregation nào?
5. Aggregation đó trả lời câu hỏi gì?
```

Ví dụ:

```text
http_reqs...........: 1000   50/s
```

Đọc:

```text
name      = http_reqs
type      = Counter
contains  = Default
count     = 1000 request
rate      = 50 request/s trung bình
```

Ví dụ:

```text
http_req_failed.....: 0.50%  5 out of 1000
```

Đọc:

```text
name      = http_req_failed
type      = Rate
contains  = Default
rate      = 5 / 1000 = 0.5%
```

Ví dụ:

```text
http_req_duration...: avg=120ms min=50ms med=90ms max=900ms p(90)=220ms p(95)=350ms
```

Đọc:

```text
name      = http_req_duration
type      = Trend
contains  = Time
p(95)     = khoảng 95% request có duration <= 350ms
```

Ví dụ:

```text
vus.................: 4 min=1 max=4
```

Đọc:

```text
name      = vus
type      = Gauge
contains  = Default
value     = giá trị mới nhất
min/max   = thấp nhất/cao nhất từng thấy
```

## References

Official docs:

- https://grafana.com/docs/k6/latest/using-k6/metrics/
- https://grafana.com/docs/k6/latest/using-k6/metrics/reference/
- https://grafana.com/docs/k6/latest/using-k6/metrics/create-custom-metrics/
- https://grafana.com/docs/k6/latest/javascript-api/k6-metrics/

Core code:

- `metrics/metric.go`
- `metrics/metric_type.go`
- `metrics/value_type.go`
- `metrics/units.go`
- `metrics/sink.go`
- `metrics/sample.go`
- `metrics/registry.go`
- `metrics/builtin.go`
- `lib/netext/httpext/tracer.go`
- `internal/js/modules/k6/metrics/metrics.go`
- `internal/js/modules/k6/browser/k6ext/metrics.go`
- `internal/js/modules/k6/browser/common/network_manager.go`
- `internal/js/modules/k6/grpc/metrics.go`
- `internal/lib/netext/grpcext/conn.go`
- `internal/js/modules/k6/websockets/websockets.go`
