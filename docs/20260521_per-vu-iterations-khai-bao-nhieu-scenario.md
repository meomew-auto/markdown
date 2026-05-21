# `per-vu-iterations`: khai báo và init VUs khi có nhiều scenario

Bài này là bản ngắn để dạy học, tách từ bài chi tiết:

`docs/20260514_per-vu-iterations-tham-so-cong-thuc.md`

Mục tiêu:

- biết khai báo executor `per-vu-iterations`
- hiểu `vus` và `iterations` nghĩa là gì
- hiểu nếu có nhiều scenario cùng dùng `per-vu-iterations` thì k6 init bao nhiêu VU
- biết core đọc config theo đường nào

## 1. Tên đúng của executor

Tên executor trong k6 là:

`per-vu-iterations`

Đọc đời thường:

- `vus`: số VU chạy trong scenario đó
- `iterations`: số vòng mỗi VU phải chạy
- tổng iteration dự kiến của scenario: `vus x iterations`

Ví dụ `vus = 3`, `iterations = 2`:

- VU 1 chạy 2 iterations
- VU 2 chạy 2 iterations
- VU 3 chạy 2 iterations
- tổng của scenario là `3 x 2 = 6 iterations`

Điểm quan trọng: VU nào xong sớm thì dừng phần việc của nó. Nó không lấy thêm iteration của VU khác.

## 2. Khai báo 1 scenario

```js
import http from "k6/http";

export const options = {
  scenarios: {
    demo: {
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 2,
      maxDuration: "30s",
    },
  },
};

export default function () {
  http.get("https://quickpizza.grafana.com/");
}
```

Cách đọc:

- scenario tên là `demo`
- executor là `per-vu-iterations`
- k6 cần 3 VUs cho scenario này
- mỗi VU chạy 2 iterations
- tổng planned iterations là `3 x 2 = 6`
- nếu hết `maxDuration` mà còn VU chưa chạy đủ, phần chưa start có thể thành `dropped_iterations`

Trong core:

- `NewPerVUIterationsConfig()` đặt default `vus = 1`, `iterations = 1`, `maxDuration = 10m`
- `Validate()` yêu cầu `vus > 0`, `iterations > 0`, `maxDuration >= 1s`
- `Run()` lấy `numVUs = GetVUs(...)`, `iterations = GetIterations()`
- `Run()` tính `totalIters = numVUs x iterations`
- `Run()` gọi `GetPlannedVU()` đúng `numVUs` lần

## 3. Nếu không khai báo gì thì sao?

Nếu script không khai báo `options`, k6 tự tạo scenario mặc định:

```js
export const options = {
  scenarios: {
    default: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10m",
      gracefulStop: "30s",
      exec: "default",
    },
  },
};
```

Nghĩa là:

- 1 VU
- VU đó chạy 1 iteration
- gọi function `default`

## 4. Khai báo nhiều scenario cùng dùng `per-vu-iterations`

Trong k6, ta thường không nói "khai báo nhiều executor" trực tiếp trong script.
Ta khai báo nhiều `scenario`, và mỗi scenario chọn một `executor`.

Ví dụ:

```js
import http from "k6/http";

export const options = {
  scenarios: {
    login_case: {
      executor: "per-vu-iterations",
      exec: "loginFlow",
      vus: 3,
      iterations: 2,
      maxDuration: "30s",
    },
    checkout_case: {
      executor: "per-vu-iterations",
      exec: "checkoutFlow",
      vus: 2,
      iterations: 2,
      maxDuration: "30s",
    },
  },
};

export function loginFlow() {
  http.get("https://quickpizza.grafana.com/");
}

export function checkoutFlow() {
  http.get("https://quickpizza.grafana.com/api/pizza");
}
```

Cách đọc từng scenario:

- `login_case`: `3 VUs x 2 iterations = 6 iterations`
- `checkout_case`: `2 VUs x 2 iterations = 4 iterations`
- tổng planned iterations của cả test: `6 + 4 = 10 iterations`

## 5. Nhiều scenario thì init VUs như nào?

k6 không init VU riêng theo từng scenario theo kiểu:

`scenario A có pool A, scenario B có pool B`

Core dùng một VU pool chung trong `ExecutionState`.

Đọc đời thường:

