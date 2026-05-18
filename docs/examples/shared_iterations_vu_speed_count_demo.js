import exec from "k6/execution";
import { sleep } from "k6";

const VUS = 4;
const TOTAL_ITERATIONS = 16;

const VU_DELAYS = {
  1: 0.2,
  2: 0.4,
  3: 0.8,
  4: 0.8,
};

// Demo nay dung de nhin ro:
// - shared-iterations khong chia deu iteration cho tung VU
// - VU nhanh hon se lay duoc nhieu iteration hon tu pool chung
// - moi VU co __ITER rieng; so iteration VU do da chay = __ITER + 1
//
// Cong thuc can doi chieu:
// - per_vu_rate ~= 1 / iteration_time
// - peak_total_rate ~= active_vus * per_vu_rate
// - average_total_rate = completed_iterations / actual_scenario_runtime
// - summary iterations/s la average_total_rate cua toan scenario, khong nhan them VUS
//
// Vi du Grafana docs:
// - 1 iteration ~= 515ms = 0.515s
// - 1 VU ~= 1 / 0.515 ~= 1.94 ~= 2 iters/s
// - 10 VUs active => peak_total_rate ~= 10 * 1.94 ~= 20 iters/s
export const options = {
  scenarios: {
    shared_vu_speed_count: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL_ITERATIONS,
      maxDuration: "30s",
      gracefulStop: "5s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

function delayForVU(vuID) {
  return VU_DELAYS[vuID] || 0.8;
}

export default function () {
  const vuID = exec.vu.idInTest;
  const delay = delayForVU(vuID);
  const iterInScenario = exec.scenario.iterationInTest;
  const iterationsSoFarForThisVU = __ITER + 1;

  console.log(
    `[iter-start] vu=${vuID} vuIter=${__ITER} iterInScenario=${iterInScenario} delay=${delay}s t=${elapsedSeconds()}s`,
  );

  sleep(delay);

  console.log(
    `[vu-progress] vu=${vuID} iterationsSoFar=${iterationsSoFarForThisVU} lastVuIter=${__ITER} iterInScenario=${iterInScenario} delay=${delay}s t=${elapsedSeconds()}s`,
  );
}
