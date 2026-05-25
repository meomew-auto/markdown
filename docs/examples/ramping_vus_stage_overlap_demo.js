import exec from "k6/execution";
import { sleep } from "k6";

// Demo các case "trùng" trong stages của ramping-vus:
//   - 2 stage liên tiếp có cùng target (plateau / hold)
//   - 2 stage có cùng giá trị duration (hợp lệ, không xung đột)
//   - 1 stage có duration = 0s (instant jump, không ramp)
//
// Mục tiêu: cho thấy ramping-vus xử lý 3 case này như nào ở runtime,
// và quan trọng nhất: stage trong 1 scenario luôn tuần tự, không bao giờ
// chạy song song với nhau.

export const options = {
  scenarios: {
    stage_overlap: {
      executor: "ramping-vus",
      startVUs: 2,
      stages: [
        // stage 0: 2 -> 4 trong 3s (ramp up bình thường)
        { duration: "3s", target: 4 },
        // stage 1: target = 4, GIỐNG stage 0 -> hold (không có VU change)
        // duration = 3s, GIỐNG stage 0 -> không sao cả, chỉ là hai stage có
        // cùng độ dài thời gian, tuần tự nối đuôi nhau.
        { duration: "3s", target: 4 },
        // stage 2: duration = 0s -> instant jump 4 -> 6 ngay tại t=6s
        { duration: "0s", target: 6 },
        // stage 3: hold tại 6 trong 3s (cùng duration "3s" như stage 0/1)
        { duration: "3s", target: 6 },
        // stage 4: ramp down 6 -> 0 trong 3s
        { duration: "3s", target: 0 },
      ],
      gracefulRampDown: "2s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
  sleep(0.5);
}
