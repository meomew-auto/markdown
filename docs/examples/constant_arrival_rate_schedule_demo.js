import exec from "k6/execution";
import { sleep } from "k6";

const RATE = 4;
const TIME_UNIT = "1s";
const DURATION = "4s";
const ITERATION_SECONDS = 0.4;

// Demo constant-arrival-rate with enough VUs.
// Target schedule:
// - 4 iteration starts per 1 second
// - 1 start slot every 250ms
// - duration 4s -> about 16 scheduled start slots
//
// Since each iteration sleeps 0.4s and we reserve 4 VUs, capacity is roughly:
//   max_capacity ~= 4 / 0.4 = 10 iterations/s
// which is above the target 4 iterations/s, so dropped_iterations should be 0.
export const options = {
  scenarios: {
    constant_arrival_schedule: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: 4,
      maxVUs: 4,
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(2);
}

export default function () {
  const startedAt = elapsedSeconds();
  console.log(
    `[iter-start] scenario=${exec.scenario.name} t=${startedAt}s __VU=${__VU} __ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`,
  );

  sleep(ITERATION_SECONDS);

  console.log(
    `[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} startedAt=${startedAt}s`,
  );
}
