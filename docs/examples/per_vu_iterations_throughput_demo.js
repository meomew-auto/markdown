import exec from "k6/execution";
import { sleep } from "k6";

const VUS = 10;
const ITERATIONS_PER_VU = 20;
const FAST_VUS = 8;
const FAST_ITERATION_SECONDS = 0.2;
const SLOW_ITERATION_SECONDS = 0.5;

// Demo inputs:
// - total VUs = 10
// - fast VUs = 8  -> each iteration sleeps 0.2s
// - slow VUs = 2  -> each iteration sleeps 0.5s
// - iterations per VU = 20
//
// Expected formulas:
// - total_iterations = VUS * ITERATIONS_PER_VU = 200
// - slow VUs count = VUS - FAST_VUS = 2
// - per_vu_rate ~= 1 / iteration_time
// - peak_total_rate ~= active_vus * per_vu_rate
// - average_total_rate = completed_iterations / actual_scenario_runtime
// - summary iterations/s is average_total_rate for the whole scenario; do not multiply it by VUS
// - peak_iteration_rate_if_all_vus_active =
//     FAST_VUS / FAST_ITERATION_SECONDS + (VUS - FAST_VUS) / SLOW_ITERATION_SECONDS
//     = 8 / 0.2 + 2 / 0.5 = 44 iters/s
// - vu_runtime_fast = ITERATIONS_PER_VU * FAST_ITERATION_SECONDS = 20 * 0.2 = 4s
// - vu_runtime_slow = ITERATIONS_PER_VU * SLOW_ITERATION_SECONDS = 20 * 0.5 = 10s
// - actual_scenario_runtime ~= max(vu_runtime_fast, vu_runtime_slow) = 10s
// - average_iteration_rate ~= total_iterations / actual_scenario_runtime = 20 iters/s
//
// Grafana docs style example:
// - 1 iteration ~= 515ms = 0.515s
// - 1 VU ~= 1 / 0.515 ~= 1.94 ~= 2 iters/s
// - 10 active VUs => peak_total_rate ~= 10 * 1.94 ~= 20 iters/s
//
// The fast VUs finish around 4s and then stay idle. The scenario ends when the
// slowest VU finishes its 20 iterations, around 10s.
export const options = {
  scenarios: {
    per_vu_throughput: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERATIONS_PER_VU,
      maxDuration: "30s",
      gracefulStop: "2s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

function iterationSecondsForVU(vuID) {
  return vuID <= FAST_VUS ? FAST_ITERATION_SECONDS : SLOW_ITERATION_SECONDS;
}

export default function () {
  const vuID = exec.vu.idInTest;
  const delay = iterationSecondsForVU(vuID);
  const iterStartMs = Date.now();

  if (__ITER === 0) {
    console.log(`[vu-start] vu=${vuID} delay=${delay}s t=${elapsedSeconds()}s`);
  }

  sleep(delay);

  const measuredMs = Date.now() - iterStartMs;
  if (__ITER === 0 || __ITER === ITERATIONS_PER_VU - 1) {
    console.log(
      `[iter-measured] vu=${vuID} __ITER=${__ITER} measuredMs=${measuredMs} configuredDelay=${delay}s`,
    );
  }

  if (__ITER === ITERATIONS_PER_VU - 1) {
    console.log(`[vu-done]  vu=${vuID} delay=${delay}s t=${elapsedSeconds()}s`);
  }
}
