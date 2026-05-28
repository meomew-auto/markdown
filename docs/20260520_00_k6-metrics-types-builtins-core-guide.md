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
docs/20260515_04_k6-metric-types-and-formulas.md
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
| `Gauge` | lấy `sample.Value` mới nhất làm value hiện tại, đồng thời nhớ min/max | `vus value=4`, `queue_depth value=9` |
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

Note rõ về `Gauge`:

```text
value = 3
  = sample cuối cùng mà summary nhận được cho metric queue_depth
  = không phải tổng qua tất cả iteration
  = không phải mỗi iteration lấy một value rồi cộng lại

nếu test chạy nhiều iteration
  thì Gauge value là sample cuối cùng theo thời gian gom metric,
  thường là sample cuối cùng được add() trong run/submetric đó
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

Nói ngắn:

```text
Trend = giữ nhiều số
min/max = 2 đầu của tập số
med = điểm giữa
p90/p95 = mốc cắt ở phía chậm của tập số
```

Nó trả lời kiểu câu hỏi:

```text
nhanh nhất là bao nhiêu?
chậm nhất là bao nhiêu?
trung bình là bao nhiêu?
giá trị giữa là bao nhiêu?
p90/p95 là bao nhiêu?
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
med = percentile 50 = điểm giữa
p(90) = mốc mà khoảng 90% giá trị nằm bên trái hoặc bằng mốc đó
p(95) = mốc mà khoảng 95% giá trị nằm bên trái hoặc bằng mốc đó
```

#### Cách tính p90 / p95

Core làm theo 4 bước:

```text
1. sort values tăng dần
2. tính vị trí: pos = p * (n - 1)
3. nếu pos rơi đúng vào 1 sample -> lấy sample đó
4. nếu pos nằm giữa 2 sample -> nội suy giữa 2 sample đó
```

Trong đó:

```text
n = số sample
p = 0.90 cho p90, 0.95 cho p95
```

Ví dụ rất nhỏ:

```text
values = [100, 200, 300, 400]
```

Tính `p90`:

```text
n = 4
p = 0.90
pos = 0.90 * (4 - 1) = 2.7

left  = values[2] = 300
right = values[3] = 400

p90 = 300 + (400 - 300) * 0.7
    = 370
```

Tính `p95`:

```text
n = 4
p = 0.95
pos = 0.95 * (4 - 1) = 2.85

left  = values[2] = 300
right = values[3] = 400

p95 = 300 + (400 - 300) * 0.85
    = 385
```

Nên:

```text
p90 và p95 không nhất thiết là 1 sample thật trong tập
chúng có thể là số nội suy nằm giữa 2 sample
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

Đọc dễ hiểu nhất:

```text
95% sample có giá trị nằm ở bên trái hoặc bằng mốc này
5% sample còn lại nằm ở bên phải mốc này
```

Nói đời thường:

```text
p(95) là một cái mốc cắt
nó không phải "request thứ 95"
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

`p(90)` giống vậy, chỉ khác là nó cắt ở mức 90% thay vì 95%.
Nên:

```text
p(90) = bớt nhìn 10% đuôi chậm nhất
p(95) = bớt nhìn 5% đuôi chậm nhất
```

##### Nếu không phải 100 request thì đọc thế nào?

Nếu có 100 request thì nói "khoảng 95 request" rất dễ hiểu.
Nhưng nếu chỉ có 10, 20, 37, hoặc 1000 request thì không nên dịch máy móc thành "request thứ 95".

Đọc đúng hơn là:

```text
p(95)
  = mốc latency mà khoảng 95% sample nằm bên trái hoặc bằng mốc đó
  = tức là chỉ còn khoảng 5% sample chậm hơn mốc đó
```

Ví dụ có 20 request:

```text
http_req_duration p(95)=860ms
```

Đọc là:

```text
khoảng 95% trong 20 request có duration <= 860ms
tức là phần lớn request không chậm hơn 860ms
khoảng 5% request chậm nhất có thể lớn hơn 860ms
```

Không đọc thành:

```text
request số 95 mất 860ms
```

vì test chỉ có 20 request.

Nếu muốn nhớ nhanh:

```text
p90 = nhìn vùng chậm hơn của 10% đuôi cuối
p95 = nhìn vùng chậm hơn của 5% đuôi cuối
```

##### k6 tính `p(95)` với 20 sample ra sao?

Core `TrendSink.P()` làm theo ý sau:

```text
1. sort toàn bộ values tăng dần
2. tính vị trí:
   i = percentile * (count - 1)
3. nếu i rơi đúng vào một sample thì lấy sample đó
4. nếu i nằm giữa 2 sample thì nội suy tuyến tính
```

Ví dụ có 20 sample đã sort:

```text
sample #1  -> 100ms
sample #2  -> 110ms
...
sample #18 -> 200ms
sample #19 -> 800ms
sample #20 -> 2000ms
```

Với `p(95)`:

```text
count = 20
pct = 0.95

i = 0.95 * (20 - 1)
  = 0.95 * 19
  = 18.05
```

Vì k6 dùng index bắt đầu từ 0, `i=18.05` nằm giữa:

```text
index 18 = sample #19 = 800ms
index 19 = sample #20 = 2000ms
```

Nó chỉ đi 5% đoạn đường từ `800ms` tới `2000ms`:

```text
p(95) = 800 + (2000 - 800) * 0.05
      = 800 + 60
      = 860ms
```

Nên `p(95)` không nhất thiết đúng bằng một request thật.
Nó có thể là giá trị nội suy giữa 2 sample.

##### Ví dụ ít request: 10 sample

Giả sử có 10 request:

```text
9 request nhanh: 100ms
1 request rất chậm: 5000ms
```

Sorted values:

```text
[100, 100, 100, 100, 100, 100, 100, 100, 100, 5000]
```

`avg`:

```text
avg = (9 * 100 + 5000) / 10
    = 590ms
```

`p(90)`:

```text
i = 0.90 * (10 - 1)
  = 8.1

p(90) = 100 + (5000 - 100) * 0.1
      = 590ms
```

`p(95)`:

```text
i = 0.95 * (10 - 1)
  = 8.55

p(95) = 100 + (5000 - 100) * 0.55
      = 2795ms
```

Nhìn ví dụ này sẽ thấy:

```text
p(90) đã bắt đầu bị kéo bởi request rất chậm
p(95) bị kéo mạnh hơn
max vẫn là 5000ms
```

Với số sample ít, p90/p95 rất dễ dao động mạnh.
Vì vậy nếu demo chỉ có vài chục request thì dùng p95 để học cách đọc được, nhưng đừng vội kết luận
SLA của hệ thống từ một con số p95 rất ít sample.

##### Ví dụ rất ít request: 7 sample

Giả sử:

```text
values = [100, 120, 130, 150, 180, 220, 1000]
```

Với `p(95)`:

```text
count = 7
i = 0.95 * (7 - 1)
  = 5.7
```

`i=5.7` nằm giữa:

```text
index 5 = 220ms
index 6 = 1000ms
```

Nên:

```text
p(95) = 220 + (1000 - 220) * 0.7
      = 766ms
```

Đọc là:

```text
p95 khoảng 766ms trên tập 7 sample này
```

Không nên đọc thành:

```text
95% request chắc chắn dưới 766ms trong production
```

Vì 7 sample quá ít để đại diện cho production.

##### Nên dùng `p90` hay `p95`?

Không có một số luôn đúng cho mọi bài test.
Chọn `p90` hay `p95` phụ thuộc câu hỏi bạn muốn trả lời.

`p90` phù hợp khi:

```text
bạn muốn nhìn trải nghiệm của đa số user
bạn muốn số ổn định hơn p95 khi sample chưa quá nhiều
bạn đang so sánh nhanh giữa các lần chạy demo hoặc môi trường dev/staging
bạn chưa muốn bị vài outlier rất hiếm kéo kết luận quá mạnh
```

Đọc đời thường:

```text
p90 = 90% request không chậm hơn mốc này
```

`p95` phù hợp khi:

```text
bạn quan tâm phần đuôi chậm hơn
bạn muốn bắt 5% request chậm nhất trước khi user phàn nàn
bạn viết threshold/SLO nghiêm túc hơn p90
bạn có đủ sample để percentile đáng tin hơn
```

Đọc đời thường:

```text
p95 = 95% request không chậm hơn mốc này
```

Nếu hỏi "nên dùng cái nào khi performance test thật?", cách thực dụng là:

```text
báo cáo cơ bản:
  avg + med + p90 + p95 + max

threshold phổ biến:
  http_req_duration p(95) < mục tiêu latency

debug khi có đuôi rất chậm:
  xem thêm p99, max, và logs/traces
