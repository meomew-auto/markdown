import exec from "k6/execution";
import { sleep } from "k6";

const RATE = 10;
const TIME_UNIT = "1s";
const DURATION = "3s";
const ITERATION_SECONDS = 1;

// Demo dropped_iterations for constant-arrival-rate.
//
// Target schedule:
// - 10 iteration starts per second
// - about 30 scheduled start slots over 3s
//
// Capacity with maxVUs=2 and W~=1s:
//   max_capacity ~= 2 / 1 = 2 iterations/s
//
// The remaining scheduled slots cannot wait for a free VU, so they are dropped.
export const options = {
  scenarios: {
    constant_arrival_not_enough_vus: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 2,
      maxVUs: 2,
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
