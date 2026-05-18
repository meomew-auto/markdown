import exec from "k6/execution";
import { sleep } from "k6";

// Demo interrupted iteration at the end of a constant-arrival-rate scenario.
//
// The first start slot begins immediately, but the iteration sleeps for 5s.
// Because duration=1s and gracefulStop=0s, the context is cancelled before the
// iteration can finish, so the progress line should show an interrupted item.
export const options = {
  scenarios: {
    constant_arrival_interrupt: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: "1s",
      preAllocatedVUs: 1,
      maxVUs: 1,
      gracefulStop: "0s",
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

  sleep(5);

  console.log(
    `[iter-end]   t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