```

Không nên chỉ chọn một số duy nhất.
Ví dụ:

```text
avg = 120ms
p90 = 180ms
p95 = 900ms
max = 5000ms
```

Đọc là:

```text
đa số request khá nhanh
nhưng 5% request chậm hơn đang có vấn đề
max cho thấy có outlier rất chậm
```

Ngược lại:

```text
avg = 120ms
p90 = 180ms
p95 = 220ms
max = 5000ms
```

Đọc là:

```text
đa số và cả 95% request vẫn ổn
có một vài outlier rất hiếm
cần điều tra max nếu outlier đó ảnh hưởng nghiệp vụ, nhưng không nên kết luận toàn hệ thống chậm
```

#### `avg` có đủ không?

Không nên chỉ nhìn `avg`.

Ví dụ 10 request:

```text
9 request mất 100ms
1 request mất 5000ms
```

`avg` có thể bị kéo lên bởi request rất chậm.
`p(95)` hoặc `max` giúp thấy đuôi chậm.

##### Demo bằng chữ: 10 người bấm checkout

Tưởng tượng bạn đang test API checkout.
Trong 1 đoạn test ngắn, có 10 request checkout hoàn thành như sau:

| Request | Thời gian trả lời | Đọc như người test |
| --- | ---: | --- |
| 1 | 100ms | nhanh |
| 2 | 100ms | nhanh |
| 3 | 100ms | nhanh |
| 4 | 100ms | nhanh |
| 5 | 100ms | nhanh |
| 6 | 100ms | nhanh |
| 7 | 100ms | nhanh |
| 8 | 100ms | nhanh |
| 9 | 100ms | nhanh |
| 10 | 5000ms | rất chậm |

Nhìn bằng mắt thường, ta thấy câu chuyện thật là:

```text
9 người checkout rất nhanh
1 người bị kẹt rất lâu
```

Nếu báo cáo chỉ đưa một dòng:

```text
avg=590ms
```

người mới rất dễ đọc nhầm thành:

```text
hệ thống thường trả lời khoảng 590ms
```

Nhưng câu đó không đúng với demo này.
Trong 10 request không có request nào mất `590ms`.
Chỉ có hai nhóm:

```text
nhóm bình thường: 100ms
nhóm bị kẹt: 5000ms
```

Vì vậy `avg` trả lời câu hỏi:

```text
nếu lấy tổng thời gian chia đều cho mọi request thì trung bình là bao nhiêu?
```

Nó không trả lời rõ câu hỏi:

```text
đa số request có nhanh không?
có request nào bị chậm bất thường không?
phần đuôi chậm nặng tới mức nào?
```

Với cùng bộ số này, đọc đầy đủ hơn sẽ là:

```text
med=100ms
```

Đa số request vẫn nằm ở vùng nhanh.

```text
max=5s
```

Có ít nhất một request rất chậm.
Đây là dấu hiệu đuôi chậm.

```text
p(95)=2.79s
```

Đọc nhanh thường là:

```text
khoảng 95% sample nằm ở dưới hoặc bằng ngưỡng này
```

Nhưng với demo chỉ có 10 sample, phải nói kỹ hơn:

```text
p(95)=2.79s không có nghĩa là có đúng 9.5 request <= 2.79s
```

Vì request là số nguyên, không thể có `9.5 request`.
Trong bộ số này, request thật chỉ là:

```text
9 request = 100ms
1 request = 5000ms
```

Vậy nếu đếm trực tiếp:

```text
9/10 request <= 2.79s
1/10 request > 2.79s
```

Tức là đếm thô thì có `90%` request thật nằm dưới `2.79s`.
Còn `p(95)=2.79s` là ngưỡng do k6 nội suy giữa `100ms` và `5000ms`.

Vì vậy câu đúng hơn trong demo này là:

```text
theo cách k6 tính percentile, ngưỡng p95 của bộ sample này nằm khoảng 2.79s
```

Không nên nói máy móc:

```text
chính xác 95% request thật nhanh hơn 2.79s
```

Vùng gần cuối của phân phối đã bị request `5000ms` kéo lên.
Với chỉ 10 sample, số `p(95)` này là số nội suy theo cách k6 tính trong core, không phải duration thật của một request cụ thể.

Vì vậy nếu dùng demo này để đánh giá hệ thống thật thì chưa chuẩn.
Lý do không phải k6 tính sai, mà là bộ sample quá ít và có một request quá lâu.
Một request `5000ms` trong chỉ 10 request sẽ làm các số vùng đuôi dao động rất mạnh.

Demo này chỉ nên dùng để học cách đọc metric:

```text
avg bị kéo lên
med vẫn cho thấy đa số request nhanh
p90/p95 bắt đầu bị ảnh hưởng bởi đuôi chậm
max chỉ thẳng ra request chậm nhất
```

Muốn kết luận performance thật, cần chạy đủ lâu hơn để có nhiều sample hơn.
Ví dụ thay vì 10 request, có thể cần vài trăm, vài nghìn, hoặc nhiều hơn tùy hệ thống.
Khi đó `p(95)` ổn định hơn và câu "khoảng 95% request nằm dưới ngưỡng này" mới có ý nghĩa thực tế hơn.

Ngoài ra không nên lấy mỗi `p(95)` để kết luận.
Nếu nghiệp vụ không chấp nhận bất kỳ request nào quá chậm, phải nhìn thêm:

```text
max
p(99)
http_req_failed
count/http_reqs
```

Ví dụ:

```text
p(95)=300ms
max=10s
```

Không thể kết luận hệ thống ổn chỉ vì `p(95)` đẹp.
Dòng này nói rằng phần lớn request có thể ổn, nhưng vẫn có request bị treo tới `10s`.
Nếu request treo đó là checkout, payment, login, hoặc API quan trọng, nó vẫn là vấn đề cần điều tra.

Nói đời thường:

```text
avg cho biết mặt bằng trung bình
med cho biết request điển hình
max cho biết ca chậm nhất
p(90), p(95) cho biết nhóm request chậm phía trên có xấu không
```

Ở đây không nên dùng chữ "gần cuối" theo nghĩa thời gian.
`p(90)` và `p(95)` không hỏi:

```text
cuối bài test có chậm không?
```

Nó hỏi câu khác:

```text
nếu gom tất cả request lại rồi sắp xếp từ nhanh tới chậm,
thì vùng request chậm phía trên đang nằm ở mức nào?
```

Nói cách khác, k6 không lấy 90% hoặc 95% theo timeline chạy test.
Nó lấy theo danh sách duration đã được sắp xếp.

Ví dụ bài test có 10 request chạy theo thời gian như sau:

```text
request theo thời gian:
1: 100ms
2: 100ms
3: 5000ms  <- chậm giữa bài test
4: 100ms
5: 100ms
6: 100ms
7: 100ms
8: 100ms
9: 100ms
10: 100ms
```

Request chậm nằm ở giữa bài test, không nằm ở cuối.
Nhưng khi tính percentile, core sort lại theo giá trị:

```text
request sau khi sort theo duration:
100ms
100ms
100ms
100ms
100ms
100ms
100ms
100ms
100ms
5000ms
```

Vì vậy request `5000ms` vẫn nằm ở phía cuối của danh sách đã sort.
Nó vẫn có thể kéo `p(90)`, `p(95)`, hoặc `max` lên, dù nó xảy ra giữa bài test.

Đây là lý do percentile giúp phát hiện "đuôi chậm":

```text
đuôi chậm = nhóm request chậm nhất sau khi sort duration
không phải = đoạn cuối thời gian chạy test
```

##### Vì sao phải quan tâm phần đuôi?

Vì người dùng thật không chỉ cảm nhận `avg`.
Mỗi request là một lần người dùng chờ hệ thống trả lời.
Nếu 95% request nhanh nhưng 5% request rất chậm, thì vẫn có một nhóm người dùng thật bị ảnh hưởng.

Ví dụ có 1000 request login:

```text
950 request = 200ms
50 request = 5000ms
```

Nếu chỉ nhìn chung chung, bạn có thể nói:

```text
phần lớn request vẫn nhanh
```

Câu đó đúng, nhưng chưa đủ.
Vì còn 50 request mất `5s`.
Nếu mỗi request là một người dùng, nghĩa là có 50 người phải chờ rất lâu ở màn hình login.

Với nghiệp vụ quan trọng, nhóm nhỏ này vẫn đáng quan tâm:

```text
login chậm 5s
  -> người dùng tưởng app lỗi

checkout chậm 5s
  -> người dùng có thể bấm lại, tạo duplicate request

payment chậm 5s
  -> người dùng lo giao dịch bị treo

search chậm 5s
  -> người dùng thấy hệ thống thiếu ổn định
