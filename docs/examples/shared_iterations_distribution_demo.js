import exec from "k6/execution";
import { sleep } from "k6";

const VUS = 4;
const TOTAL_ITERATIONS = 12;
const FAST_VU_SECONDS = 0.2;
const SLOW_VU_SECONDS = 0.6;

// Demo nay cho thay diem quan trong cua shared-iterations:
// - iterations la tong so iteration cua scenario
// - cac VU cung lay viec tu mot pool chung
// - VU nao nhanh hon co the chay nhieu iteration hon
//
// Khac voi per-vu-iterations:
// - per-vu-iterations: moi VU co dung N iteration rieng
// - shared-iterations: tong N iteration duoc chia cho cac VU
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
    shared_distribution: {
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
  return vuID === 1 ? FAST_VU_SECONDS : SLOW_VU_SECONDS;
}

export default function () {
  const vuID = exec.vu.idInTest;
  const delay = delayForVU(vuID);
  const iterInScenario = exec.scenario.iterationInTest;

  console.log(
    `[iter-start] vu=${vuID} __ITER=${__ITER} iterInScenario=${iterInScenario} delay=${delay}s t=${elapsedSeconds()}s`,
  );

  sleep(delay);

  console.log(
    `[iter-end]   vu=${vuID} __ITER=${__ITER} iterInScenario=${iterInScenario} delay=${delay}s t=${elapsedSeconds()}s`,
  );
}