- scheduler đọc tất cả scenario
- mỗi scenario báo nó cần bao nhiêu planned VUs theo thời gian
- scheduler cộng các nhu cầu đang chạy cùng thời điểm
- scheduler lấy số lớn nhất trong toàn timeline
- scheduler init trước đúng số VU lớn nhất đó
- lúc chạy, executor mượn VU từ pool chung bằng `GetPlannedVU()`
- chạy xong thì trả VU về pool bằng `ReturnVU()`

Core path:

- `scheduler.go:NewScheduler()` tạo `ExecutionTuple`
- `options.Scenarios.GetFullExecutionRequirements(et)` gom nhu cầu VU của tất cả scenario
- `GetMaxPlannedVUs(executionPlan)` lấy số planned VUs lớn nhất tại mọi thời điểm
- `initVUsAndExecutors()` init số VU đó trước khi test bắt đầu
- `per_vu_iterations.go:Run()` gọi `GetPlannedVU()` để mượn VU
- `ReturnVU()` trả VU về pool chung

## 6. Case 1: hai scenario chạy cùng lúc

Config:

- `login_case`: `vus = 3`
- `checkout_case`: `vus = 2`
- cả hai đều không có `startTime`, nên cùng bắt đầu từ giây 0

Timeline:

- giây 0: `login_case` cần 3 VUs
- giây 0: `checkout_case` cần 2 VUs
- tổng cần cùng lúc: `3 + 2 = 5 VUs`

Vậy scheduler init trước:

`5 planned VUs`

Khi chạy:

- executor của `login_case` mượn 3 VUs
- executor của `checkout_case` mượn 2 VUs
- cả hai đang chạy cùng lúc nên cần đủ 5 VUs
- scenario nào xong thì trả VU về pool chung

## 7. Case 2: hai scenario không chạy đè lên nhau

Ví dụ:

```js
export const options = {
  scenarios: {
    first_case: {
      executor: "per-vu-iterations",
      exec: "firstFlow",
      vus: 3,
      iterations: 2,
      maxDuration: "10s",
      gracefulStop: "0s",
    },
    second_case: {
      executor: "per-vu-iterations",
      exec: "secondFlow",
      vus: 2,
      iterations: 2,
      startTime: "15s",
      maxDuration: "10s",
      gracefulStop: "0s",
    },
  },
};
```

Cách đọc:

- `first_case` cần 3 VUs từ giây 0
- `first_case` hết phần giữ VU ở giây 10
- `second_case` bắt đầu ở giây 15
- hai scenario không đè lên nhau

Vậy scheduler không cần init `3 + 2 = 5 VUs`.

Scheduler chỉ cần init số lớn nhất tại một thời điểm:

`max(3, 2) = 3 planned VUs`

Lúc `first_case` xong, VUs được trả về pool. Sau đó `second_case` có thể mượn lại VUs từ pool đó.

## 8. Case 3: hai scenario chồng lấn một phần

Đây là case dễ nhầm nhất khi tính planned VUs.

Ví dụ:

```js
export const options = {
  scenarios: {
    first_case: {
      executor: "per-vu-iterations",
      exec: "firstFlow",
      vus: 3,
      iterations: 2,
      maxDuration: "20s",
      gracefulStop: "0s",
    },
    second_case: {
      executor: "per-vu-iterations",
      exec: "secondFlow",
      vus: 2,
      iterations: 2,
      startTime: "10s",
      maxDuration: "20s",
      gracefulStop: "0s",
    },
  },
};
```

Cách đọc theo timeline:

- từ `0s` đến `10s`: chỉ `first_case` chạy, cần 3 VUs
- từ `10s` đến `20s`: `first_case` và `second_case` cùng chạy, cần `3 + 2 = 5 VUs`
- từ `20s` đến `30s`: chỉ `second_case` còn chạy, cần 2 VUs

Vậy scheduler init trước:

`5 planned VUs`

Không phải vì cả test có tổng `3 + 2` scenario VUs, mà vì có một đoạn thời gian hai scenario
chồng lên nhau và cùng cần VU.

Đọc nhanh:

- không overlap: lấy max theo từng đoạn thời gian
- overlap một phần: đoạn overlap phải cộng VUs
- overlap hoàn toàn: cũng cộng VUs

