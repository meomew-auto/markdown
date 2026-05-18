import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    ramping_interrupt: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "2s", target: 1 },
        { duration: "1s", target: 0 },
      ],
      gracefulRampDown: "0s",
      gracefulStop: "0s",
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

  for (let second = 0; second < 10; second += 1) {
    console.log(`[tick] t=${elapsedSeconds()}s second=${second}`);
    sleep(1);
  }

  console.log(
    `[iter-end] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
