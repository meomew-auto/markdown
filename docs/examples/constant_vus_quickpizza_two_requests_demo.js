import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";

export const options = {
  scenarios: {
    quickpizza_constant_vus: {
      executor: "constant-vus",
      vus: 4,
      duration: "5s",
      gracefulStop: "5s",
    },
  },
};

function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

export default function () {
  const home = http.get("https://quickpizza.grafana.com/");
  const quotes = http.get("https://quickpizza.grafana.com/api/quotes");

  check(home, {
    "home status is 200": (res) => res.status === 200,
  });
  check(quotes, {
    "quotes status is 200": (res) => res.status === 200,
  });

  console.log(
    `[iter] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(1);
}