```

Đây là lý do performance không chỉ hỏi:

```text
trung bình có nhanh không?
```

Mà còn hỏi:

```text
nhóm người dùng chậm nhất đang chậm tới mức nào?
```

Phần đuôi còn giúp phát hiện vấn đề mà `avg` che mất.
Một hệ thống có thể có nhiều request nhanh nhờ cache, nhưng một số request rơi vào case xấu:

```text
cache miss
query DB chậm
DB bị lock
queue chờ worker
connection pool hết chỗ
GC pause
service downstream chậm
```

Các vấn đề này thường không làm mọi request chậm cùng lúc.
Chúng chỉ làm một nhóm request chậm bất thường.
Nhóm đó chính là phần đuôi.

Ví dụ:

```text
990 request = 100ms
10 request = 3000ms
```

`avg` có thể nhìn vẫn không quá xấu:

```text
avg = (990 * 100 + 10 * 3000) / 1000
    = (99000 + 30000) / 1000
    = 129ms
```

Nếu chỉ nhìn `avg=129ms`, bạn dễ kết luận:

```text
hệ thống nhanh
```

Nhưng thực tế vẫn có 10 request mất `3s`.
Nếu 10 request đó đều là request checkout hoặc payment, đây không còn là chuyện nhỏ.

Vì vậy cần nhìn phần đuôi để trả lời:

```text
người dùng chậm nhất đang phải chờ bao lâu?
nhóm 5% chậm nhất có vượt mục tiêu cam kết không?
có request nào chậm bất thường tới mức nguy hiểm không?
```

Nói ngắn:

```text
avg cho biết bức tranh trung bình
percentile cho biết trải nghiệm của nhóm chậm
max cho biết ca chậm nhất
```

Nhưng percentile cũng có giới hạn.
Nếu request rất chậm quá ít, `p(95)` có thể vẫn đẹp.
Ví dụ có 1000 request:

```text
990 request = 100ms
10 request = 5000ms
```

10 request chậm chỉ chiếm `1%`.
Lúc này `p(95)` vẫn có thể gần `100ms`, vì 95% request đầu tiên vẫn nằm trong nhóm nhanh.
Muốn thấy nhóm chậm rất hiếm này, cần nhìn thêm:

```text
p(99)
p(99.9)
max
log/trace của request chậm
```

Ngược lại, nếu request chậm đủ nhiều, `p(95)` sẽ bắt đầu xấu.
Ví dụ:

```text
940 request = 100ms
60 request = 5000ms
```

60 request chậm chiếm `6%`.
Khi đó mốc 95% đã rơi vào vùng chậm hơn, nên `p(95)` sẽ tăng mạnh.

Vì vậy khi điều tra performance, đừng chỉ hỏi:

```text
avg bao nhiêu?
```

Mà nên hỏi:

```text
đa số request nhanh không?
có bao nhiêu request lỗi?
có request nào chậm bất thường không?
p90/p95 có vượt mục tiêu không?
```

##### Demo chạy được bằng code: 9 request nhanh, 1 request rất chậm

File demo:

```text
examples/trend_tail_latency_demo.js
```

Chạy:

```bash
k6 run examples/trend_tail_latency_demo.js
```

Demo này không gọi HTTP thật.
Nó dùng custom `Trend` để tạo 10 sample latency cố định, nhờ vậy số trong summary không bị nhiễu bởi mạng thật.

Trong file demo:

```javascript
const tailLatency = new Trend("tail_latency", true);

export default function () {
  const values = [100, 100, 100, 100, 100, 100, 100, 100, 100, 5000];

  for (const value of values) {
    tailLatency.add(value);
    console.log(`[tail-latency-sample] value=${value}ms`);
  }
}
```

Cắt nghĩa:

```text
tail_latency
```

là tên metric tự tạo.

```text
new Trend("tail_latency", true)
```

nghĩa là tạo một metric loại `Trend`.
Tham số `true` nói với k6 rằng giá trị này là thời gian, nên summary sẽ in theo `ms` hoặc `s`.

```text
tailLatency.add(100)
```

nghĩa là thêm một sample có giá trị `100ms`.
Mỗi lần gọi `.add()` là thêm một sample vào metric `tail_latency`.

Danh sách này:

```text
[100, 100, 100, 100, 100, 100, 100, 100, 100, 5000]
```

nghĩa là:

```text
9 sample nhanh: 100ms
1 sample rất chậm: 5000ms
```

Output chính:

```text
tail_latency.........: count=10 avg=590ms min=100ms med=100ms max=5s p(90)=589.99ms p(95)=2.79s
```

Cắt nghĩa từng cột:

```text
count=10
```

Metric này nhận đúng 10 sample.

```text
min=100ms
```

Sample nhanh nhất là `100ms`.

```text
max=5s
```

Sample chậm nhất là `5000ms`, k6 format thành `5s`.

```text
med=100ms
```

Giá trị ở giữa vẫn là `100ms`.
Vì trong 10 sample có tới 9 sample bằng `100ms`.
Nhìn `med` sẽ thấy phần lớn request thật ra vẫn nhanh.

```text
avg=590ms
```

Core tính trung bình bằng:

```text
avg = tổng giá trị / số sample
```

Với demo này:

```text
tổng giá trị = 9 * 100 + 5000
             = 900 + 5000
             = 5900ms

số sample = 10

avg = 5900 / 10
    = 590ms
```

Điểm dễ hiểu nhầm nằm ở đây:

```text
Không có request nào thật sự mất 590ms.
```

Thực tế chỉ có:

```text
9 request mất 100ms
1 request mất 5000ms
```

Nhưng `avg` bị request `5000ms` kéo lên thành `590ms`.
Nếu chỉ nhìn `avg=590ms`, bạn có thể tưởng hệ thống thường xuyên trả lời quanh `590ms`.
Điều đó sai với bộ sample này.

Core phần `Trend` nằm ở `metrics/sink.go`.
Khi có sample mới, `TrendSink.Add()` làm các việc chính:

```text
lưu value vào danh sách values
tăng count
cộng value vào sum
cập nhật min/max
```

Sau đó `Avg()` trả về:

```text
sum / count
```

Vì vậy `avg` không biết sample nào là request bình thường, sample nào là request rất chậm.
Nó chỉ lấy tổng chia đều.

##### Vì sao `p(95)=2.79s` trong demo này?

Core `TrendSink.P()` trong `metrics/sink.go` tính percentile bằng cách:

```text
1. sort toàn bộ values tăng dần
2. tính vị trí i = percentile * (count - 1)
3. nếu i nằm giữa 2 sample thì nội suy tuyến tính
```

Danh sách sau khi sort vẫn là:

```text
index: 0    1    2    3    4    5    6    7    8    9
value: 100  100  100  100  100  100  100  100  100  5000
```

Với `p(90)`:

```text
percentile = 0.90
count = 10

i = 0.90 * (10 - 1)
  = 0.90 * 9
  = 8.1
```

Vị trí `8.1` nằm giữa:

```text
index 8 = 100ms
index 9 = 5000ms
```

Phần lẻ là:

```text
0.1
```

Nên core nội suy:

```text
p(90) = 100 + (5000 - 100) * 0.1
      = 100 + 490
      = 590ms
```

Khi in summary, do biểu diễn số thực và format thời gian, bạn có thể thấy:

```text
p(90)=589.99ms
```

Hiểu thực tế là khoảng `590ms`.

Với `p(95)`:

```text
percentile = 0.95
count = 10

i = 0.95 * (10 - 1)
  = 0.95 * 9
  = 8.55
```

Vị trí `8.55` nằm giữa:

```text
index 8 = 100ms
index 9 = 5000ms
```

Phần lẻ là:

```text
0.55
```

Nên core nội suy:

```text
p(95) = 100 + (5000 - 100) * 0.55
      = 100 + 4900 * 0.55
      = 100 + 2695
      = 2795ms
      ~= 2.79s
```

Vì vậy summary in:

```text
p(95)=2.79s
```

Đọc câu này thế nào?

Với dữ liệu lớn, cách đọc thực tế thường là:

```text
khoảng 95% sample có duration <= p(95)
khoảng 5% sample còn lại nằm phía trên p(95)
```

Nhưng với đúng demo 10 sample này, đọc như vậy dễ gây hiểu nhầm.
Vì core dùng nội suy nên `p(95)=2795ms` không cần trùng với một request thật.
Nếu đếm request thật trong demo:

```text
9 request = 100ms <= 2795ms
1 request = 5000ms > 2795ms
```

Tức là:

```text
90% request thật <= 2.79s
10% request thật > 2.79s
```

Vậy tại sao vẫn gọi là `p(95)`?
Vì k6 đang tính vị trí 95% trên đường nối giữa sample ở index `8` và sample ở index `9`.
Nó không chọn một request thật làm mốc, mà nội suy ra một giá trị nằm giữa hai request đó.

Lưu ý quan trọng:

```text
p(95) ở đây không phải một request thật có duration đúng 2795ms.
```

Trong demo này request thật chỉ có `100ms` hoặc `5000ms`.
`2795ms` là giá trị nội suy do core tính ra từ tập sample.

Với chỉ 10 sample, `p(95)` rất dễ dao động và không nên dùng để kết luận lớn.
Demo này chỉ để thấy rõ vì sao không nên đọc mỗi `avg`.
Khi test thật, cần đủ nhiều sample hơn và nên đọc cùng lúc:

```text
avg
med
p(90)
p(95)
max
error rate
```

Đọc demo này theo cách thực tế:

```text
med=100ms
  phần lớn request nhanh

