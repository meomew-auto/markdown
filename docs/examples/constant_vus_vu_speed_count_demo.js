import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
  scenarios: {
    constant_vu_speed_count: {
      executor: "constant-vus",
      vus: 4,
      duration: "2s",
      gracefulStop: "2s",
    },
  },
};

const sleepByVU = {
  1: 0.2,
  2: 0.4,
  3: 0.8,
  4: 0.8,
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  const sleepTime = sleepByVU[__VU] || 0.8;

  console.log(
    `[vu-progress] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} sleep=${sleepTime}s`,
  );

  sleep(sleepTime);
}
