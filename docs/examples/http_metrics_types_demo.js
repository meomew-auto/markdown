import http from "k6/http";
import { check } from "k6";

export const options = {
  noConnectionReuse: true,
  scenarios: {
    http_metrics_types_demo: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "30s",
    },
  },
  thresholds: {
    http_reqs: ["count==6"],
    http_req_blocked: ["avg>=0"],
    http_req_connecting: ["avg>=0"],
    http_req_duration: ["avg>=0"],
    "http_req_failed{endpoint:status_200}": ["rate<0.01"],
    "http_req_failed{endpoint:status_500_default}": ["rate>0.99"],
    "http_req_failed{endpoint:status_500_expected}": ["rate<0.01"],
    http_req_receiving: ["avg>=0"],
    http_req_sending: ["avg>=0"],
    http_req_tls_handshaking: ["avg>=0"],
    http_req_waiting: ["avg>=0"],
  },
};

export default function () {
  const ok = http.get("https://httpbin.org/status/200", {
    tags: { endpoint: "status_200" },
  });

  const failByDefault = http.get("https://httpbin.org/status/500", {
    tags: { endpoint: "status_500_default" },
  });

  const expected500 = http.get("https://httpbin.org/status/500", {
    tags: { endpoint: "status_500_expected" },
    responseCallback: http.expectedStatuses(500),
  });

  check(
    ok,
    {
      "status_200 returns 200": (r) => r.status === 200,
    },
    { endpoint: "status_200" },
  );

  check(
    failByDefault,
    {
      "status_500_default returns 500": (r) => r.status === 500,
    },
    { endpoint: "status_500_default" },
  );

  check(
    expected500,
    {
      "status_500_expected returns 500": (r) => r.status === 500,
    },
    { endpoint: "status_500_expected" },
  );
}
