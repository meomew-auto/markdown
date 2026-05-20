# k6 metrics căn bản: metric types, built-in metrics, và cách core tính

Bài này là bài nền về `metrics` trong k6.

Mục tiêu:

```text
đọc được output k6
biết metric đó thuộc loại nào
biết vì sao nó in ra count/rate/avg/p95/min/max
biết metric đó nằm ở đâu trong core
biết khi nào nên tự tạo custom metric
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

Trong lúc test chạy, các module của k6 liên tục đẩy `Sample` vào metric.

Core định nghĩa `Sample` trong `metrics/sample.go`.
Hiểu ngắn:

```text
sample = một lần đo cụ thể
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

Ví dụ khi một request HTTP kết thúc, core có thể tạo nhiều sample cùng lúc:

```text
http_reqs              value=1
http_req_duration      value=117.55
http_req_waiting       value=80.20
http_req_sending       value=0.50
http_req_receiving     value=36.85
http_req_failed        value=0 hoặc 1
```

Cùng một request nhưng sinh ra nhiều metric khác nhau.

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
duration_seconds ~= count / rate
                 ~= 13 / 1.729617
                 ~= 7.52s
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