## 9. Vì sao `gracefulStop` ảnh hưởng đến init VUs?

Trong `per-vu-iterations`, core báo nhu cầu VU kéo dài tới:

`maxDuration + gracefulStop`

Default `gracefulStop` là `30s`.

Nghĩa là nếu không khai báo `gracefulStop`, một scenario có thể vẫn được tính là còn giữ VU thêm 30s
sau `maxDuration`, để iteration đang chạy có thời gian kết thúc.

Đây là case **overlap do `gracefulStop`**, không phải overlap do phần chạy chính.

Ví dụ:

- scenario A: `vus = 3`, `maxDuration = 10s`, `gracefulStop = 30s`
- scenario B: `vus = 2`, `startTime = 15s`

Nếu chỉ nhìn phần chạy chính:

- A chạy chính từ `0s` đến `10s`
- B bắt đầu ở `15s`
- nhìn qua tưởng là không overlap

Nhưng theo plan của core:

- A vẫn reserve VUs đến `10s + 30s = 40s`
- B bắt đầu ở `15s`
- khoảng `15s` đến `40s` có overlap trong execution plan

Nghĩa là trong đoạn `15s -> 40s`, scheduler vẫn phải tính:

`A cần 3 VUs + B cần 2 VUs = 5 planned VUs`

Nếu muốn case này thật sự không overlap:

- đặt `gracefulStop: "0s"` cho A
- khi đó A reserve VUs đến `10s`
- B bắt đầu `15s`
- không còn đoạn thời gian nào chồng lên nhau

Vì vậy khi dạy học, nếu muốn ví dụ không overlap cho dễ tính, nên đặt `gracefulStop: "0s"`.

## 10. VU có thuộc cố định về scenario không?

Không.

VU được init vào pool chung. Scenario nào đến giờ chạy thì executor của scenario đó mượn VU từ pool.

Với `per-vu-iterations`:

- executor mượn đủ `vus`
- mỗi VU chạy đúng `iterations` vòng của scenario đó
- chạy xong thì trả VU về pool

Nếu chỉ có 1 scenario:

- VU được mượn từ pool
- chạy hết quota của scenario đó
- trả về pool
- test kết thúc nếu không còn scenario nào khác

Nếu có scenario khác chạy sau:

- scenario sau có thể mượn lại chính các VU đã được trả về

## 11. Nguyên tắc chồng lấn có áp dụng cho executor khác không?

Có, ở tầng scheduler thì nguyên tắc là chung cho tất cả scenario.

Scheduler không chỉ xử lý riêng `per-vu-iterations`. Nó làm chung như sau:

- đọc tất cả scenario
- mỗi scenario tự báo nhu cầu VU của nó qua `GetExecutionRequirements()`
- scheduler cộng nhu cầu của các scenario đang chồng lên nhau theo thời gian
- scheduler tạo execution plan chung
- planned VUs init trước = số `PlannedVUs` lớn nhất tại một thời điểm
- max possible VUs = số `PlannedVUs + MaxUnplannedVUs` lớn nhất tại một thời điểm

Core path:

- `ScenarioConfigs.GetFullExecutionRequirements()`
- cộng `PlannedVUs`
- cộng `MaxUnplannedVUs`
- `GetMaxPlannedVUs(executionPlan)`
- `GetMaxPossibleVUs(executionPlan)`

Khác nhau nằm ở chỗ mỗi executor báo nhu cầu khác nhau:

| Executor | Planned VUs | Max unplanned VUs |
| --- | ---: | ---: |
| `per-vu-iterations` | `vus` | `0` |
| `shared-iterations` | `vus` | `0` |
| `constant-vus` | `vus` | `0` |
| `ramping-vus` | thay đổi theo stages | `0` |
| `constant-arrival-rate` | `preAllocatedVUs` | `maxVUs - preAllocatedVUs` |
| `ramping-arrival-rate` | `preAllocatedVUs` | `maxVUs - preAllocatedVUs` |

Vậy câu ngắn là:

- tất cả executor đều đi qua nguyên tắc chồng lấn của scheduler
- nhưng chỉ arrival-rate executors mới có phần `MaxUnplannedVUs` rõ trong execution plan

