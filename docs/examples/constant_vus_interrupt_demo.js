import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    interrupted_constant_vus: {
      executor: "constant-vus",
      vus: 1,
      duration: "3s",
      gracefulStop: "1s",
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

  for (let i = 0; i < 10; i += 1) {
    console.log(`[tick] t=${elapsedSeconds()}s i=${i}`);
    sleep(1);
  }

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