avg=590ms
  bị request 5000ms kéo lên

max=5s
  có ít nhất một request rất chậm

p(95)=2.79s
  phần đuôi latency đã bị ảnh hưởng bởi request rất chậm
  nhưng vì chỉ có 10 sample nên p95 là số nội suy, chưa đủ để kết luận chắc
```

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

Các metric này sinh ra khi script dùng HTTP API như `http.get()`, `http.post()`.
Đọc mục này theo một format cố định:

```text
metric này trong core được định nghĩa/tính thế nào?
  -> khi nhìn summary thì nói bằng tiếng người như nào?
  -> khi số xấu thì nên nghi vấn gì?
```

Core chính:

```text
metrics/builtin.go
  -> đăng ký tên metric, type, contains

lib/netext/httpext/tracer.go
  -> đo timing bằng httptrace
  -> Tracer.Done() tính ra Trail
  -> Trail.SaveSamples() sinh sample cho các http_req_* timing metric

lib/netext/httpext/transport.go
  -> sau khi có status/error, tính expected_response
  -> nếu có responseCallback thì sinh thêm sample http_req_failed

lib/netext/httpext/request.go
  -> copy cùng Trail sang response.timings để script có thể log ra
```

Trong `metrics/builtin.go`, core đăng ký type như sau:

| Metric | Type | Contains |
| --- | --- | --- |
| `http_reqs` | `Counter` | `Default` |
| `http_req_failed` | `Rate` | `Default` |
| `http_req_duration` | `Trend` | `Time` |
| `http_req_blocked` | `Trend` | `Time` |
| `http_req_connecting` | `Trend` | `Time` |
| `http_req_tls_handshaking` | `Trend` | `Time` |
| `http_req_sending` | `Trend` | `Time` |
| `http_req_waiting` | `Trend` | `Time` |
| `http_req_receiving` | `Trend` | `Time` |

Trong `lib/netext/httpext/tracer.go`, một request HTTP kết thúc thì
`Trail.SaveSamples()` luôn append các sample timing này:

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

Riêng `http_req_failed` không nằm trong block timing đó.
Nó được append thêm trong `lib/netext/httpext/transport.go`, sau khi core chạy
`responseCallback(statusCode)`.

#### 6.2.1 Bảng đọc chuẩn từng HTTP metric

Đây là bảng nên đọc trước.
Các đoạn sau chỉ là giải thích và demo chi tiết cho bảng này.

| Metric | Core định nghĩa/tính value như nào | Thực tế nên nói như nào | Khi số xấu thì nghĩ gì? |
| --- | --- | --- | --- |
| `http_reqs` | `Trail.SaveSamples()` append sample `value=1` cho mỗi HTTP request đã xử lý xong. Vì là `Counter`, summary cộng lại thành `count`. | Tổng số HTTP request k6 đã ghi metric. | So với số iteration để xem mỗi iteration tạo mấy request; không được nhầm với `iterations`. |
| `http_req_failed` | `transport.go` gọi `responseCallback(statusCode)`. Nếu callback trả `false` thì sample `value=1`, nếu `true` thì `value=0`. Vì là `Rate`, summary in tỉ lệ fail. | Tỉ lệ request không đúng kỳ vọng status theo rule của k6/request. | Mặc định expected là `200..399`; HTTP 500 mặc định fail, nhưng có thể không fail nếu request dùng `http.expectedStatuses(500)`. |
| `http_req_duration` | `Tracer.Done()` tính `Duration = Sending + Waiting + Receiving`. `SaveSamples()` append `Trail.Duration`. | Thời gian phần request/response chính: gửi request, chờ byte đầu, nhận response. | Nếu cao, xem tiếp `waiting` hay `receiving` cao. Không dùng nó để kết luận DNS/connect/TLS chậm. |
| `http_req_blocked` | Nếu có `getConn` và `gotConn`, core tính `Blocked = gotConn - getConn`. | Thời gian từ lúc Go HTTP client bắt đầu lấy/tạo connection tới lúc có connection dùng được. | Có thể tăng khi chờ connection rảnh, tạo connection mới, hoặc bị giới hạn connection. Lưu ý: theo code, nó có thể bao trùm cả đoạn connect/TLS để có connection, nên không cộng máy móc `blocked + connecting + tls`. |
| `http_req_connecting` | Nếu có `connectStart` và `connectDone`, core tính `Connecting = connectDone - connectStart`. | Thời gian tạo kết nối TCP tới remote host. | Cao thì nghi network, proxy, route, firewall, remote host nhận connection chậm. Nếu connection được reuse, giá trị thường gần `0`. |
| `http_req_tls_handshaking` | Nếu có `tlsHandshakeStart` và `tlsHandshakeDone`, core tính `TLSHandshaking = tlsHandshakeDone - tlsHandshakeStart`. | Thời gian bắt tay TLS của HTTPS. | Cao thì nghi TLS negotiation, certificate, proxy TLS, network tới server. HTTP thường hoặc connection reuse có thể là `0`. |
| `http_req_sending` | Khi `wroteRequest` có giá trị, core tính từ sau TLS/connect/gotConn tới lúc ghi xong request. | Thời gian k6 gửi request lên server. | Với GET/body nhỏ thường rất nhỏ. Cao khi upload body lớn, mạng upload chậm, hoặc client gửi request bị nghẽn. |
| `http_req_waiting` | Nếu có byte đầu tiên: `Waiting = gotFirstResponseByte - wroteRequest`. Nếu server không trả byte nào: `Waiting = done - wroteRequest`. | Thời gian sau khi gửi xong request tới khi nhận byte đầu tiên. | Đây là metric hay nhìn để nghi server xử lý chậm, DB chậm, queue, downstream chậm. Nhưng nó vẫn gồm network latency tới byte đầu tiên, không phải chỉ CPU server. |
| `http_req_receiving` | Nếu có `gotFirstResponseByte`, core tính `Receiving = done - gotFirstResponseByte`. | Thời gian tải response sau khi đã có byte đầu tiên. | Cao khi response body lớn, mạng tải xuống chậm, hoặc client đọc body mất lâu. |

Ghi chú quan trọng về `http_req_duration`:

```text
http_req_duration = http_req_sending + http_req_waiting + http_req_receiving
```

Nó không gồm:

```text
blocked
connecting
tls_handshaking
```

Vì vậy cách đọc thực tế:

```text
duration cao
  -> xem waiting hay receiving cao

waiting cao
  -> nghi server/DB/downstream/queue hoặc latency tới byte đầu tiên

receiving cao
  -> nghi response lớn hoặc download chậm

blocked/connecting/tls cao
  -> nghi khâu lấy/tạo connection, TCP, TLS, proxy, network
```

Ghi chú thêm về `blocked`:

```text
blocked không phải một phase độc lập để cộng với connecting và tls
```

Theo code hiện tại:

```text
blocked = gotConn - getConn
```

`getConn` là lúc Go HTTP client bắt đầu lấy hoặc tạo connection.
`gotConn` là lúc đã có connection dùng được.
Với connection mới, đoạn này có thể bao gồm cả thời gian dial TCP và TLS handshake.
Vì vậy trong demo bạn có thể thấy:

```text
blocked gần bằng connecting + tls_handshaking
```

Đọc đúng là:

```text
blocked = mất bao lâu để k6 có connection dùng được
connecting = riêng phần TCP connect
tls_handshaking = riêng phần TLS handshake
```

Ghi chú về thời điểm ghi sample:

```text
sample http_req_* được ghi khi request kết thúc
tức là khi k6 nhận xong response body, discard xong body, hoặc request kết thúc vì lỗi/timeout
```

#### 6.2.2 Bằng chứng từ core cho bảng trên

Muốn hiểu đúng các HTTP metric thì đọc theo luồng này:

```text
metrics/builtin.go
  -> đăng ký tên metric, type, contains

lib/netext/httpext/tracer.go
  -> đo các mốc thời gian của request
  -> Tracer.Done() tính ra Trail
  -> Trail.SaveSamples() append sample cho các http_req_* timing metric