### Nếu có unplanned VUs thì tính sao?

Unplanned VUs không được init trước ở scheduler init phase.

Chúng là phần "có thể tạo thêm khi đang chạy", thường gặp ở:

- `constant-arrival-rate`
- `ramping-arrival-rate`

Ví dụ:

```js
export const options = {
  scenarios: {
    arrival_case: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 3,
      maxVUs: 10,
    },
  },
};
```

Core hiểu:

- planned VUs = `preAllocatedVUs = 3`
- max unplanned VUs = `maxVUs - preAllocatedVUs = 10 - 3 = 7`
- max possible VUs = `3 + 7 = 10`

Dịch đời thường:

- scheduler init trước 3 VUs
- trong lúc chạy, nếu 3 VUs không đủ để nhận các mốc start iteration, executor có thể xin thêm VU
- tổng VUs của scenario này không được vượt `maxVUs = 10`

Core path khi đang chạy:

- arrival-rate executor gọi `GetUnplannedVU()`
- nếu còn quota unplanned, core initialize VU mới ngay lúc đó
- nếu hết quota unplanned, core thử lấy lại VU đã có trong pool

### Ví dụ overlap có unplanned VUs

Scenario A:

- `constant-arrival-rate`
- `preAllocatedVUs = 3`
- `maxVUs = 10`
- planned = 3
- max unplanned = 7

Scenario B:

- `per-vu-iterations`
- `vus = 5`
- planned = 5
- max unplanned = 0

Nếu A và B chạy chồng lên nhau:

- planned VUs cần init trước = `3 + 5 = 8`
- max unplanned có thể tạo thêm = `7 + 0 = 7`
- max possible VUs tại đoạn overlap = `8 + 7 = 15`

Nếu A và B không chồng lên nhau:

- lúc A chạy: max possible = `3 + 7 = 10`
- lúc B chạy: max possible = `5 + 0 = 5`
- max possible toàn test = `max(10, 5) = 10`

Không được cộng bừa thành `10 + 5 = 15`, vì chúng không chạy cùng lúc.

### Unplanned VUs có làm tăng `vus_max` không?

Có thể có.

`vus_max` là số VU đã initialize tại thời điểm sample. Nếu arrival-rate executor tạo thêm unplanned VUs
giữa lúc chạy, `vus_max` có thể tăng trong summary/timeline.

Nhưng cần nhớ:

- planned VUs được init trước khi execution bắt đầu
- unplanned VUs được init trong execution phase
- init unplanned VU có thể tốn thời gian
- unplanned VU chỉ giúp các mốc start sau khi nó init xong
- mốc start đã tới hạn mà không có VU rảnh vẫn có thể bị `dropped_iterations`

## 12. Cheat sheet dạy học

Nhớ theo 6 câu:

1. `per-vu-iterations` = mỗi VU chạy đúng N vòng.
2. Một scenario có tổng planned iterations = `vus x iterations`.
3. Nhiều scenario cùng lúc thì planned VUs được cộng theo thời điểm.
4. Nhiều scenario lệch thời gian thì scheduler lấy số VUs lớn nhất tại một thời điểm.
5. Arrival-rate có thể có unplanned VUs: không init trước, chỉ có thể tạo thêm khi đang chạy.
6. VUs nằm trong pool chung, executor mượn lúc chạy và trả về khi xong.

Core map ngắn:

| Câu hỏi | Core |
| --- | --- |
| Scenario cần bao nhiêu VU? | `PerVUIterationsConfig.GetExecutionRequirements()` |
| Gộp nhiều scenario ở đâu? | `ScenarioConfigs.GetFullExecutionRequirements()` |
| Init bao nhiêu planned VUs? | `GetMaxPlannedVUs(executionPlan)` |
| Tối đa có thể lên bao nhiêu VUs nếu tính cả unplanned? | `GetMaxPossibleVUs(executionPlan)` |
| Init planned VUs ở đâu? | `Scheduler.initVUsAndExecutors()` |
| Executor lấy VU ở đâu? | `ExecutionState.GetPlannedVU()` |
| Arrival-rate xin thêm unplanned VU ở đâu? | `ExecutionState.GetUnplannedVU()` |
| Executor trả VU ở đâu? | `ExecutionState.ReturnVU()` |
