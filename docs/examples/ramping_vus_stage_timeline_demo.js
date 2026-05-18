import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    ramping_timeline: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "4s", target: 4 },
        { duration: "4s", target: 4 },
        { duration: "4s", target: 0 },
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
    `[iter] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(0.7);
}
