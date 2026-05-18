import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";

const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const ITERATIONS_PER_VU = 3;

// Demo nay danh request that vao QuickPizza.
//
// Cong thuc can doi chieu:
// - total_iterations = VUS * ITERATIONS_PER_VU = 4 * 3 = 12
// - moi iteration = http.get() + check() + sleep(1)
// - iteration_duration se tinh ca request, check va sleep(1)
// - summary iterations/s = completed_iterations / actual_scenario_runtime
// - per_vu_rate ~= 1 / iteration_time
// - peak_total_rate ~= active_vus * per_vu_rate
// - average_total_rate = completed_iterations / actual_scenario_runtime
// - summary iterations/s la average_total_rate cua toan scenario, khong nhan them VUS
//
// Vi du Grafana docs:
// - 1 iteration ~= 515ms = 0.515s
// - 1 VU ~= 1 / 0.515 ~= 1.94 ~= 2 iters/s
// - 10 VUs active => peak_total_rate ~= 10 * 1.94 ~= 20 iters/s
//
// Luu y:
// - network time thay doi theo may va internet cua ban
// - vi VUs it va iterations it, output de doc hon
export const options = {
  scenarios: {
    quickpizza_per_vu: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERATIONS_PER_VU,
      maxDuration: "30s",
      gracefulStop: "5s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  const vuID = exec.vu.idInTest;
  const iterationStartMs = Date.now();

  console.log(
    `[iter-start] scenario=${exec.scenario.name} vu=${vuID} iter=${__ITER} t=${elapsedSeconds()}s`,
  );

  const res = http.get(TARGET_URL);

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  sleep(1);

  const iterationMs = Date.now() - iterationStartMs;
  console.log(
    `[iter-end]   scenario=${exec.scenario.name} vu=${vuID} iter=${__ITER} status=${res.status} iterationMs=${iterationMs} t=${elapsedSeconds()}s`,
  );
}
