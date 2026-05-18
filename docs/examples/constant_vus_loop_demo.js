import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    constant_loop: {
      executor: "constant-vus",
      vus: 2,
      duration: "3s",
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

  sleep(0.7);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
