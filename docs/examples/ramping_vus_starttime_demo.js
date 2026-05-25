import exec from "k6/execution";
import { sleep } from "k6";

// Demo: startTime của scenario - dịch toàn bộ timeline về sau N giây
//
// startTime=3s nghĩa là:
//   t=0..3s   : scenario chưa active, không có VU nào chạy
//   t=3s      : scenario start (mốc t=3s = "t=0 nội bộ" của scenario)
//   t=3..6s   : stage 0 (3s đầu của timeline scenario)
//   t=6..9s   : stage 1
//   t=9..11s  : stage 2 (ramp down)
//
// regular_duration của scenario vẫn = 3+3+2 = 8s (tính nội bộ).
// Header max duration của test = startTime + regular_duration + gracefulStop
//                              = 3 + 8 + 2 = 13s.

export const options = {
  scenarios: {
    delayed_scenario: {
      executor: "ramping-vus",
      startTime: "3s",
      startVUs: 1,
      stages: [
        { duration: "3s", target: 3 },
        { duration: "3s", target: 3 },
        { duration: "2s", target: 0 },
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
