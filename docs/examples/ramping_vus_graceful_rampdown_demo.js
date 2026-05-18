import exec from "k6/execution";
import { sleep } from "k6";

const ITERATION_SLEEP_SECONDS = 2.2;
const RAMP_DOWN_START_SECONDS = 1;

export const options = {
  scenarios: {
    ramping_graceful_rampdown: {
      executor: "ramping-vus",
      startVUs: 2,
      stages: [
        { duration: "1s", target: 2 },
        { duration: "1s", target: 0 },
      ],
      gracefulRampDown: "3s",
      gracefulStop: "4s",
    },
  },
};

function elapsedSecondsValue() {
  return (Date.now() - exec.scenario.startTime) / 1000;
}

function elapsedSeconds() {
  return elapsedSecondsValue().toFixed(1);
}

export default function () {
  console.log(
    `[iter-start] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} sleep=${ITERATION_SLEEP_SECONDS}s rampDownStartsAt=${RAMP_DOWN_START_SECONDS.toFixed(1)}s`,
  );

  sleep(ITERATION_SLEEP_SECONDS);

  const finishedAfterRampDownStarted =
    elapsedSecondsValue() >= RAMP_DOWN_START_SECONDS ? "yes" : "no";

  console.log(
    `[iter-end]   t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} finishedAfterRampDownStarted=${finishedAfterRampDownStarted} vusActive=${exec.instance.vusActive}`,
  );
}
