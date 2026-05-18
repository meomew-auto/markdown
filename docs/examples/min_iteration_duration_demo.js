import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - JS work in each iteration takes about 0.5s.
// - minIterationDuration pads each completed iteration to about 2s.
// - iteration_duration stays around 0.5s, because the padding happens after the iteration function returns.
// - Total run time is around 6s for 3 iterations with 1 VU.
export const options = {
  minIterationDuration: "2s",
  scenarios: {
    min_iter_demo: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "10s",
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

  sleep(0.5);

  console.log(
    `[js-end]     scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
}