lib/netext/httpext/transport.go
  -> sau khi biết status/error thì quyết định expected_response
  -> append thêm sample cho http_req_failed
```

Nói đời thường:

```text
một HTTP request kết thúc
  -> k6 gom các mốc thời gian thành Trail
  -> từ Trail sinh ra nhiều sample
  -> mỗi sample đi vào đúng metric của nó
```

Một lần gọi `http.get()` trong script thường tạo một HTTP request.
Nhưng nếu có redirect, retry ở tầng thấp, hoặc behavior đặc biệt của HTTP client,
thì điều quan trọng khi đọc metric là: k6 emit metric theo request HTTP thực tế
mà transport đã xử lý xong, không phải theo số dòng code `http.get()` bạn nhìn thấy.

Dưới đây là review từng metric theo đúng format:

```text
metric là gì
  -> core định nghĩa ở đâu
  -> core tính value như nào
  -> demo dùng file nào, đoạn nào tạo ra value đó
```

Tất cả ví dụ trong mục `6.2` dùng chung một file demo mặc định:

```text
examples/http_metrics_types_demo.js
```

Bản full file nằm ở mục `6.2.3`.
Khi từng metric bên dưới nói "demo chứng minh", hãy hiểu là đang trỏ về file này.

Map nhanh từ metric sang đoạn code tạo ra value:

| Metric | Đoạn trong file demo tạo ra value |
| --- | --- |
| `http_reqs` | `options.scenarios.http_metrics_types_demo.iterations = 2` và 3 lệnh `http.get()` trong `default function` |
| `http_req_failed` | 3 request có tag `endpoint`: `status_200`, `status_500_default`, `status_500_expected`; riêng `status_500_expected` có `responseCallback: http.expectedStatuses(500)` |
| `http_req_duration` | function `traceResponse()` log `duration` và tự cộng `sending + waiting + receiving` |
| `http_req_blocked` | function `traceResponse()` log `timings.blocked`; option `noConnectionReuse: true` giúp dễ thấy số hơn |
| `http_req_connecting` | function `traceResponse()` log `timings.connecting`; option `noConnectionReuse: true` giúp tạo connection mới |
| `http_req_tls_handshaking` | function `traceResponse()` log `timings.tls_handshaking`; URL dùng `https://...` |
| `http_req_sending` | function `traceResponse()` log `timings.sending` |
| `http_req_waiting` | function `traceResponse()` log `timings.waiting` |
| `http_req_receiving` | function `traceResponse()` log `timings.receiving` |

Lưu ý:

```text
Với HTTP built-in metrics, script không tự gọi .add() để tạo sample.
Chỉ cần script gọi http.get()/http.post(), core sẽ đo request và tự emit sample.
```

Vì vậy trong demo:

```text
3 lệnh http.get()
  -> tạo HTTP request thật
  -> core tạo Trail
  -> Trail.SaveSamples() sinh sample cho http_reqs và các timing metric
  -> transport.go sinh thêm http_req_failed nếu có responseCallback
  -> traceResponse() chỉ log lại response.timings để ta nhìn thấy cùng nguồn value
```

Đoạn tạo 3 request chính:

```js
const ok = http.get("https://quickpizza.grafana.com/api/status/200", {
  tags: { endpoint: "status_200" },
});

const failByDefault = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_default" },
});

const expected500 = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_expected" },
  responseCallback: http.expectedStatuses(500),
});
```

Đoạn log các timing:

```js
function traceResponse(label, response) {
  const timings = response.timings;
  const recomputedDuration =
    timings.sending + timings.waiting + timings.receiving;

  console.log(
    [
      `[metric-trace] endpoint=${label}`,
      `status=${response.status}`,
      `blocked=${ms(timings.blocked)}ms`,
      `connecting=${ms(timings.connecting)}ms`,
      `tls_handshaking=${ms(timings.tls_handshaking)}ms`,
      `sending=${ms(timings.sending)}ms`,
      `waiting=${ms(timings.waiting)}ms`,
      `receiving=${ms(timings.receiving)}ms`,
      `duration=${ms(timings.duration)}ms`,
      `sending+waiting+receiving=${ms(recomputedDuration)}ms`,
    ].join(" "),
  );
}
```

##### `http_reqs`

`http_reqs` trả lời câu hỏi:

```text
k6 đã đo được bao nhiêu HTTP request?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqs: registry.MustNewMetric(http_reqs, Counter)

lib/netext/httpext/tracer.go
  Trail.SaveSamples()
  append sample:
    metric = HTTPReqs
    value  = 1
```

Nghĩa là mỗi request HTTP khi kết thúc sẽ đóng góp một sample `value=1`.
Vì metric này là `Counter`, summary cộng các sample lại.

Trong file demo chung, phần tạo ra `count=6` là:

```js
export const options = {
  scenarios: {
    http_metrics_types_demo: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "30s",
    },
  },
};
```

và trong `default function` có 3 lệnh HTTP:

```js
http.get("https://quickpizza.grafana.com/api/status/200", ...);
http.get("https://quickpizza.grafana.com/api/status/500", ...);
http.get("https://quickpizza.grafana.com/api/status/500", ...);
```

Vì vậy demo tạo:

```text
iterations = 2
mỗi iteration gọi 3 request

=> http_reqs count = 2 * 3 = 6
```

Trong demo có threshold:

```js
http_reqs: ["count==6"]
```

Khi chạy đúng sẽ thấy:

```text
http_reqs
  'count==6' count=6
```

Điểm dễ nhầm:

```text
http_reqs không phải số iteration
1 iteration có thể gọi nhiều HTTP request
```

##### `http_req_failed`

`http_req_failed` trả lời câu hỏi:

```text
trong các request đã đo, bao nhiêu request bị k6 xem là không đúng kỳ vọng?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqFailed: registry.MustNewMetric(http_req_failed, Rate)

lib/netext/httpext/transport.go
  expected = responseCallback(statusCode)

  nếu expected == false:
    failed = 1
  ngược lại:
    failed = 0

  append sample:
    metric = HTTPReqFailed
    value  = failed
```

Vì metric này là `Rate`, value `1` được tính là fail, value `0` được tính là
không fail.

Core không định nghĩa đơn giản là:

```text
status >= 400 thì failed
```

Core dựa vào `responseCallback`.
Mặc định `responseCallback` được set ở `js/modules/k6/http/http.go`:

```text
responseCallback: defaultExpectedStatuses.match
```

`defaultExpectedStatuses` nằm trong `js/modules/k6/http/response_callback.go`:

```text
200..399
```

Nói ngắn:

```text
k6 không bắt server "phải trả đúng code"
k6 chỉ hỏi: code này có nằm trong nhóm expected không?
```

Nếu request không ghi `responseCallback`, core dùng mặc định:

```text
200..399
```

Tức là:

```text
không khai báo expected
  -> dùng default expected của k6
```

Nên mặc định:

```text
status 200 -> expected=true  -> http_req_failed value=0
status 500 -> expected=false -> http_req_failed value=1
```

Theo core, cách tạo sample của `http_req_failed` là:

```text
1. request kết thúc
2. transport lấy statusCode thật của response
3. gọi responseCallback(statusCode)
4. nếu callback trả false -> failed=1
5. nếu callback trả true  -> failed=0
6. append sample http_req_failed với value đó
```

Nhưng nếu chính request đó khai báo:

```js
responseCallback: http.expectedStatuses(500)
```

thì status `500` lại được xem là expected:

```text
status 500 + expectedStatuses(500)
  -> expected=true
  -> http_req_failed value=0
```

Nếu request bị timeout / lỗi mạng, core thường xem đó là không expected:

```text
statusCode = 0
default callback = 200..399
-> expected=false
-> http_req_failed value=1
```

Vì vậy `http_req_failed` không có nghĩa là "server trả sai theo core".
Nó có nghĩa là "response này không khớp expectation mà request/script đã đặt".

Một chi tiết trong core: `transport.go` chỉ append `http_req_failed` khi
`responseCallback != nil`.
Nếu bạn tắt callback bằng `http.setResponseCallback(null)`, request có thể
không sinh sample `http_req_failed`.
Demo này không dùng `null` vì mục tiêu là làm metric `http_req_failed` hiện rõ.

Trong file demo chung, phần tạo ra `http_req_failed value=0` hoặc `value=1`
là 3 request này.

Request thứ nhất:

```js
const ok = http.get("https://quickpizza.grafana.com/api/status/200", {
  tags: { endpoint: "status_200" },
});
```

Đọc theo core:

```text
status_200
  status trả về = 200
  default expected = 200..399
  expected_response=true
  http_req_failed value=0
```

Request thứ hai:

```js
const failByDefault = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_default" },
});
```

Đọc theo core:

```text
status_500_default
  status trả về = 500
  default expected = 200..399
  expected_response=false
  http_req_failed value=1
```

Đây là đoạn tạo fail thật trong demo:

```text
status 500 + default expectedStatuses(200..399)
  -> responseCallback trả false
  -> failed = 1
  -> http_req_failed nhận sample value=1
```

Request thứ ba:

```js
const expected500 = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_expected" },
  responseCallback: http.expectedStatuses(500),
});
```

Đọc theo core:

```text
status_500_expected
  status trả về = 500
  request tự khai báo responseCallback: http.expectedStatuses(500)
  expected_response=true
  http_req_failed value=0
```

Vì có 2 iteration, mỗi endpoint trên chạy 2 lần:

```text
failed samples = 2 request status_500_default
total samples  = 6 request

http_req_failed = 2 / 6 = 33.33%
```

Khi chạy đúng sẽ thấy:

```text
http_req_failed......................: 33.33%  2 out of 6
  { endpoint:status_200 }............: 0.00%   0 out of 2
  { endpoint:status_500_default }....: 100.00% 2 out of 2
  { endpoint:status_500_expected }...: 0.00%   0 out of 2
```

##### `http_req_duration`

`http_req_duration` trả lời câu hỏi:

```text
phần request/response chính mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqDuration: registry.MustNewMetric(http_req_duration, Trend, Time)

lib/netext/httpext/tracer.go
  Tracer.Done()
  Duration = Sending + Waiting + Receiving

lib/netext/httpext/tracer.go
  Trail.SaveSamples()
  append sample:
    metric = HTTPReqDuration
    value  = Trail.Duration
```

Điểm quan trọng:

```text
http_req_duration không gồm blocked / connecting / tls_handshaking
nó chỉ gồm sending + waiting + receiving
```

Trong file demo chung, phần để nhìn ra value của `http_req_duration` là
`traceResponse()`.
Nó log `timings.duration` và tự cộng lại 3 phần:

```text
[metric-trace] endpoint=...
  sending=...
  waiting=...
  receiving=...
  duration=...
  sending+waiting+receiving=...
```

Nếu đọc một dòng log, bạn sẽ thấy `duration` gần bằng tổng:

```text
sending + waiting + receiving
```

Chênh lệch nhỏ nếu có thường do làm tròn số khi in ra.

Vì metric này là `Trend`, summary sẽ in các thống kê như:

```text
http_req_duration: avg=... min=... med=... max=... p(90)=... p(95)=...
```

##### `http_req_blocked`

`http_req_blocked` trả lời câu hỏi:

```text
trước khi request thật sự dùng được connection, k6 bị kẹt bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqBlocked: registry.MustNewMetric(http_req_blocked, Trend, Time)

lib/netext/httpext/tracer.go
  nếu có getConn và gotConn:
    Blocked = gotConn - getConn

Trail.SaveSamples()
  value = Trail.Blocked
```

`getConn` là mốc Go HTTP client bắt đầu lấy hoặc tạo connection.
`gotConn` là mốc đã có connection để dùng.
Vì vậy cách đọc an toàn là:

```text
http_req_blocked = thời gian từ lúc bắt đầu lấy/tạo connection
                   tới lúc có connection dùng được
```

Nó không phải thời gian server xử lý.
Nếu connection được reuse rất nhanh, giá trị này có thể rất nhỏ.

Trong file demo chung, phần làm `http_req_blocked` dễ hiện số là:

```js
noConnectionReuse: true
http_req_blocked: ["avg>=0"]
```

`noConnectionReuse: true` làm demo dễ thấy quá trình lấy/tạo connection hơn.
Threshold `avg>=0` chỉ để ép summary in ra metric:

```text
http_req_blocked
  'avg>=0' avg=...
```

##### `http_req_connecting`

`http_req_connecting` trả lời câu hỏi:

```text
tạo kết nối TCP mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqConnecting: registry.MustNewMetric(http_req_connecting, Trend, Time)

lib/netext/httpext/tracer.go
  nếu có connectStart và connectDone:
    Connecting = connectDone - connectStart

Trail.SaveSamples()
  value = Trail.Connecting
```

Nếu request dùng lại connection cũ, có thể không có mốc connect mới.
Khi đó `http_req_connecting` có thể bằng `0`.

Trong file demo chung, phần làm `http_req_connecting` dễ hiện số là:

```js
noConnectionReuse: true
http_req_connecting: ["avg>=0"]
```

Khi chạy sẽ thấy:

```text
http_req_connecting
  'avg>=0' avg=...
```

Và trong log từng request:

```text
connecting=...ms
```

##### `http_req_tls_handshaking`

`http_req_tls_handshaking` trả lời câu hỏi:

```text
bắt tay TLS của HTTPS mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqTLSHandshaking: registry.MustNewMetric(http_req_tls_handshaking, Trend, Time)

lib/netext/httpext/tracer.go
  nếu có tlsHandshakeStart và tlsHandshakeDone:
    TLSHandshaking = tlsHandshakeDone - tlsHandshakeStart

Trail.SaveSamples()
  value = Trail.TLSHandshaking
```

Metric này thường chỉ có ý nghĩa rõ với HTTPS.
Nếu là HTTP thường, hoặc connection HTTPS đã được reuse, giá trị có thể bằng `0`.

Trong file demo chung, phần làm `http_req_tls_handshaking` dễ hiện số là:

```js
noConnectionReuse: true
http_req_tls_handshaking: ["avg>=0"]
```

Demo dùng URL `https://quickpizza.grafana.com/api/status/...`, tức là HTTPS.
Vì vậy log có thể hiện:

```text
http_req_tls_handshaking
  'avg>=0' avg=...

[metric-trace] ... tls_handshaking=...ms
```

##### `http_req_sending`

`http_req_sending` trả lời câu hỏi:

```text
gửi request từ máy k6 lên server mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqSending: registry.MustNewMetric(http_req_sending, Trend, Time)

lib/netext/httpext/tracer.go
  khi wroteRequest != 0:
    nếu có tlsHandshakeDone:
      Sending = wroteRequest - tlsHandshakeDone
    nếu không có TLS nhưng có connectDone:
      Sending = wroteRequest - connectDone
    nếu không thì:
      Sending = wroteRequest - gotConn

Trail.SaveSamples()
  value = Trail.Sending
```

Với request `GET` body nhỏ, `http_req_sending` thường rất nhỏ.
Với upload body lớn, metric này mới dễ tăng rõ.

Trong file demo chung, phần để nhìn ra value của `http_req_sending` là:

```text
http_req_sending
  'avg>=0' avg=...

[metric-trace] ... sending=...ms
```

##### `http_req_waiting`

`http_req_waiting` trả lời câu hỏi:

```text
sau khi gửi request xong, chờ byte đầu tiên từ server mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqWaiting: registry.MustNewMetric(http_req_waiting, Trend, Time)

lib/netext/httpext/tracer.go
  nếu gotFirstResponseByte > wroteRequest:
    Waiting = gotFirstResponseByte - wroteRequest
  nếu server không trả byte nào:
    Waiting = done - wroteRequest

Trail.SaveSamples()
  value = Trail.Waiting
```

Đây là phần nhiều người hay nhìn khi muốn biết:

```text
server bắt đầu phản hồi chậm hay nhanh?
```

Nhưng phải nói cẩn thận:

```text
http_req_waiting không chỉ là CPU xử lý của server
nó còn có network latency và thời gian server chuẩn bị byte đầu tiên
```

Trong file demo chung, phần để nhìn ra value của `http_req_waiting` là:

```text
http_req_waiting
  'avg>=0' avg=...

[metric-trace] ... waiting=...ms
```

##### `http_req_receiving`

`http_req_receiving` trả lời câu hỏi:

```text
sau khi nhận byte đầu tiên, tải phần response còn lại mất bao lâu?
```

Trong core:

```text
metrics/builtin.go
  HTTPReqReceiving: registry.MustNewMetric(http_req_receiving, Trend, Time)

lib/netext/httpext/tracer.go
  nếu có gotFirstResponseByte:
    Receiving = done - gotFirstResponseByte

Trail.SaveSamples()
  value = Trail.Receiving
```

Nếu response rất nhỏ, giá trị này thường rất nhỏ.
Nếu response lớn hoặc mạng chậm, `http_req_receiving` có thể tăng.

Trong file demo chung, phần để nhìn ra value của `http_req_receiving` là:

```text
http_req_receiving
  'avg>=0' avg=...

[metric-trace] ... receiving=...ms
```

##### Vì sao demo log được các timing này?

Trong `lib/netext/httpext/request.go`, core copy chính các giá trị từ `Trail`
sang `response.timings`:

