# `k6`: thời gian trong test

Bài này gom các mốc hay nhầm nhất:

- `sleep()`
- `startTime`
- `duration` / `maxDuration`
- `gracefulStop`
- `gracefulRampDown`
- `minIterationDuration`

Mục tiêu là đọc được:

- cái nào là thời gian của 1 iteration
- cái nào là thời gian của 1 scenario
- cái nào là thời gian chờ trước/sau khi chạy

## 1. Nhìn nhanh

Trong k6 có 3 lớp thời gian:

```text
1. thời gian của 1 iteration
2. thời gian của 1 scenario
3. thời gian thực ngoài đời từ lúc bấm `k6 run`
```

Đừng trộn 3 cái này vào 1.

### Bảng nhớ nhanh

| Thứ | Ở đâu | Tác động chính |
| --- | --- | --- |
| `sleep()` | trong JS `default()` / `exec()` | làm iteration đang chạy lâu hơn |
| `minIterationDuration` | options chung | ép mỗi iteration full phải dài tối thiểu N |
| `startTime` | scenario config | delay trước khi scenario bắt đầu |
| `duration` / `maxDuration` | scenario config | khung chạy chính của scenario |
| `gracefulStop` | scenario config | cửa sổ chờ sau khung chạy chính |
| `gracefulRampDown` | `ramping-vus` | cửa sổ cho VU đang giảm số được finish nốt |

## 2. `sleep()` là gì?

`sleep()` là pause trong chính VU đang chạy.

Code path:

```go
// internal/js/modules/k6/k6.go
Sleep(secs float64) {
  wait bằng timer
  hoặc dừng sớm nếu context hết
}
```

Đọc đời thường:

```text
VU đang làm 1 iteration
  -> gặp sleep()
  -> VU đứng chờ một lát
  -> xong mới đi tiếp
```

`sleep()` nằm **bên trong iteration**, nên nó tính vào `iteration_duration`.

Nó cũng không phải "chờ chắc chắn đủ lâu" nếu test đã hết context.
Nếu `maxDuration`/`gracefulStop` kết thúc trước, `sleep()` có thể bị cắt sớm.

Ví dụ:

```js
import http from "k6/http";
import { sleep } from "k6";

export default function () {
  http.get("https://quickpizza.grafana.com/");
  sleep(1);
}
```

Đọc là:

- request xong
- VU chờ 1 giây
- cả đoạn đó nằm trong 1 iteration

Nên `iteration_duration` sẽ dài hơn nếu có `sleep()`.

## 3. `minIterationDuration` là gì?

`minIterationDuration` là thời gian tối thiểu cho **1 full iteration**.

Nó khác `sleep()`:

- `sleep()` nằm trong script
- `minIterationDuration` nằm ngoài script, ở options

Core path:

```go
// internal/js/runner.go
runFn() đo start/end của function
iterationSamples() emit iteration_duration + iterations
runOnce() xong mới sleep phần còn thiếu theo minIterationDuration
```

Nghĩa là:

```text
function chạy xong
  -> nếu ngắn hơn minIterationDuration
  -> k6 chờ thêm
  -> rồi mới cho VU chạy iteration tiếp theo
```

Quan trọng:

- `minIterationDuration` **không** nằm trong `iteration_duration`
- nó chỉ kéo dài vòng chờ giữa 2 iterations
- nó chỉ áp dụng khi iteration là full iteration và chưa bị context cắt

Ví dụ:

```js
import { Counter } from "k6/metrics";

export const options = {
  scenarios: {
    demo: {
      executor: "constant-vus",
      vus: 4,
      duration: "1s",
      gracefulStop: "0s",
    },
  },
  minIterationDuration: "300ms",
};

const testCounter = new Counter("testcounter");

export default function () {
  testCounter.add(1);
}
```

Đọc là:

- iteration xong sớm hơn 300ms thì k6 chờ thêm
- summary vẫn ghi full iteration đã hoàn thành
- metric `iteration_duration` vẫn chỉ đo thời gian body của function

## 4. `startTime` là gì?

`startTime` là độ trễ trước khi scenario bắt đầu.

Nó không phải một số đo của iteration.

Scheduler chỉ làm một việc:

```text
chờ tới startTime
  -> mới gọi executor.Run()
```

Đọc đời thường:

```text
test đã bắt đầu
  -> nhưng scenario này chưa chạy ngay
  -> nó chờ đúng `startTime`
  -> tới giờ mới vào `Run()`
```

Ví dụ:

```js
export const options = {
  scenarios: {
    a: {
      executor: "constant-vus",
      vus: 2,
      duration: "5s",
      startTime: "3s",
    },
  },
};
```

Đọc là:

- từ 0s tới 3s: scenario chưa chạy
- từ 3s trở đi: scenario mới bắt đầu

Từ góc nhìn test đầu cuối:

```text
scenario max end = startTime + duration + gracefulStop
```

Trong đó `duration` ở đây là "khung chính" của scenario:

- `duration` với `constant-vus` / `constant-arrival-rate`
- `maxDuration` với `per-vu-iterations` / `shared-iterations`
- `sum(stages)` với `ramping-vus` / `ramping-arrival-rate`

Lưu ý:

- `options.scenarios.<name>.startTime` là delay
- `exec.scenario.startTime` trong JS là timestamp thật lúc scenario bắt đầu

## 5. `duration` / `maxDuration` là gì?

Đây là khung chạy chính của scenario.

Tên field tùy executor:

| Executor | Field chính |
| --- | --- |
| `constant-vus` | `duration` |
| `constant-arrival-rate` | `duration` |
| `per-vu-iterations` | `maxDuration` |
| `shared-iterations` | `maxDuration` |
| `ramping-vus` | `stages` |
| `ramping-arrival-rate` | `stages` |

Ý nghĩa chung:

```text
hết khung chính
  -> không start iteration mới nữa
```

Nhưng iteration đang chạy có thể còn được phép finish nếu còn grace window.

## 6. `gracefulStop` là gì?

`gracefulStop` là cửa sổ chờ sau khi khung chạy chính kết thúc.

Trong core:

```go
// lib/executor/helpers.go
regDurationCtx  -> chặn start iteration mới
maxDurationCtx  -> chặn luôn mọi việc còn dở
```

Đọc đời thường:

```text
hết duration/maxDuration
  -> không start iteration mới nữa
  -> iteration nào đang chạy thì được chờ finish thêm một lát
  -> hết gracefulStop thì cắt
```

Ví dụ:

```js
export const options = {
  scenarios: {
    demo: {
      executor: "constant-vus",
      vus: 2,
      duration: "5s",
      gracefulStop: "2s",
    },
  },
};
```

Timeline:

```text
0s -------- 5s -------- 7s
|  chạy chính  | grace  |
```

Đọc là:

- 0s -> 5s: còn start iteration mới
- 5s -> 7s: không start mới nữa, chỉ chờ iteration đang chạy xong
- sau 7s: iteration còn dở có thể bị interrupt

Tóm gọn:

```text
scenario max end = startTime + regularDuration + gracefulStop
```

`regularDuration` = khung chính của scenario:

- `duration`
- `maxDuration`
- hoặc `sum(stages)`

## 7. `gracefulRampDown` là gì?

`gracefulRampDown` chỉ dùng cho `ramping-vus`.

Nó là thời gian cho VU đang bị giảm số được finish nốt iteration hiện tại.

Khác với `gracefulStop`:

- `gracefulStop`: tail ở cuối test
- `gracefulRampDown`: tail khi đang ramp xuống giữa timeline

## 8. `iteration_duration` đo cái gì?

`iteration_duration` đo thời gian của **1 full iteration**.

Code path:

```go
// internal/js/runner.go
startTime := time.Now()
run JS function
endTime := time.Now()
emit iteration_duration = endTime - startTime
emit iterations = 1
```

Nó bao gồm:

- JS xử lý
- HTTP
- `sleep()` bên trong function
- check / parse / logic trong function

Nó không bao gồm:

- `minIterationDuration`

## 9. Bài ghép cả 6 thứ

Ví dụ này cố tình đặt hết vào 1 chỗ:

```js
import http from "k6/http";
import { sleep } from "k6";

export const options = {
  scenarios: {
    demo: {
      executor: "constant-vus",
      vus: 2,
      startTime: "3s",
      duration: "5s",
      gracefulStop: "2s",
    },
  },
  minIterationDuration: "1s",
};

export default function () {
  http.get("https://quickpizza.grafana.com/");
  sleep(0.3);
}
```

Đọc theo lớp:

```text
wall-clock
  0s -> 3s: đợi startTime
  3s -> 8s: chạy chính
  8s -> 10s: gracefulStop

iteration clock
  1 iteration = HTTP + sleep(300ms) + JS xử lý

iteration pacing
  nếu iteration xong trước 1s
  -> k6 chờ thêm để đủ minIterationDuration
```

Nghĩa là:

- `startTime` chỉ là delay trước khi scenario vào cuộc
- `duration` là cửa sổ start iteration mới
- `gracefulStop` là cửa sổ finish nốt
- `sleep()` nằm trong iteration
- `minIterationDuration` là chờ thêm sau iteration
- `iteration_duration` chỉ đo phần body của iteration

## 10. Chốt nhanh

```text
sleep()
  = chờ trong iteration
  = tính vào iteration_duration

minIterationDuration
  = chờ sau iteration
  = không tính vào iteration_duration

startTime
  = chờ trước khi scenario chạy

duration / maxDuration
  = khung chạy chính

gracefulStop
  = đuôi chờ sau khung chạy chính

gracefulRampDown
  = đuôi khi ramp xuống VU
```

Nếu chỉ nhớ 1 câu:

```text
sleep() ở trong iteration
minIterationDuration ở sau iteration
startTime ở trước scenario
duration/maxDuration là khung chính
gracefulStop/gracefulRampDown là đuôi
```
