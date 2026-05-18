import exec from "k6/execution";
import { sleep } from "k6";

const RATE = 4;
const TIME_UNIT = "1s";
const DURATION = "4s";
const ITERATION_SECONDS = 0.6;

// Demo preAllocatedVUs vs maxVUs.
//
// preAllocatedVUs=1 means only 1 VU is initialized before the scenario starts.
// maxVUs=4 allows k6 to initialize extra unplanned VUs at runtime if the fixed
// arrival schedule needs them.
//
// In real tests, prefer sizing preAllocatedVUs high enough so k6 does not need
// runtime VU initialization during the measured part of the test.
export const options = {
  scenarios: {
    constant_arrival_unplanned_vus: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 1,
      maxVUs: 4,
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(2);
}

export default function () {
  console.log(
    `[iter-start] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`,
  );

  sleep(ITERATION_SECONDS);

  console.log(
    `[iter-end]   t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