```text
response.timings.duration        <- Trail.Duration
response.timings.blocked         <- Trail.Blocked
response.timings.connecting      <- Trail.Connecting
response.timings.tls_handshaking <- Trail.TLSHandshaking
response.timings.sending         <- Trail.Sending
response.timings.waiting         <- Trail.Waiting
response.timings.receiving       <- Trail.Receiving
```

Vì vậy dòng log trong demo không phải tự bịa công thức.
Nó đang in lại chính những giá trị cùng nguồn với HTTP metrics.

#### 6.2.3 Demo chạy được: chứng minh từng định nghĩa trên

File demo:

```text
examples/http_metrics_types_demo.js
```

Chạy:

```bash
k6 run examples/http_metrics_types_demo.js
```

Nội dung chính của demo:

```js
import http from "k6/http";
import { check } from "k6";

export const options = {
  noConnectionReuse: true,
  scenarios: {
    http_metrics_types_demo: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "30s",
    },
  },
  thresholds: {
    http_reqs: ["count==6"],
    http_req_blocked: ["avg>=0"],
    http_req_connecting: ["avg>=0"],
    http_req_duration: ["avg>=0"],
    "http_req_failed{endpoint:status_200}": ["rate<0.01"],
    "http_req_failed{endpoint:status_500_default}": ["rate>0.99"],
    "http_req_failed{endpoint:status_500_expected}": ["rate<0.01"],
    http_req_receiving: ["avg>=0"],
    http_req_sending: ["avg>=0"],
    http_req_tls_handshaking: ["avg>=0"],
    http_req_waiting: ["avg>=0"],
  },
};

function ms(value) {
  return Number(value).toFixed(2);
}

function traceResponse(label, response) {
  const timings = response.timings;
  const recomputedDuration =
    timings.sending + timings.waiting + timings.receiving;

  console.log(
    [
      `[metric-trace] endpoint=${label}`,
      `status=${response.status}`,
      `blocked=${ms(timings.blocked)}ms`,
      `connecting=${ms(timings.connecting)}ms`,
      `tls_handshaking=${ms(timings.tls_handshaking)}ms`,
      `sending=${ms(timings.sending)}ms`,
      `waiting=${ms(timings.waiting)}ms`,
      `receiving=${ms(timings.receiving)}ms`,
      `duration=${ms(timings.duration)}ms`,
      `sending+waiting+receiving=${ms(recomputedDuration)}ms`,
    ].join(" "),
  );
}

export default function () {
  const ok = http.get("https://quickpizza.grafana.com/api/status/200", {
    tags: { endpoint: "status_200" },
  });

  const failByDefault = http.get("https://quickpizza.grafana.com/api/status/500", {
    tags: { endpoint: "status_500_default" },
  });

  const expected500 = http.get("https://quickpizza.grafana.com/api/status/500", {
    tags: { endpoint: "status_500_expected" },
    responseCallback: http.expectedStatuses(500),
  });

  traceResponse("status_200", ok);
  traceResponse("status_500_default", failByDefault);
  traceResponse("status_500_expected", expected500);

  check(
    ok,
    {
      "status_200 returns 200": (r) => r.status === 200,
    },
    { endpoint: "status_200" },
  );

  check(
    failByDefault,
    {
      "status_500_default returns 500": (r) => r.status === 500,
    },
    { endpoint: "status_500_default" },
  );

  check(
    expected500,
    {
      "status_500_expected returns 500": (r) => r.status === 500,
    },
    { endpoint: "status_500_expected" },
  );
}
```

Demo này cố tình làm rất nhỏ:

```text
iterations = 2
mỗi iteration gọi 3 HTTP request

request 1 -> https://quickpizza.grafana.com/api/status/200
request 2 -> https://quickpizza.grafana.com/api/status/500, dùng default expectedStatuses
request 3 -> https://quickpizza.grafana.com/api/status/500, nhưng khai báo expectedStatuses(500)

tổng HTTP request = 2 iterations * 3 request = 6 request
```

Khi chạy, demo còn in log theo từng response.
Mỗi dòng log là một request, và nó show trực tiếp các timing lấy từ
`response.timings`:

```text
[metric-trace] endpoint=status_200 status=200 blocked=560.50ms connecting=243.42ms tls_handshaking=259.86ms sending=0.00ms waiting=247.30ms receiving=0.00ms duration=247.30ms sending+waiting+receiving=247.30ms

[metric-trace] endpoint=status_500_default status=500 blocked=508.17ms connecting=250.92ms tls_handshaking=257.25ms sending=0.58ms waiting=251.40ms receiving=0.51ms duration=252.49ms sending+waiting+receiving=252.49ms

[metric-trace] endpoint=status_500_expected status=500 blocked=494.85ms connecting=247.03ms tls_handshaking=247.82ms sending=0.00ms waiting=246.34ms receiving=0.00ms duration=246.34ms sending+waiting+receiving=246.34ms
```

Số trên máy bạn sẽ khác.
Điều cần nhìn là cấu trúc:

```text
blocked
connecting
tls_handshaking
sending
waiting
receiving
duration
sending+waiting+receiving
```

Với mỗi dòng, `duration` phải gần bằng:

```text
sending + waiting + receiving
```

Đây chính là công thức core dùng cho `http_req_duration`.
Các metric timing còn lại cũng lấy từ cùng `response.timings`.

Kết quả cần nhìn:

Trong riêng nhóm HTTP, demo này thể hiện đủ các type thật sự có trong HTTP metrics:

```text
Counter -> http_reqs
Rate    -> http_req_failed
Trend   -> http_req_duration, http_req_waiting, http_req_sending...
Gauge   -> không có trong nhóm HTTP; Gauge thường thấy ở execution metrics như vus, vus_max
```

Ngoài ra, vì demo có gửi HTTP request nên phần `NETWORK` cũng có:

```text
data_sent, data_received
  = Counter có Contains là Data
  = cộng số byte, không phải cộng số request
```

```text
http_reqs
  = Counter
  = mỗi request append một sample value=1
  = chạy demo này kỳ vọng count=6

http_req_failed
  = Rate
  = mỗi request append một sample value=0 hoặc value=1
  = status 200 mặc định -> value=0
  = status 500 mặc định -> value=1
  = status 500 + expectedStatuses(500) -> value=0
  = chạy demo này kỳ vọng 2 failed / 6 request = 33.33%

http_req_duration, http_req_waiting, http_req_sending...
  = Trend
  = mỗi request append một value thời gian
  = summary in avg/min/med/max/p(90)/p(95)
```

Đoạn demo này chứng minh đúng định nghĩa core:

```text
status_200
  status trả về = 200
  default expected = 200..399
  expected_response=true
  http_req_failed value=0

status_500_default
  status trả về = 500
  default expected = 200..399
  expected_response=false
  http_req_failed value=1

status_500_expected
  status trả về = 500
  request tự khai báo responseCallback: http.expectedStatuses(500)
  expected_response=true
  http_req_failed value=0
```

Vậy người học sẽ thấy rõ:

```text
cùng là HTTP 500
nhưng một request fail, một request không fail
vì core dựa vào responseCallback để quyết định expected hay không
```

Khi chạy thành công, summary sẽ có dạng gần như sau. Số thời gian và số byte
của máy bạn có thể khác, nhưng cách đọc giống nhau.

Trước hết nhìn phần `THRESHOLDS`. Demo cố tình đặt threshold `avg>=0` cho các
metric thời gian để ép phần tổng kết in ra tên từng metric con. Đây không phải
quy tắc đánh giá hiệu năng thật, chỉ là mẹo để bài học dễ quan sát:

```text
THRESHOLDS
  http_req_blocked
    'avg>=0' avg=...

  http_req_connecting
    'avg>=0' avg=...

  http_req_duration
    'avg>=0' avg=...

  http_req_receiving
    'avg>=0' avg=...

  http_req_sending
    'avg>=0' avg=...

  http_req_tls_handshaking
    'avg>=0' avg=...

  http_req_waiting
    'avg>=0' avg=...

  http_req_failed{endpoint:status_200}
    'rate<0.01' rate=0.00%

  http_req_failed{endpoint:status_500_default}
    'rate>0.99' rate=100.00%

  http_req_failed{endpoint:status_500_expected}
    'rate<0.01' rate=0.00%

  http_reqs
    'count==6' count=6
```

Sau đó nhìn phần `TOTAL RESULTS`. Với k6 bản hiện tại, nhóm `HTTP` thường chỉ
in các dòng HTTP chính:

```text
HTTP
  http_req_duration..........: avg=... min=... med=... max=... p(90)=... p(95)=...
  http_req_failed............: 33.33% 2 out of 6
    { endpoint:status_200 }..........: 0.00%   0 out of 2
    { endpoint:status_500_default }..: 100.00% 2 out of 2
    { endpoint:status_500_expected }...: 0.00%   0 out of 2
  http_reqs..................: 6

NETWORK
  data_received..............: ...
  data_sent..................: ...
```

Bạn cũng có thể thấy dòng con theo system tag `expected_response`, ví dụ:

```text
http_req_duration
  { expected_response:true }...: avg=...
```

Tag này do `transport.measureAndEmitMetrics()` set sau khi chạy
`responseCallback(statusCode)`.
Nó cho biết request đó được k6 xem là response đúng kỳ vọng hay không.

Lưu ý quan trọng: trong demo này `checks` có thể vẫn là `100%`, dù
`http_req_failed` là `33.33%`.

Vì hai dòng đó trả lời hai câu hỏi khác nhau:

```text
http_req_failed
  = k6 hỏi: response này có thuộc nhóm status code expected không?
  = mặc định expected là 200..399, nhưng từng request có thể override bằng responseCallback
  = status 500 mặc định bị tính là failed
  = status 500 với expectedStatuses(500) không bị tính failed

checks
  = script của bạn hỏi: điều kiện mình tự viết có đúng không?
  = demo viết check cho cả hai request 500 là r.status === 500
  = server trả đúng 500 nên các check đó pass
```

Nói ngắn:

```text
HTTP 500 có thể làm http_req_failed tăng hoặc không tăng
tuỳ responseCallback của request đó
nhưng check vẫn pass nếu chính bạn đang kiểm tra "có đúng là 500 không"
```

Trong demo có thêm tag `endpoint`:

```js
tags: { endpoint: "status_200" }
tags: { endpoint: "status_500_default" }
tags: { endpoint: "status_500_expected" }
```

Tag này giúp tách metric theo endpoint:

```text
http_req_failed{endpoint:status_200}
  = chỉ nhìn request gọi /status/200
  = kỳ vọng rate gần 0

http_req_failed{endpoint:status_500_default}
  = chỉ nhìn request gọi /status/500 theo default callback
  = kỳ vọng rate gần 1

http_req_failed{endpoint:status_500_expected}
  = chỉ nhìn request gọi /status/500 nhưng tự khai báo expectedStatuses(500)
  = kỳ vọng rate gần 0
```

Đây là lý do demo đặt thresholds:

```js
thresholds: {
  http_reqs: ["count==6"],
  http_req_blocked: ["avg>=0"],
  http_req_connecting: ["avg>=0"],
  http_req_duration: ["avg>=0"],
  "http_req_failed{endpoint:status_200}": ["rate<0.01"],
  "http_req_failed{endpoint:status_500_default}": ["rate>0.99"],
  "http_req_failed{endpoint:status_500_expected}": ["rate<0.01"],
  http_req_receiving: ["avg>=0"],
  http_req_sending: ["avg>=0"],
  http_req_tls_handshaking: ["avg>=0"],
  http_req_waiting: ["avg>=0"],
}
```

Các thresholds này không phải để test hệ thống thật.
Chúng chỉ làm demo dễ đọc hơn:

```text
http_reqs count==6
  = xác nhận demo có đúng 6 request

http_req_failed{endpoint:status_200} rate<0.01
  = endpoint 200 không bị tính failed

http_req_failed{endpoint:status_500_default} rate>0.99
  = endpoint 500 mặc định bị tính failed

http_req_failed{endpoint:status_500_expected} rate<0.01
  = endpoint 500 có expectedStatuses(500) không bị tính failed

http_req_duration / waiting / sending / receiving / blocked / connecting / tls_handshaking avg>=0
  = các metric này là Trend nên có avg
  = avg thời gian không thể âm, nên threshold luôn pass
  = mục đích là bắt summary in ra tên metric và giá trị avg để người học nhìn thấy
```

`noConnectionReuse: true` cũng chỉ phục vụ bài học.
Nó yêu cầu k6 không tái sử dụng kết nối cũ, nên các metric như
`http_req_connecting` và `http_req_tls_handshaking` dễ có số khác 0 hơn.
Khi test thật, không nên bật/tắt option này tùy tiện nếu nó không phản ánh
cách client thật sử dụng kết nối.

### 6.3 Network metrics

Mục này là bytes trên network, không phải số request.
Trong summary, k6 thường nhóm chúng vào `NETWORK`.

Core chính:

```text
metrics/builtin.go
  -> register data_sent/data_received là Counter + Data

lib/netext/dialer.go
  -> Conn.Write cộng BytesWritten
  -> Conn.Read cộng BytesRead
  -> IOSamples() flush bytes thành sample DataSent/DataReceived

internal/js/runner.go
  -> gọi Dialer.IOSamples() ở cuối iteration
```

Đọc theo đời thường:

```text
data_sent
  = tổng bytes k6 đã gửi ra network trong iteration đó

data_received
  = tổng bytes k6 đã nhận về từ network trong iteration đó
```

Hai metric này là `Counter`, nhưng đơn vị không phải “số lần”.
Đơn vị là byte, nên summary sẽ hiện theo kiểu `kB`, `MB`, `kB/s`.

| Metric | Core định nghĩa/tính value như nào | Thực tế nên nói như nào | Khi số xấu thì nghĩ gì? |
| --- | --- | --- | --- |
| `data_sent` | `Conn.Write()` cộng số byte đã ghi vào `BytesWritten`, `IOSamples()` lấy số này ra rồi reset về `0`, sau đó emit sample `DataSent`. | Tổng bytes đã gửi đi trên socket. | Cao thì nghi request body lớn, nhiều request, headers nhiều, redirect/retry, hoặc TLS handshake có nhiều byte. |
| `data_received` | `Conn.Read()` cộng số byte đã đọc vào `BytesRead`, `IOSamples()` lấy số này ra rồi reset về `0`, sau đó emit sample `DataReceived`. | Tổng bytes đã nhận về trên socket. | Cao thì nghi response body lớn, nhiều response, headers nhiều, redirect/retry, hoặc traffic tải về lớn. |

Điểm quan trọng:

```text
data_sent/data_received không phải latency
không có p95/p99
không phải số request
```

Nó trả lời câu hỏi:

```text
trong giai đoạn test này, k6 đã bơm bao nhiêu byte lên/xuống network?
```

Vì value được flush ở cuối iteration, một sample network có thể là tổng bytes của nhiều HTTP request trong cùng iteration đó.

Trong file demo chung `examples/http_metrics_types_demo.js`, 3 lệnh `http.get()` trong `default function`
làm phát sinh traffic thật, nên summary sẽ có block `NETWORK`.

Ví dụ output:

```text
NETWORK
  data_received..............: 26 kB   5.8 kB/s
  data_sent..................: 12 kB   2.6 kB/s
```

Đọc là:

```text
data_received = tổng cộng nhận 26 kB
data_sent = tổng cộng gửi 12 kB
kB/s = tốc độ trung bình trong suốt thời gian test
```

Lưu ý:

```text
data_sent không chỉ là body
data_received không chỉ là response body
chúng là byte đã đi qua connection, nên headers và handshake bytes cũng có thể góp phần
```

Vì vậy nếu payload nhỏ mà `data_sent` vẫn khá lớn, đừng vội kết luận request body lớn.
Có thể do nhiều request, headers dài, reconnect, hoặc TLS handshake.

#### 6.3.1 Bằng chứng từ core

Trong core, `data_sent` và `data_received` không được sinh từ `http_req_*`.
Chúng đi qua `Dialer`:

```text
Conn.Write()
  -> tăng BytesWritten

Conn.Read()
  -> tăng BytesRead

Dialer.IOSamples()
  -> atomic.SwapInt64(BytesWritten, 0)
  -> atomic.SwapInt64(BytesRead, 0)
  -> emit sample DataSent/DataReceived
```

`internal/js/runner.go` gọi `u.Dialer.IOSamples(endTime, ctm, builtinMetrics)` ở cuối iteration.
Nghĩa là network metrics được flush theo nhịp iteration, không phải theo từng request riêng lẻ.

#### 6.3.2 Demo chạy được

Không cần file demo riêng.
Trong `examples/http_metrics_types_demo.js`, chính 3 request HTTP này tạo ra network traffic:

```js
const ok = http.get("https://quickpizza.grafana.com/api/status/200", {
  tags: { endpoint: "status_200" },
});

const failByDefault = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_default" },
});

const expected500 = http.get("https://quickpizza.grafana.com/api/status/500", {
  tags: { endpoint: "status_500_expected" },
  responseCallback: http.expectedStatuses(500),
});
```

Khi chạy demo đó, summary sẽ có `NETWORK`.
Hai dòng `data_sent/data_received` là kết quả phụ của cùng traffic HTTP ở trên.

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
