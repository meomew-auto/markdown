import exec from "k6/execution";
import { sleep } from "k6";

// Demo: stage 0 có duration=0s -> instant jump ngay tại t=0
//
// startVUs=1 nhưng stage đầu tiên target=4 với duration=0s
// => k6 emit step (timeOffset=0, plannedVUs=4) ngay tại t=0
// => 4 VU active luôn từ giây đầu, không có quá trình ramp
//
// Tương đương đơn giản hơn: startVUs=4 + 1 stage hold.
// Demo này chỉ để minh chứng behavior của duration=0s, không phải pattern khuyến khích.

export const options = {
  scenarios: {
    stage0_zero: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "0s", target: 4 },  // stage 0: instant jump 1 -> 4 ngay tại t=0
        { duration: "5s", target: 4 },  // stage 1: hold 4 VU trong 5s
        { duration: "2s", target: 0 },  // stage 2: ramp down
      ],
      gracefulRampDown: "1s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(`[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`);
  sleep(0.5);
}
