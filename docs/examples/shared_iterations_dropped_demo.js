import exec from "k6/execution";
import { sleep } from "k6";

// Demo dropped_iterations cho shared-iterations.
//
// Muc tieu:
// - Cho thay pool iteration chung co the chua duoc claim het truoc maxDuration.
// - Khi do phan iteration con lai se vao dropped_iterations.
//
// Config:
// - 2 VUs
// - 5 iterations chung
// - moi iteration sleep(2)
// - maxDuration = 3s, gracefulStop = 2s
//
// Timeline mong doi:
// - t=0s: VU1, VU2 start 2 iterations dau
// - t=2s: 2 iteration dau xong, VU1, VU2 start them 2 iteration nua
// - t=3s: het maxDuration, iteration thu 5 khong duoc claim nua
// - t=4s: 2 iteration dang chay finish trong gracefulStop
//
// Summary ky vong:
// - 4 complete
// - 0 interrupted
// - dropped_iterations = 1
export const options = {
  scenarios: {
    shared_dropped_demo: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 5,
      maxDuration: "3s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`,
  );

  sleep(2);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`,
  );
}
