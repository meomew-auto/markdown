import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";

const TARGET_URL = "https://quickpizza.grafana.com/";
const VUS = 4;
const ITERATIONS_PER_VU = 3;

// Demo nay giu nguyen executor per-vu-iterations nhu file QuickPizza truoc,
// nhung moi iteration goi 2 HTTP requests thay vi 1.
//
// Cong thuc can doi chieu:
// - total_iterations = VUS * ITERATIONS_PER_VU = 4 * 3 = 12
// - http_requests_per_iteration = 2
// - total_http_requests = total_iterations * 2 = 24
// - moi iteration = http.get() + http.get() + 2 checks + sleep(1)
// - summary http_reqs/s se khong con bang 1 / http_req_duration
// - summary http_reqs/s se xap xi 2 * iterations/s
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
    quickpizza_two_requests_per_vu: {
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

  const res1 = http.get(TARGET_URL);
  const res2 = http.get(TARGET_URL);

  check(res1, {
    "request 1 status is 200": (r) => r.status === 200,
  });

  check(res2, {
    "request 2 status is 200": (r) => r.status === 200,
  });

  sleep(1);

  const iterationMs = Date.now() - iterationStartMs;
  console.log(
    `[iter-end]   scenario=${exec.scenario.name} vu=${vuID} iter=${__ITER} status1=${res1.status} status2=${res2.status} iterationMs=${iterationMs} t=${elapsedSeconds()}s`,
  );
}
