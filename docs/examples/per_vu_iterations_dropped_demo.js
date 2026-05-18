import exec from "k6/execution";
import { sleep } from "k6";

// Demo dropped_iterations cho per-vu-iterations.
//
// Muc tieu:
// - Cho thay dropped_iterations xay ra khi cham maxDuration truoc khi moi VU chay xong quota.
// - Khong can co interrupted iteration de van thay dropped_iterations.
//
// Timeline mong doi:
// - iter 0 start o t=0s, end o t=2s
// - iter 1 start o t=2s, end o t=4s (van duoc finish trong gracefulStop)
// - iter 2 khong duoc start vi maxDuration da het tu t=3s
//
// Summary ky vong:
// - 2 complete
// - 0 interrupted
// - dropped_iterations = 1
export const options = {
  scenarios: {
    per_vu_dropped_demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
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
    `[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(2);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
