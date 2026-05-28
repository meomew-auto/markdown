# Vòng đời VU trong k6: open model, closed model, và counters

Bài này là bài mở đầu cho chuỗi học k6. Mục tiêu là nhìn được bức tranh lớn trước:
VU là gì, ai quyết định lúc nào iteration mới được bắt đầu, lúc nào VU được tạo,
lúc nào được dùng, và các counter
`__VU` / `__ITER` / `exec.vu.*` thật sự nghĩa là gì.

## Mục lục nhanh

- [1. Bức tranh lớn](#1-bức-tranh-lớn)
- [1.1 VU là gì?](#11-vu-là-gì)
- [1.2 Iteration là gì?](#12-iteration-là-gì)
- [1.3 Executor là gì?](#13-executor-là-gì)
- [2. Hai mô hình tải](#2-hai-mô-hình-tải)
- [3. VU lifecycle trong core](#3-vu-lifecycle-trong-core)
- [4. Ba loại VU](#4-ba-loại-vu)
- [5. Slot và drop](#5-slot-và-drop)
- [6. JS variables gắn với VU lifecycle](#6-js-variables-gắn-với-vu-lifecycle)
- [7. Đọc tiếp bài nào](#7-đọc-tiếp-bài-nào)
- [References](#references)

## 1. Bức tranh lớn

### 1.1 VU là gì?

`VU` là viết tắt của `Virtual User`, tức là một người dùng ảo mà k6 dựng lên để chạy script.
Hiểu đúng thì VU không phải là một request HTTP, cũng không phải là một iteration.
VU gần với khái niệm một người thực thi ảo hơn: nó có ID riêng, runtime JS riêng, state riêng và có thể
chạy nhiều iteration liên tiếp.

Trong core, nó đi qua 2 hình dạng chính:

```text
InitializedVU = VU đã sẵn sàng nhưng còn đang chờ trong pool
ActiveVU      = VU đã được Activate() và đang chạy script
```

Nói rất đơn giản:

```text
1 VU = 1 người thực thi ảo
1 VU có thể chạy rất nhiều lần
1 VU có thể chờ việc, làm việc, rồi chờ tiếp
```

### 1.1.1 Những gì "sống cùng" một VU?

Khi nói một VU là một người thực thi ảo riêng, ý của nó không chỉ là có mỗi số ID.
Một VU còn mang theo một số state của riêng nó.

#### `__VU`

Đây là ID của VU trong instance k6 hiện tại.
Nếu máy này đang chạy VU số 1, 2, 3 thì trong script các VU đó sẽ thấy `__VU=1`, `2`, `3`.
Trong một số runtime tạm ngoài load, bạn cũng có thể gặp `__VU=0`; đó không phải load VU thật.

Hiểu ngắn:

```text
__VU = "tôi là VU số mấy trong process k6 này"
```

#### `exec.vu.idInInstance`

Đây là cách đọc cùng thông tin bằng API `k6/execution`.
Nó tương ứng với `__VU`, nhưng rõ nghĩa và hiện đại hơn khi bạn muốn đọc thêm các field khác của VU.
Lưu ý: `exec.vu.*` chỉ dùng được trong execution context, không dùng được ở init context.

Hiểu ngắn:

```text
exec.vu.idInInstance ~= __VU
```

#### `exec.vu.idInTest`

Đây là ID global trên toàn test.
Nếu test chạy nhiều instance thì `idInTest` dùng để phân biệt VU trên toàn bộ bài test, còn
`idInInstance` chỉ nói VU số mấy trong instance hiện tại.

Hiểu ngắn:

```text
idInInstance = ID cục bộ trên máy / process này
idInTest     = ID toàn cục trên toàn bài test
```

#### Cookies của VU

Mỗi VU có `cookie jar` riêng trong core. Khi tạo VU, runner tạo riêng một `cookiejar.New(nil)`
cho VU đó.

Ý nghĩa thực tế:

```text
cookie của VU 1 không tự chui sang VU 2
```

Nhưng có một caveat rất quan trọng:

```text
mặc định k6 reset cookie jar ở đầu mỗi iteration
```

Nghĩa là:

```text
cookie là state gắn với VU
nhưng nếu không bật noCookiesReset thì cùng một VU qua iteration mới vẫn bị làm sạch cookie jar
```

Chỉ khi bật:

```js
export const options = {
  noCookiesReset: true,
};
```

thì cookie của cùng một VU mới tiếp tục còn qua iteration sau.

#### Runtime JS / biến global của VU

Mỗi VU có runtime JS riêng. Core instantiate runtime mới cho từng VU, nên biến top-level của
script là bản riêng của từng VU, không phải một biến global dùng chung cho mọi VU.

Ví dụ:

```js
let counter = 0;

export default function () {
  counter += 1;
  console.log(`VU=${__VU} counter=${counter}`);
}
```

Nếu có 2 VU thì mỗi VU sẽ có `counter` riêng của nó.
Nó không phải một biến chung của cả test.

Hiểu ngắn:

```text
VU 1 có runtime riêng
VU 2 có runtime riêng
biến global top-level của mỗi VU là bản riêng
```

#### Log demo: nhìn các state này trong script như nào?

Ví dụ script:

```js
import exec from "k6/execution";

export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 2,
      iterations: 2,
    },
  },
};

let localCounter = 0;

export default function () {
  localCounter += 1;
  console.log(
    `vu=${__VU} idInInstance=${exec.vu.idInInstance} idInTest=${exec.vu.idInTest} ` +
      `iter=${__ITER} localCounter=${localCounter}`,
  );
}
```

Log có thể trông như này:

```text
vu=1 idInInstance=1 idInTest=1 iter=0 localCounter=1
vu=2 idInInstance=2 idInTest=2 iter=0 localCounter=1
vu=1 idInInstance=1 idInTest=1 iter=1 localCounter=2
vu=2 idInInstance=2 idInTest=2 iter=1 localCounter=2
```

Trong demo local một instance, `idInTest` có thể tình cờ trùng `idInInstance`.
Nó chỉ khác rõ khi bài test có nhiều instance.

Đọc log này như sau:

```text
VU 1 và VU 2 là hai người thực thi riêng
mỗi VU có localCounter riêng
lần đầu của mỗi VU đều thấy localCounter=1
lần thứ hai của chính VU đó mới tăng lên 2
```

Thứ tự log thực tế có thể khác, vì VUs chạy song song.
Nhưng ý nghĩa state riêng theo VU thì không đổi.

#### Log demo: cookie theo VU nhìn như nào?

Ví dụ:

```js
import http from "k6/http";

export const options = {
  noCookiesReset: true,
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 2,
    },
  },
};

export default function () {
  if (__ITER === 0) {
    http.get(`${__ENV.HTTPBIN_URL}/cookies/set?k=v`);
    console.log(`vu=${__VU} iter=${__ITER} set-cookie`);
  }

  if (__ITER === 1) {
    const res = http.get(`${__ENV.HTTPBIN_URL}/cookies`);
    console.log(`vu=${__VU} iter=${__ITER} cookies=${res.body}`);
  }
}
```

Ý nghĩa:

```text
cùng 1 VU
iteration 0 set cookie
iteration 1 đọc lại được cookie
```

Nếu bỏ `noCookiesReset: true`, thì kỳ vọng đó có thể không còn đúng vì cookie jar bị reset ở đầu
iteration mới.

Quay lại hình dung VU bằng một ví dụ đơn giản:

```js
executor: "constant-vus",
vus: 2,
duration: "10s",
```

Ở đây k6 tạo 2 VU. Hai VU đó không biến mất sau mỗi request.
Chúng sống suốt test và cứ chạy iteration mới khi có việc.

Một ví dụ khác:

```text
1 iteration có thể chứa 3 request HTTP
nhưng vẫn chỉ là 1 iteration
không phải 3 VU
```

### 1.2 Iteration là gì?

`iteration` là 1 vòng chạy của function chính, thường là `default()`.
Trong 1 iteration, script có thể làm nhiều việc: `http.get()`, `http.post()`, `check()`, `sleep()`
hoặc các thao tác khác. Vì vậy iteration không đồng nghĩa với request.

Ví dụ:

```js
export default function () {
  http.get("https://example.test/a");
  http.get("https://example.test/b");
  http.get("https://example.test/c");
}
```

Ở đây vẫn chỉ là 1 iteration, dù nó tạo ra 3 request.

Ví dụ nữa:

```js
export default function () {
  sleep(1);
}
```

`sleep(1)` làm iteration dài hơn, nhưng không làm tăng số VU.
Nó chỉ làm VU đó bận lâu hơn.

### 1.3 Executor là gì?

`executor` là chiến lược chạy load của một scenario.
Nếu VU là người thực thi ảo, thì executor là phần quyết định VU đó được dùng theo kiểu nào.

Nói ngắn:

```text
executor = cách k6 điều phối VU và iteration
```

Một scenario luôn có một executor. Ví dụ:

```js
export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
    },
  },
};
```

Ở đây:

```text
scenario name = smoke
executor type = constant-vus
vus = 2
duration = 10s
```

Executor trả lời các câu hỏi như:

```text
cần bao nhiêu VU?
VU chạy theo duration hay theo số iteration?
VU tự chạy vòng tiếp hay k6 bắt đầu iteration theo lịch thời gian?
có cần preAllocatedVUs / maxVUs không?
khi hết duration thì có chờ thêm theo `gracefulStop` để VU thoát khỏi iteration đang chạy không?
```

Vì vậy cùng một script `default()` nhưng đổi executor thì hành vi test đổi rất mạnh.

Ví dụ 1: cùng là `default()`, nhưng `constant-vus` giữ concurrency cố định:

```js
executor: "constant-vus",
vus: 10,
duration: "30s",
```

Hiểu là:

```text
10 VU cùng loop liên tục trong 30s
VU chạy xong iteration trước rồi mới chạy iteration sau
```

Ví dụ 2: `per-vu-iterations` lại chạy theo quota của từng VU:

```js
executor: "per-vu-iterations",
vus: 10,
iterations: 5,
```

Hiểu là:

```text
mỗi VU chạy đúng 5 iteration
tổng target = 10 * 5 = 50 iteration
```

Ví dụ 3: `constant-arrival-rate` lại cố bắt đầu iteration theo tốc độ khai báo:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
preAllocatedVUs: 20,
maxVUs: 50,
```

Hiểu là:

```text
k6 cố bắt đầu 100 iteration mỗi giây
VU chỉ là người thực thi để kịp nhận các mốc bắt đầu đó
```

Đến đây cần tách rõ 2 tầng:

```text
tầng config: bạn viết scenario trong file JS
tầng runtime: core biến scenario đó thành executor thật để chạy
```

Executor không phải VU. Executor cũng không phải iteration.
Executor là phần điều phối: nó quyết định lấy bao nhiêu VU, lúc nào bắt đầu, khi nào gọi
`RunOnce()`, và với arrival-rate thì lúc nào tạo mốc bắt đầu iteration.

Khi k6 bắt đầu một bài test, core không chạy thẳng `default()` ngay.
Nó đi qua một pipeline như sau:

```text
1. đọc options.scenarios
2. lấy từng scenario config
3. xem scenario đó khai báo executor type nào
4. gọi NewExecutor() để tạo executor Go tương ứng
5. chuẩn bị executionState và VU pool
6. chờ tới startTime của executor
7. tới giờ thì gọi executor.Run()
8. executor.Run() mới bắt đầu điều phối VU và iteration thật
```

Cắt nghĩa từng phần:

```text
scenario config
  = object bạn viết trong JS, ví dụ { executor: "constant-vus", vus: 2, duration: "10s" }

executor type
  = tên chiến lược chạy, ví dụ "constant-vus", "per-vu-iterations", "constant-arrival-rate"

NewExecutor()
  = bước core biến config thành executor object thật trong Go

startTime
  = độ trễ cấu hình trước khi scenario/executor bắt đầu execution phase
  = được tính sau khi init/setup đã xong, không phải đơn giản là wall-clock từ lúc bấm `k6 run`

executor.Run()
  = lúc executor bắt đầu làm việc thật: lấy VU, activate VU, chạy iteration, hoặc tạo slot
```

Nếu muốn nhìn cả luồng trong 1 hình duy nhất, có thể đọc như sau:

```text
test script
  -> options
      -> shortcut hoặc scenarios explicit
          -> scenario config
              -> executor type
                  -> NewExecutor()
                      -> Scheduler
                          -> execution plan
                              -> pool chung es.vus
                                  -> GetPlannedVU()
                                      -> Activate()
                                          -> ActiveVU
                                              -> RunOnce()
                                                  -> 1 iteration
```

Nhánh closed/open tách nhau ở đoạn executor điều phối:

```text
closed model
  executor giữ VU rồi để VU tự lặp:
  RunOnce() xong -> nếu còn việc thì start iteration tiếp

open model
  executor giữ VU trong pool nội bộ:
  tới slot mới -> TryRunIteration() -> VU rảnh nào nhận được thì mới RunOnce()
```

Vì vậy:

```text
script không nói trực tiếp "hãy tạo VU #1 chạy ngay"
script chỉ khai báo config
core mới là bên dựng executor, tính plan, lấy VU, rồi cho iteration chạy
```

`startTime` không phải slot. `startTime` chỉ trả lời câu hỏi:

```text
scenario này bắt đầu ở giây thứ mấy của test?
```

Nếu không khai báo `startTime`, giá trị mặc định là `0s`.
Nghĩa là scenario/executor bắt đầu ngay khi test bước vào execution phase.

```js
export const options = {
  scenarios: {
    login: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
      // không có startTime
    },
  },
};
```

Hiểu là:

```text
startTime = 0s
scheduler không phải chờ thêm
executor.Run() được gọi ngay khi execution phase bắt đầu
```

Còn `slot` chỉ xuất hiện trong arrival-rate executors và trả lời câu hỏi:

```text
iteration tiếp theo phải được start vào mốc thời gian nào?
```

Ví dụ:

```js
export const options = {
  scenarios: {
    login: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
      startTime: "5s",
    },
  },
};
```

Đọc theo core:

```text
scenario name = login
executor type = constant-vus
scheduler tạo ConstantVUs executor
scheduler không chạy nó ngay
scheduler chờ tới giây thứ 5 của test
đến giây thứ 5 -> gọi executor.Run()
```

Sau khi vào `executor.Run()`, mỗi executor tự có luật riêng.

Với closed model như `per-vu-iterations`:

```text
executor.Run()
  -> GetPlannedVU()
  -> Activate()
  -> RunOnce()
  -> RunOnce()
  -> ReturnVU()
```

Nghĩa là executor lấy VU đã chuẩn bị sẵn, activate VU đó, rồi cho nó chạy đủ số iteration.

Với open model như `constant-arrival-rate`:

```text
executor.Run()
  -> lấy preAllocatedVUs
  -> Activate thành `ActiveVU` wrapper rồi đưa vào pool nội bộ
  -> chưa nhất thiết làm counter active tăng theo nghĩa "đang chạy RunOnce()" ngay tại bước này
  -> tính tickerPeriod từ rate/timeUnit
  -> tới từng slot thì gọi TryRunIteration()
  -> thiếu VU rảnh thì ghi dropped_iterations
  -> nếu còn quota thì xin tạo thêm unplanned VU
```

Nghĩa là scheduler không tự tạo từng slot. Scheduler chỉ gọi `executor.Run()` ở đúng thời điểm.
Việc tạo slot, chạy VU, drop iteration, hoặc xin unplanned VU là logic nằm bên trong
arrival-rate executor.

Điểm quan trọng nhất của bài này:

Trước khi tách `closed model` và `open model`, hãy giữ một câu hỏi chính:

```text
k6 bắt đầu iteration mới khi nào?
```

Trong bài này, "bắt đầu iteration mới" nghĩa là:

```text
k6 lấy 1 VU rảnh
  -> bảo VU đó chạy thêm 1 lần default() hoặc function được chỉ định
```

Ví dụ trong open model, nếu cấu hình:

```text
rate = 4
timeUnit = 1s
```

thì hiểu nôm na là:

```text
mỗi giây k6 cố bắt đầu khoảng 4 iteration mới
tức khoảng 250ms lại có 1 thời điểm k6 muốn bắt đầu iteration
```

Việc "bắt đầu iteration mới" không phải là latency.
Latency trả lời "một việc mất bao lâu".
Ở đây ta đang hỏi "khi nào việc mới được bắt đầu".

Việc "bắt đầu iteration mới" cũng không phải lúc nào cũng bằng dòng `iterations/s`
trong kết quả tổng kết.
`iterations/s` là số iteration đã hoàn thành mỗi giây.
Còn đoạn này đang nói về cách iteration được bắt đầu.
Với run ổn định và kéo đủ lâu, hai con số này thường gần nhau.
Nhưng ở lúc mới bắt đầu, lúc dừng test, hoặc khi có iteration bị bỏ qua / bị ngắt, chúng có thể lệch nhau.

```text
closed model = iteration tiếp theo bắt đầu khi có VU vừa chạy xong và rảnh
open model   = iteration tiếp theo bắt đầu theo lịch thời gian của executor
```

## 2. Hai mô hình tải

### 2.1 Closed model

Muốn hiểu closed model, trước hết hỏi:

```text
iteration tiếp theo bắt đầu khi nào?
```

Với closed model, câu trả lời là:

```text
khi có VU vừa chạy xong iteration trước và đang rảnh
```

Nói cách khác, k6 không đặt sẵn một lịch kiểu:

```text
cứ mỗi 250ms phải bắt đầu 1 iteration mới
```

Thay vào đó, mỗi VU tự chạy theo vòng lặp:

```text
bắt đầu 1 iteration
  -> chạy script
  -> iteration xong
  -> nếu scenario vẫn còn việc thì bắt đầu iteration tiếp theo
```

Vì vậy, trong closed model, thời điểm bắt đầu iteration tiếp theo phụ thuộc vào
tốc độ VU hoàn thành iteration trước đó.
Iteration chạy nhanh thì VU rảnh sớm và bắt đầu vòng tiếp theo sớm.
Iteration chạy chậm thì VU bận lâu hơn và bắt đầu vòng tiếp theo muộn hơn.

Nói ngắn:

```text
closed model = VU chạy xong iteration trước thì mới bắt đầu iteration sau
```

Các executor dưới đây thuộc nhóm closed model vì chúng đều dựa trên VU đang chạy vòng lặp,
quota iteration, hoặc số VU theo thời gian.
Chúng không tạo iteration mới bằng một lịch thời gian cố định từ `rate/timeUnit`:

```text
constant-vus
ramping-vus
per-vu-iterations
shared-iterations
```

Ví dụ:

```js
executor: "constant-vus",
vus: 10,
duration: "30s",
```

Ở ví dụ này, k6 không nhận cấu hình kiểu:

```text
mỗi giây phải bắt đầu đúng 10 iteration
```

Nó chỉ nhận cấu hình:

```text
giữ 10 VU chạy trong 30 giây
```

Hình dung 10 VU giống 10 người làm việc song song.
Trong 30 giây đó, mỗi VU chạy theo vòng lặp:

```text
VU nhận việc
  -> chạy 1 iteration
  -> iteration xong
  -> VU lại nhận iteration tiếp theo
```

Nên nếu số VU giữ nguyên, iteration càng lâu thì mỗi VU hoàn thành được càng ít việc trong 1 giây.
Công thức gần đúng khi script ổn định là:

```text
iterations/s ~= vus / W
```

Cắt nghĩa:

```text
vus
  = số VU đang chạy vòng lặp

W
  = thời gian trung bình để 1 VU chạy xong 1 iteration
  = gần với avg iteration_duration nếu run ổn định

iterations/s
  = số iteration hoàn thành mỗi giây của cả scenario
```

Ví dụ nếu iteration trung bình mất 1 giây:

```text
vus = 10
W = 1s

=> iterations/s ~= 10 / 1
=> iterations/s ~= 10
```

Nghĩa là 10 VU, mỗi VU khoảng 1 giây xong 1 vòng, thì cả scenario hoàn thành khoảng 10 iteration mỗi giây.

Bây giờ giả sử server chậm hơn, cùng 10 VU nhưng mỗi iteration mất 2 giây:

```text
vus = 10
W = 2s

=> iterations/s ~= 10 / 2
=> iterations/s ~= 5
```

Nghĩa là vẫn 10 VU đó, nhưng mỗi VU phải mất 2 giây mới xong 1 vòng, nên cả scenario chỉ hoàn thành khoảng 5 iteration mỗi giây.

Đến đây mới nên nói chữ `throughput`.
`Throughput` chỉ có nghĩa rõ khi nói kèm đơn vị:

```text
throughput của cái gì?
hoàn thành bao nhiêu cái mỗi giây?
```

Trong k6, các dòng kết quả tổng kết thường gặp là:

```text
iterations/s
  = số iteration hoàn thành mỗi giây

http_reqs/s
  = số HTTP request hoàn thành mỗi giây
  = RPS nếu đang nói riêng về HTTP request

TPS nghiệp vụ
  = số transaction nghiệp vụ hoàn thành mỗi giây
  = chỉ bằng iterations/s nếu bạn thiết kế 1 iteration đúng bằng 1 luồng nghiệp vụ
```

Core cũng tách các metric này riêng.
Trong `metrics/builtin.go`, `iterations`, `iteration_duration`, `http_reqs` là các built-in metric khác nhau.
Vì vậy không nên đọc `iteration_duration` rồi gọi ngay là TPS, và cũng không nên gọi `http_reqs/s` là TPS nếu một transaction của bạn gồm nhiều request.

Nếu mỗi iteration gọi 2 HTTP request, thì từ ví dụ `W = 1s` ở trên:

```text
iterations/s ~= 10

http_reqs/s ~= iterations/s * 2
http_reqs/s ~= 10 * 2
http_reqs/s ~= 20
```

Nếu server chậm hơn làm `iterations/s` còn khoảng 5:

```text
http_reqs/s ~= 5 * 2
http_reqs/s ~= 10
```

Nếu bạn định nghĩa 1 iteration là 1 luồng nghiệp vụ, ví dụ:

```text
login
search pizza
logout
```

thì khi `iterations/s ~= 10`:

```text
TPS nghiệp vụ ~= 10 transaction/s
```

còn khi `iterations/s ~= 5`:

```text
TPS nghiệp vụ ~= 5 transaction/s
```

Vậy câu đúng nên hiểu là:

```text
trong closed model, k6 không ép sẵn số iteration cần bắt đầu mỗi giây từ bên ngoài
VU tự chạy vòng lặp
iteration lâu hơn thì số iteration hoàn thành mỗi giây thường giảm
iteration nhanh hơn thì số iteration hoàn thành mỗi giây thường tăng
```

So với JMeter cũng phải cẩn thận.
Trong JMeter, cột `Throughput` của `Aggregate Report` là throughput của sample đang nhìn.
Nếu sample là `HTTP Request`, nó gần nghĩa `RPS`.
Nếu sample là `Transaction Controller` và bạn bật generated sample cho cả luồng, nó gần nghĩa `TPS nghiệp vụ`.
Trong k6 cũng vậy: phải nói rõ bạn đang nhìn `http_reqs/s`, `iterations/s`, hay custom metric cho transaction nghiệp vụ.

Ví dụ cụ thể:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 2,
```

Ở đây mỗi VU sẽ tự chạy 2 iteration, rồi trả về pool. Tổng số iteration là 6.

Một ví dụ khác:

```js
executor: "shared-iterations",
vus: 3,
iterations: 10,
```

Ở đây 10 iteration là của **kho iteration chung của scenario**. VU nào rảnh trước thì lấy việc trước.
Số iteration không bị chia đều cứng cho từng VU.

### 2.2 Open model

Muốn hiểu open model, cũng hỏi cùng một câu:

```text
iteration tiếp theo bắt đầu khi nào?
```

Với open model, câu trả lời là:

```text
khi tới thời điểm mà executor đã lên lịch trước
```

Nói cách khác, open model không để VU tự quyết định lúc nào có việc mới.
Executor tính trước các mốc thời gian cần bắt đầu iteration.
Đến mỗi mốc đó, k6 cố lấy một VU đang rảnh để chạy iteration mới.

Một mốc như vậy gọi là `slot` trong bài này:

```text
slot = một thời điểm đã được lên lịch để bắt đầu 1 iteration
```

Ví dụ:

```text
rate = 4
timeUnit = 1s
```

Đây là ví dụ kiểu `constant-arrival-rate` local run đơn giản. Khi đó trong 1 giây, executor muốn
có khoảng 4 lần bắt đầu iteration:

```text
0.00s -> mốc 1
0.25s -> mốc 2
0.50s -> mốc 3
0.75s -> mốc 4
```

Điểm quan trọng là:

```text
tới mốc đó phải có VU rảnh ngay
```

Nếu có VU rảnh, mốc đó chạy được:

```text
mốc đến hạn
  -> có VU rảnh
  -> VU bắt đầu 1 iteration
```

Nếu không có VU rảnh, mốc đó không được dời sang lúc sau:

```text
mốc đến hạn
  -> không có VU rảnh
  -> iteration ở mốc này bị bỏ qua
  -> k6 tăng dropped_iterations
```

Đây là điểm khác closed model.
Closed model có thể chậm lại vì nó đợi VU xong rồi mới bắt đầu vòng sau.
Open model thì các mốc thời gian vẫn tiếp tục chạy, dù VU đang bận.

Core của arrival-rate executor cũng đi theo ý này:

```text
tới mốc thời gian
  -> gọi TryRunIteration()
  -> nếu pool VU nhận được việc: chạy iteration
  -> nếu pool VU không nhận được việc: ghi dropped_iterations
```

Nếu còn quyền tạo thêm VU, k6 có thể khởi tạo thêm unplanned VU ở nền.
Nhưng VU mới đó không cứu lại mốc vừa bị bỏ qua.
Nó chỉ có thể giúp các mốc sau, sau khi VU đó khởi tạo xong.

Các executor thường gặp trong nhóm open model:

```text
constant-arrival-rate
ramping-arrival-rate
```

`constant-arrival-rate` giữ tốc độ bắt đầu iteration gần như cố định:

```text
rate = 100
timeUnit = 1s

=> k6 cố bắt đầu khoảng 100 iteration mỗi giây
```

`ramping-arrival-rate` cũng là open model, nhưng tốc độ đó thay đổi theo stage:

```text
giai đoạn đầu: 10 iteration/s
giai đoạn sau: tăng dần lên 100 iteration/s
giai đoạn cuối: giảm dần xuống 0
```

Ví dụ với `constant-arrival-rate`:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
preAllocatedVUs: 10,
maxVUs: 50,
```

Đọc từng dòng:

```text
rate: 100
  = số iteration k6 muốn bắt đầu trong mỗi timeUnit

timeUnit: "1s"
  = khoảng thời gian dùng để hiểu rate

rate: 100 + timeUnit: "1s"
  = cố bắt đầu khoảng 100 iteration mỗi giây

preAllocatedVUs: 10
  = chuẩn bị sẵn 10 VU từ đầu để nhận việc

maxVUs: 50
  = nếu thiếu VU, k6 được phép tạo thêm, nhưng tổng không vượt quá 50
```

Lưu ý: `rate: 100` không có nghĩa là 100 VU.
Nó cũng không đảm bảo chắc chắn có 100 iteration hoàn thành mỗi giây.
Nó chỉ nói rằng executor cố bắt đầu 100 iteration mỗi giây.
Muốn chạy được đủ, tại từng mốc bắt đầu phải có VU rảnh.

Ví dụ để thấy `slot` rõ hơn:

```js
executor: "constant-arrival-rate",
rate: 4,
timeUnit: "1s",
preAllocatedVUs: 1,
maxVUs: 1,
```

Ở đây k6 muốn bắt đầu khoảng 4 iteration mỗi giây.
Một giây có 1000ms, chia cho 4 mốc thì khoảng 250ms có một mốc:

```text
1000ms / 4 = 250ms
```

Giả sử chỉ có 1 VU và 1 iteration mất khoảng `400ms`, thì:

```text
0.00s -> mốc 1 đến hạn, VU rảnh -> chạy iteration 1
0.25s -> mốc 2 đến hạn, VU vẫn bận -> bỏ qua mốc 2, tăng dropped_iterations
0.40s -> VU rảnh lại, nhưng mốc 2 đã qua rồi, k6 không chạy bù mốc 2
0.50s -> mốc 3 đến hạn, VU rảnh -> slot/mốc 3 chạy được
0.75s -> mốc 4 đến hạn, VU vẫn bận -> bỏ qua mốc 4, tăng dropped_iterations
```

Đây là khác biệt quan trọng:

```text
closed model: VU còn bận thì iteration sau chưa bắt đầu
open model: tới mốc đã lên lịch thì k6 vẫn cố bắt đầu iteration mới
```

### 2.3 Một câu nhớ nhanh

```text
closed model = VU xong việc thì mới bắt đầu việc tiếp theo
open model   = tới thời điểm đã lên lịch thì k6 cố bắt đầu việc mới
```

## 3. VU lifecycle trong core

Core chia vòng đời VU thành 3 pha dễ đọc:

```text
1. Scheduler Init phase
2. Execution phase
3. Teardown / shutdown
```

### 3.1 Scheduler Init phase

Ở pha init, scheduler nhìn toàn execution plan rồi tính số VU cần chuẩn bị.

```go
vusToInitialize := lib.GetMaxPlannedVUs(executionPlan)
```

`GetMaxPlannedVUs()` lấy mức planned VU lớn nhất ở bất kỳ thời điểm nào của execution plan,
nhưng cần hiểu đúng chữ "execution plan".

Core không lấy riêng từng scenario rồi chọn max đơn lẻ.
Trước đó, `ScenarioConfigs.GetFullExecutionRequirements()` đã gom các yêu cầu VU của tất cả
scenario theo thời gian:

```text
1. mỗi scenario tự khai báo nó cần bao nhiêu planned VU ở từng mốc thời gian
2. core cộng thêm startTime của scenario vào các mốc đó
3. core đi theo trục thời gian của cả bài test
4. tại mỗi thời điểm, scenario nào đang cần VU thì cộng vào tổng planned VU hiện tại
5. sau đó GetMaxPlannedVUs() lấy mức tổng planned VU lớn nhất
```

Nói đời thường:

```text
k6 cộng các scenario chạy đồng thời ở cùng thời điểm
rồi lấy thời điểm nào cần nhiều VU nhất để chuẩn bị trước
```

Vì vậy câu "không phải cứ có nhiều scenario là cộng dồn hết" phải hiểu là:

```text
không cộng tất cả scenario của cả bài test bất kể chúng có chạy cùng lúc hay không
```

Nhưng nếu nhiều scenario chạy chồng thời gian lên nhau, thì k6 có cộng.

Các ví dụ 1, 2, 3 dưới đây đang **cố ý bỏ qua `gracefulStop`** để dễ nhìn ý chính.
Nếu giữ default `gracefulStop: 30s`, execution plan thật có thể dài hơn phần `duration` viết trong
ví dụ, nên mốc overlap cũng sẽ khác.

Ví dụ 1: hai scenario chạy cùng lúc

```text
scenario A: 10 VU, startTime = 0s, duration = 30s
scenario B: 20 VU, startTime = 0s, duration = 30s

từ 0s đến 30s:
  tổng planned VU = 10 + 20 = 30

=> k6 cần chuẩn bị 30 planned VU
```

Ví dụ 2: hai scenario không chạy chồng lên nhau

```text
scenario A: 10 VU, startTime = 0s,  duration = 30s
scenario B: 20 VU, startTime = 40s, duration = 30s

từ 0s đến 30s:
  tổng planned VU = 10

từ 30s đến 40s:
  tổng planned VU = 0

từ 40s đến 70s:
  tổng planned VU = 20

=> mức cao nhất là 20
=> k6 không cần chuẩn bị 10 + 20 = 30 planned VU
```

Ví dụ 3: hai scenario chỉ chồng một đoạn

```text
scenario A: 10 VU, startTime = 0s,  duration = 30s
scenario B: 20 VU, startTime = 20s, duration = 30s

từ 0s đến 20s:
  tổng planned VU = 10

từ 20s đến 30s:
  tổng planned VU = 10 + 20 = 30

từ 30s đến 50s:
  tổng planned VU = 20

=> mức cao nhất là 30
=> k6 chuẩn bị 30 planned VU
```

Muốn đúng tuyệt đối theo core trong các ví dụ kiểu "không overlap", hãy hiểu ngầm là:

```text
gracefulStop = 0s
```

Sau đó scheduler tạo VU và đẩy vào pool chung:

```text
Scheduler.initVU()
  -> Runner.NewVU()
  -> ExecutionState.AddInitializedVU()
  -> es.vus
```

Đây là ý chính:

```text
planned VU = VU đã được init sẵn và đang chờ trong pool
```

Lưu ý quan trọng:

```text
planned VU chưa phải active VU
planned VU chỉ là VU đã sẵn sàng
```

### 3.2 Execution phase

Execution phase là lúc executor bắt đầu dùng VU thật.
Trước pha này, planned VU chỉ mới được tạo sẵn và nằm chờ trong pool.

Khi executor cần một VU, luồng cơ bản là:

```text
GetPlannedVU()
  -> lấy 1 VU đã init sẵn ra khỏi pool

Activate()
  -> biến VU đó thành VU có đủ ngữ cảnh để chạy scenario hiện tại

RunOnce()
  -> chạy 1 iteration

ReturnVU()
  -> trả VU về lại pool khi executor không dùng nó nữa
```

Không nên hiểu `Activate()` là "VU bắt đầu chạy ngay lập tức" trong mọi executor.
Nó có nghĩa là:

```text
VU này đã được executor mượn ra
VU này được gắn ngữ cảnh chạy, bộ đếm iteration, và hàm trả VU của scenario hiện tại
VU này đã sẵn sàng để chạy iteration theo logic của executor
```

Với các executor kiểu đơn giản như `constant-vus`, `per-vu-iterations`,
`shared-iterations`, flow thường dễ nhìn như sau:

```text
GetPlannedVU()
  -> Activate()
  -> RunOnce() x N tùy executor
  -> ReturnVU()
```

Nghĩa là VU được mượn ra, có thể chạy một hay nhiều lần `RunOnce()` tùy executor, rồi khi
executor xong việc với VU đó thì mới trả lại.

Với arrival-rate executor thì khác một chút:

```text
GetPlannedVU()
  -> Activate()
  -> đưa VU vào pool nội bộ `activeVUPool` của arrival-rate executor
  -> tới từng mốc thời gian thì TryRunIteration()
  -> nếu VU đó nhận việc thì mới chạy RunOnce()
```

Vì vậy cần tách 2 cách nói:

```text
ActiveVU trong code
  = VU đã qua Activate(), có đủ thông tin để chạy trong scenario hiện tại

counter GetCurrentlyActiveVUsCount()
  = số VU hiện đang thực thi script test
  = cũng tính cả VU đã nhận lệnh dừng nhưng vẫn chưa thoát khỏi RunOnce()
```

Đoạn "đã nhận lệnh dừng nhưng vẫn chưa thoát khỏi RunOnce()" nghĩa là:

```text
test/scenario đã đến lúc dừng
nhưng VU đang ở giữa một iteration
k6 không coi VU đó là rảnh ngay lập tức
VU đó còn phải kết thúc iteration đang chạy, hoặc bị context interrupt
sau đó counter active VU mới giảm
```

Nó không có nghĩa là VU đang ngồi chờ việc trong pool.
VU ngồi chờ trong pool là initialized VU, không phải VU đang chạy script.

Nhìn bằng timeline đời thường:

```text
VU được init xong
  -> nằm trong pool chung, chưa chạy script
  -> executor mượn ra bằng GetPlannedVU()
  -> executor Activate() VU cho scenario hiện tại
  -> VU chạy iteration khi executor yêu cầu
  -> executor không cần VU đó nữa
  -> context của activation kết thúc
  -> callback gọi ReturnVU()
  -> VU quay lại pool và có thể được executor của scenario khác mượn lại
```

Vậy sau khi active thì VU có về pool không?
Có, nhưng phải nói chính xác:

```text
VU về lại pool khi executor gọi ReturnVU()
```

Trong core, `ReturnVU()` thật nằm ở `lib/execution.go`:

```go
func (es *ExecutionState) ReturnVU(vu InitializedVU, wasActive bool) {
	es.vus <- vu
	if wasActive {
		es.ModCurrentlyActiveVUsCount(-1)
	}
}
```

Dòng quan trọng là:

```text
es.vus <- vu
```

Nghĩa là VU được đẩy lại vào channel pool chung `es.vus`.
Sau đó executor khác, ví dụ executor của scenario khác, gọi `GetPlannedVU()` thì có thể lấy lại VU này.

Nhưng `ReturnVU()` thường không được gọi trực tiếp sau mỗi `RunOnce()`.
Luồng trong core là:

```text
executor tạo returnVU callback
  -> truyền callback đó vào Activate()
  -> Activate() gắn callback vào context của VU
  -> khi context đó kết thúc
  -> callback được gọi
  -> callback gọi ExecutionState.ReturnVU()
```

Chỗ gắn callback nằm trong `internal/js/runner.go`, trong `Activate()`:

```text
context của VU kết thúc
  -> interrupt JS runtime nếu VU đang chạy
  -> chờ VU không còn busy
  -> gọi DeactivateCallback
```

`DeactivateCallback` chính là `returnVU` mà executor truyền vào.

Không nên hiểu là:

```text
cứ chạy xong 1 iteration là VU chắc chắn về pool chung ngay
```

Với nhiều executor, executor mượn VU ra rồi giữ VU đó để chạy nhiều iteration.
Khi executor không còn việc gì cần VU đó nữa, nó mới trả VU về pool.
Vì vậy việc trả VU về pool phụ thuộc executor đang chạy theo kiểu nào, không phụ thuộc riêng
vào việc "một iteration vừa chạy xong".

Nói ngắn:

```text
xong 1 iteration
  -> chưa chắc về pool chung

executor hết việc với VU đó
  -> mới ReturnVU()
  -> VU về pool chung
```

Các executor thường gặp:

| Executor | Có trả về pool chung sau mỗi iteration không? | Khi nào VU quay lại pool chung? | Vị trí code |
|---|---|---|---|
| `constant-vus` | Không | Khi hết `duration`, hoặc context bị hủy | `lib/executor/constant_vus.go` |
| `per-vu-iterations` | Không theo từng iteration | Khi VU chạy đủ quota `iterations` của chính nó, hoặc scenario bị dừng sớm | `lib/executor/per_vu_iterations.go` |
| `shared-iterations` | Không theo từng iteration | Khi kho iteration chung của scenario không còn iteration nào để VU lấy, hoặc scenario bị dừng sớm | `lib/executor/shared_iterations.go` |
| `ramping-vus` | Không | Khi stage giảm số VU cần chạy, hoặc executor kết thúc | `lib/executor/ramping_vus.go`, `lib/executor/vu_handle.go` |
| `constant-arrival-rate` | Không | Khi arrival-rate executor kết thúc; trong lúc chạy, VU nằm trong pool nội bộ của executor | `lib/executor/constant_arrival_rate.go` |
| `ramping-arrival-rate` | Không | Khi ramping-arrival-rate executor kết thúc; trong lúc chạy, VU nằm trong pool nội bộ của executor | `lib/executor/ramping_arrival_rate.go` |

Trường hợp dễ gây nhầm:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 1,
```

Ở đây mỗi VU chỉ có 1 iteration phải chạy.
Nên nhìn ngoài có vẻ:

```text
xong 1 iteration là trả VU về pool
```

Nhưng lý do thật là:

```text
VU đã chạy xong quota được giao
executor không cần giữ VU đó nữa
=> ReturnVU()
```

Nếu đổi thành:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 5,
```

thì mỗi VU sẽ chạy đủ 5 iteration rồi mới trả về pool chung.

Ví dụ với `constant-vus`:

```text
GetPlannedVU()
  -> Activate()
  -> VU loop nhiều iteration trong duration
  -> hết duration thì ReturnVU()
  -> VU quay lại pool chung
```

Ví dụ với `per-vu-iterations`:

```text
GetPlannedVU()
  -> Activate()
  -> VU chạy đủ số iteration của nó
  -> chạy xong quota thì ReturnVU()
  -> VU quay lại pool chung
```

Với arrival-rate executor, còn có thêm một lớp nữa:

```text
GetPlannedVU()
  -> Activate()
  -> VU được đưa vào pool nội bộ của arrival-rate executor
  -> mỗi slot đến thì VU rảnh trong pool nội bộ nhận iteration
  -> khi executor kết thúc thì ReturnVU() về pool chung
```

Nói ngắn:

```text
pool chung của k6
  = nơi giữ VU đã init nhưng chưa được executor nào mượn

pool nội bộ của arrival-rate executor
  = nơi giữ VU đã được executor mượn, đã Activate(), nhưng đang chờ slot tiếp theo
```

Nếu chỉ có 1 scenario thì sao?
Khi đó vẫn có pool chung, nhưng thường không có scenario khác để mượn lại ngay.
VU được trả về pool khi executor của chính scenario đó dùng xong.

Ví dụ chỉ có 1 scenario `constant-vus`:

```text
scenario A: constant-vus, vus = 2, duration = 30s

0s:
  executor của A lấy VU #1 và VU #2 từ pool chung

0s -> 30s:
  VU #1 và VU #2 ở trong executor của A
  mỗi VU tự chạy nhiều iteration
  xong iteration này thì chạy iteration tiếp theo
  chưa trả về pool chung sau từng iteration

30s:
  scenario hết duration
  executor của A không cần 2 VU đó nữa
  callback gọi ReturnVU()
  VU #1 và VU #2 quay lại pool chung
```

Nếu bài test chỉ có đúng scenario A và không còn scenario nào sau đó, VU quay lại pool rồi test kết thúc.
Việc "quay lại pool" lúc này chủ yếu là bước dọn trạng thái đúng trong core.

Nếu có scenario khác chạy sau đó thì sao?
Lúc này reuse mới dễ thấy:

```text
VU #1 đang được executor của scenario A dùng
executor của scenario A xong thì VU #1 được trả lại pool
sau đó executor của scenario B có thể mượn lại chính VU #1
```

Điều kiện là executor của scenario B phải cần VU sau khi VU #1 đã quay lại pool.
Nếu scenario B bắt đầu trong lúc executor của scenario A vẫn đang giữ VU #1,
thì B không mượn được VU #1.
Khi hai scenario chạy chồng nhau, execution plan đã tính tổng VU cần ở đoạn chồng đó,
nên executor của B sẽ lấy VU khác từ pool chung nếu pool còn VU.

Ví dụ reuse được:

```text
scenario A: 10 VU, chạy từ 0s đến 30s
scenario B: 5 VU,  bắt đầu từ 40s

30s: A trả VU về pool
40s: B bắt đầu và có thể lấy lại một số VU vừa được A trả về
```

Ví dụ không reuse được ngay:

```text
scenario A: 10 VU, chạy từ 0s đến 30s
scenario B: 5 VU,  bắt đầu từ 10s

từ 10s đến 30s:
  A vẫn đang giữ 10 VU
  B cần thêm 5 VU khác
  B không lấy được VU đang active của A
```

Core còn có counter riêng cho việc này:

- `GetInitializedVUsCount()` = tổng VU đã được tạo xong
- `GetCurrentlyActiveVUsCount()` = VU đang bận trong `RunOnce()`, kể cả lúc đã nhận lệnh dừng nhưng chưa thoát khỏi iteration

### 3.3 VU có thể được tạo hết lúc init không?

Có, nhưng chỉ với phần `planned VUs`.

Nói kỹ hơn:

```text
closed model
  -> thường init đủ planned VUs trước khi execution phase bắt đầu

open model
  -> init trước phần chắc chắn cần dùng
  -> phần vượt lên chỉ sinh thêm nếu còn quota
```

Với arrival-rate executors:

```text
preAllocatedVUs = phần init trước
maxVUs          = trần tổng VU
maxVUs - preAllocatedVUs = phần có thể sinh thêm trong lúc chạy
```

Nếu `maxVUs == preAllocatedVUs`, thì không còn chỗ cho unplanned VU nữa.

Ví dụ:

```js
executor: "constant-arrival-rate",
rate: 100,
timeUnit: "1s",
preAllocatedVUs: 10,
maxVUs: 50,
```

Ở đây:

```text
10 VU được tạo sẵn trước
40 VU còn lại chỉ có thể sinh thêm nếu runtime thiếu VU trong lúc chạy
```

Nếu test không bao giờ thiếu VU, thì 40 phần đó sẽ không cần sinh ra.
Nếu test thiếu VU, k6 mới bắt đầu đụng tới phần unplanned này.

## 4. Ba loại VU

### Planned VUs

```text
VU đã được tạo trước và nằm trong pool chờ executor lấy
```

Thường do scheduler tạo ở init phase.

Ví dụ:

```js
executor: "per-vu-iterations",
vus: 3,
iterations: 2,
```

Ở đây 3 VU được tạo trước, rồi executor lấy ra dùng dần.

### Active VUs

```text
VU đang thực sự chạy script, hoặc đã nhận lệnh dừng nhưng chưa thoát khỏi iteration
```

Đây là số VU đang "bận việc", không phải số VU đang ngồi chờ trong pool.

Ví dụ:

```text
2 VU đang ở trong iteration, có thể đang request, sleep, hoặc chạy JS
1 VU đã nhận lệnh dừng nhưng vẫn chưa thoát khỏi iteration hiện tại
=> active VUs = 3
```

Nếu một VU chỉ đã được init xong và đang chờ executor lấy, nó là planned/initialized VU,
không phải active VU theo counter `GetCurrentlyActiveVUsCount()`.

### Unplanned VUs

```text
VU được tạo thêm giữa lúc test đang chạy nếu còn quota
```

Loại này chủ yếu xuất hiện ở open model, đặc biệt arrival-rate executors.

Ví dụ:

```text
t = 20s
đến slot mới nhưng không có VU rảnh
=> k6 bắt đầu sinh thêm 1 VU ở nền
=> VU đó là unplanned VU
```

### Nhìn nhanh theo core

`es.vus` là pool chung chứa VU đã init xong nhưng chưa dùng ngay.
Executors mượn VU từ pool chung rồi trả lại khi executor không cần VU đó nữa.
Riêng arrival-rate executors còn có pool nội bộ trong lúc chạy: VU đã được mượn khỏi pool chung,
đã `Activate()`, nhưng đang rảnh để chờ slot kế tiếp.

| Loại | Nghĩa | Khi nào có |
|------|------|------------|
| planned VUs | VU đã init sẵn | Scheduler Init phase |
| active VUs | VU đang bận theo cách đếm active của executor; không phải lúc nào cũng chỉ gói gọn trong câu "VU đang chạy thật" | Execution phase |
| unplanned VUs | VU tạo thêm khi thiếu | Giữa test run |

## 5. Slot và drop

### 5.1 Slot là gì?

`slot` là **một mốc start đã được lên lịch** cho 1 iteration.
Nó không phải là một ô 1 giây, cũng không phải một khoảng chờ để gom việc.

Ví dụ này là case `constant-arrival-rate` local run đơn giản, với `rate: 4, timeUnit: "1s"`:

```text
0.00s -> slot 1
0.25s -> slot 2
0.50s -> slot 3
0.75s -> slot 4
1.00s -> slot 5
```

Trong `constant-arrival-rate`, các slot cách đều nhau.
Trong `ramping-arrival-rate`, khoảng cách giữa slot thay đổi theo đường ramp.

### 5.2 Drop là gì?

`drop` nghĩa là slot đã đến giờ nhưng không có VU rảnh ngay.

Core làm đúng theo đường này:

```text
1. tới giờ slot
2. thử lấy VU bằng TryRunIteration()
3. có VU rảnh -> chạy
4. không có VU rảnh -> slot bị drop
5. nếu còn quota, k6 mới khởi tạo thêm unplanned VU ở nền
6. VU mới chỉ có thể giúp các mốc tương lai sau khi init + Activate xong
```

Điểm mấu chốt:

```text
unplanned VU không cứu được slot vừa bị drop
```

Ví dụ:

```text
t = 20.0s: slot đến hạn, không có VU rảnh -> drop
t = 20.0s: k6 bắt đầu tạo thêm 1 VU ở nền
t = 22.0s: VU mới xong
=> từ đây nó mới có thể giúp các mốc tương lai sau khi init + Activate xong
```

### 5.3 Ramping arrival-rate khác gì?

Khác ở chỗ schedule không đều.
Rate tăng hay giảm theo stage curve, nhưng logic ở slot vẫn y nguyên:

```text
tới giờ start -> cần VU rảnh ngay
không có -> drop
```

## 6. JS variables gắn với VU lifecycle

Mục này trả lời câu hỏi:

```text
khi đang ở trong script JS, mình nhìn biến nào để biết đang là VU nào,
iteration thứ mấy, scenario nào?
```

Điểm dễ nhầm là các biến này không cùng một "trục đếm".
Có biến đếm theo VU.
Có biến đếm theo scenario.
Có biến chỉ có ý nghĩa trong một k6 instance.
Có biến cố gắng giữ ID trên toàn test khi chạy phân đoạn / nhiều instance.

Trước hết cần nhớ:

```text
init context, tức ngữ cảnh khởi tạo
  = phần code chạy lúc k6 load file JS
  = chưa có VU thật đang chạy iteration

execution context, tức ngữ cảnh đang thực thi iteration
  = bên trong default() hoặc function được executor gọi
  = lúc này mới có VU, scenario, iteration hiện tại
```

Vì vậy `exec.vu.*` và `exec.scenario.*` chỉ nên đọc trong ngữ cảnh đang thực thi iteration.
Nếu đọc trong ngữ cảnh khởi tạo, core sẽ báo lỗi kiểu "không có thông tin VU/scenario ở ngoài VU context".

### 6.1 `__VU`, `exec.vu.idInInstance`, `exec.vu.idInTest`

Nhóm này trả lời câu hỏi:

```text
iteration hiện tại đang chạy trên VU nào?
```

Trong core, mỗi VU có hai ID:

```text
ID local
  = ID của VU trong k6 instance hiện tại

ID global
  = ID của VU trên toàn test
  = hữu ích hơn khi test có nhiều instance hoặc có chia execution segment
```

Ý nghĩa:

```text
__VU
  = ID local của VU trong k6 instance hiện tại
  = biến cũ, tiện log nhanh

exec.vu.idInInstance
  = cùng ý nghĩa với __VU
  = đọc qua API k6/execution

exec.vu.idInTest
  = ID global của VU trên toàn test
  = trong local run một instance thường trùng idInInstance
  = khi chạy phân đoạn / nhiều instance thì có thể khác
```

Ví dụ:

```js
import exec from "k6/execution";

export default function () {
  console.log(
    `__VU=${__VU} idInInstance=${exec.vu.idInInstance} idInTest=${exec.vu.idInTest}`
  );
}
```

Nếu chạy local một instance với 2 VU, log có thể giống:

```text
__VU=1 idInInstance=1 idInTest=1
__VU=2 idInInstance=2 idInTest=2
```

Không nên hiểu `__VU=1` là "user thật số 1".
Nó chỉ là người thực thi ảo số 1 trong process k6 hiện tại.

### 6.2 `__ITER`, `exec.vu.iterationInInstance`, `exec.vu.iterationInScenario`

Nhóm này trả lời câu hỏi:

```text
riêng VU này đã chạy tới vòng thứ mấy?
```

Trong core, khi `RunOnce()` bắt đầu, k6 gọi `incrIteration()`.
VU mới được tạo với counter nội bộ ban đầu là `-1`.
Lần đầu VU chạy iteration, core tăng lên `0`, rồi set `__ITER = 0`.
Vì vậy iteration đầu tiên trong JS thấy `0`, không phải `1`.

Ý nghĩa:

```text
__ITER
  = số iteration của riêng VU này trong k6 instance hiện tại
  = tăng mỗi lần chính VU này chạy RunOnce()
  = không reset chỉ vì VU được scenario khác mượn lại

exec.vu.iterationInInstance
  = cùng số với __ITER
  = cách đọc rõ nghĩa hơn qua k6/execution

exec.vu.iterationInScenario
  = số iteration của riêng VU này trong scenario hiện tại
  = đếm riêng theo scenario name đối với VU đó
  = lần đầu VU chạy scenario name đó thì bắt đầu từ 0
```

Ví dụ dễ nhớ:

```text
VU chạy scenario A:
  __ITER = 0, 1, 2

VU đó quay sang scenario B:
  __ITER tiếp tục tăng
  exec.vu.iterationInScenario bắt đầu lại từ 0
```

Ví dụ log:

```js
import exec from "k6/execution";

export default function () {
  console.log(
    [
      `vu=${exec.vu.idInInstance}`,
      `__ITER=${__ITER}`,
      `vu.iterationInInstance=${exec.vu.iterationInInstance}`,
      `vu.iterationInScenario=${exec.vu.iterationInScenario}`,
    ].join(" ")
  );
}
```

Nếu cùng một VU chạy 3 vòng trong cùng scenario:

```text
vu=1 __ITER=0 vu.iterationInInstance=0 vu.iterationInScenario=0
vu=1 __ITER=1 vu.iterationInInstance=1 vu.iterationInScenario=1
vu=1 __ITER=2 vu.iterationInInstance=2 vu.iterationInScenario=2
```

Nếu sau đó chính VU này được executor của scenario khác mượn lại:

```text
vu=1 __ITER=3 vu.iterationInInstance=3 vu.iterationInScenario=0
```

Điểm cần nhớ:

```text
__ITER / exec.vu.iterationInInstance
  = nhìn theo đời của VU trong instance

exec.vu.iterationInScenario
  = nhìn theo đời của VU trong scenario hiện tại
```

### 6.3 `exec.scenario.*`

`exec.scenario` là metadata của scenario hiện tại.
Nói dễ hiểu hơn: nó là nhóm thông tin mô tả scenario mà iteration hiện tại đang thuộc về.
Nó trả lời câu hỏi:

```text
iteration hiện tại thuộc scenario nào, executor nào,
và là iteration thứ mấy của scenario đó?
```

Nó không phải slot.
Nó cũng không phải VU ID.

Những field hay gặp:

```text
name
executor
startTime
progress
iterationInInstance
iterationInTest
```

Ý nghĩa:

```text
exec.scenario.name
  = tên scenario, tức key trong options.scenarios

exec.scenario.executor
  = loại executor của scenario hiện tại
  = ví dụ constant-vus, per-vu-iterations, constant-arrival-rate

exec.scenario.startTime
  = timestamp millisecond kiểu JS Date
  = thời điểm scenario thật sự bắt đầu chạy
  = không phải "slot"
  = không phải trực tiếp là chuỗi config startTime như "30s"

exec.scenario.progress
  = tiến độ tương đối của scenario
  = thường đọc như số từ 0 đến 1

exec.scenario.iterationInInstance
  = số thứ tự iteration của scenario trong k6 instance hiện tại
  = đếm chung qua các VU trong scenario đó

exec.scenario.iterationInTest
  = số thứ tự iteration của scenario trên toàn test
  = hữu ích khi chạy nhiều instance / execution segment
```

Chỗ dễ nhầm nhất:

```text
exec.vu.iterationInInstance
  = iteration thứ mấy của riêng VU này

exec.scenario.iterationInInstance
  = iteration thứ mấy của scenario này trong k6 instance
  = đếm chung qua nhiều VU
```

Ví dụ:

```text
scenario login dùng 2 VU

VU #1 chạy iteration đầu tiên của scenario:
  exec.vu.iterationInInstance = 0
  exec.scenario.iterationInInstance = 0

VU #2 chạy iteration đầu tiên của chính nó:
  exec.vu.iterationInInstance = 0
  exec.scenario.iterationInInstance = 1

VU #1 chạy tiếp iteration thứ hai của chính nó:
  exec.vu.iterationInInstance = 1
  exec.scenario.iterationInInstance = 2
```

Ở ví dụ này:

```text
exec.vu.iterationInInstance
  có thể trùng nhau giữa VU #1 và VU #2
  vì mỗi VU tự đếm riêng

exec.scenario.iterationInInstance
  tăng theo toàn scenario
  nên mỗi iteration của scenario lấy một số kế tiếp
```

Ví dụ log đủ các field:

```js
import exec from "k6/execution";

export default function () {
  console.log(
    JSON.stringify({
      vu: exec.vu.idInInstance,
      vuIter: exec.vu.iterationInInstance,
      vuScenarioIter: exec.vu.iterationInScenario,
      scenario: exec.scenario.name,
      scenarioIter: exec.scenario.iterationInInstance,
      scenarioIterInTest: exec.scenario.iterationInTest,
      scenarioStartTime: new Date(exec.scenario.startTime).toISOString(),
    })
  );
}
```

Nếu bạn muốn biết scenario bắt đầu sau bao lâu so với lúc test bắt đầu,
đừng lấy `exec.scenario.startTime` rồi hiểu là `0s` hay `30s`.
`exec.scenario.startTime` là timestamp tuyệt đối theo millisecond.
Muốn xem offset, hãy so với thời điểm test bắt đầu hoặc nhìn config `startTime`.

Tóm tắt nhanh:

| Biến | Đếm theo cái gì? | Reset khi nào? |
|---|---|---|
| `__VU` | ID VU trong instance | Không phải counter iteration |
| `exec.vu.idInInstance` | ID VU trong instance | Không phải counter iteration |
| `exec.vu.idInTest` | ID VU toàn test | Không phải counter iteration |
| `__ITER` | Iteration của riêng VU trong instance | Không reset khi VU đổi scenario |
| `exec.vu.iterationInInstance` | Iteration của riêng VU trong instance | Cùng ý nghĩa với `__ITER` |
| `exec.vu.iterationInScenario` | Iteration của riêng VU trong scenario hiện tại | Đếm riêng theo scenario name của VU đó |
| `exec.scenario.iterationInInstance` | Iteration của scenario trong instance hiện tại | Đếm chung qua các VU của scenario |
| `exec.scenario.iterationInTest` | Iteration của scenario trên toàn test | Đếm chung trên toàn test / execution segments, tức các phân đoạn chạy |

## 7. Đọc tiếp bài nào

Nếu bạn mới học k6, nên đọc theo thứ tự này:

```text
1. bài này: bức tranh lớn
2. bài sâu hơn về VU lifecycle và counters
3. bài riêng cho từng executor: constant-vus, per-vu-iterations, shared-iterations
4. bài riêng cho arrival-rate: constant-arrival-rate, ramping-arrival-rate
```

Bài sâu hơn đã có sẵn:

- [`20260114_vu-lifecycle-and-iteration-counters.md`](./20260114_vu-lifecycle-and-iteration-counters.md)

## References

Core files đã đối chiếu:

- `lib/helpers.go`
- `lib/execution.go`
- `lib/executor/base_executor.go`
- `internal/execution/scheduler.go`
- `internal/js/runner.go`
- `internal/js/modules/k6/execution/execution.go`
- `metrics/builtin.go`
- `lib/executor/constant_arrival_rate.go`
- `lib/executor/ramping_arrival_rate.go`

---

Nếu cần, bài tiếp theo có thể là:

- `constant-vus`
- `per-vu-iterations`
- `shared-iterations`
- `constant-arrival-rate`
- `ramping-arrival-rate`
