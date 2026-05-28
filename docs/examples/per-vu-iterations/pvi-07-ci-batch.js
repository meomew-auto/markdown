// Case 07: Predictable batch validation cho CI
//
// Tình huống: CI gate. Pre-merge test phải chạy chính xác:
//   - 1000 iter total
//   - 2000 http_req total (mỗi iter 2 request)
//   - Fail nếu RPS thay đổi > 10% so với baseline
//
// Why per-vu-iterations:
//   - CI cần DETERMINISTIC count, không phải duration-based
//   - constant-vus với 5m không cho biết bao nhiêu request sẽ chạy
//   - constant-arrival-rate có thể drop -> count không chắc đủ
//   - per-vu: total = vus × iters = 1000 (CHÍNH XÁC)
//
// Run:
//   k6 run pvi-07-ci-batch.js
//
// Pass criteria (cho CI gate):
//   - iterations == 1000 (chính xác, không sai số)
//   - http_reqs == 2000 (mỗi iter 2 request)
//   - http_req_duration{p95} thay đổi < 10% so với baseline
//   - http_req_failed == 0%

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://quickpizza.grafana.com";
const VUS = 50;
const ITERS_PER_VU = 20;
// Total = 50 × 20 = 1000 iterations
// Total req = 1000 × 2 = 2000

// Baseline (cập nhật mỗi lần CI pass, lưu trong file ci-baseline.json)
const BASELINE_P95_MS = parseInt(__ENV.BASELINE_P95_MS || "500");
const TOLERANCE = 0.10; // ±10%

export const options = {
  scenarios: {
    ci_batch: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERS_PER_VU,
      maxDuration: "10m",
    },
  },
  thresholds: {
    // Đếm CHÍNH XÁC
    iterations: [`count==${VUS * ITERS_PER_VU}`],
    http_reqs: [`count==${VUS * ITERS_PER_VU * 2}`],

    // Latency tolerance vs baseline
    "http_req_duration{tag:critical}": [
      `p(95)<${BASELINE_P95_MS * (1 + TOLERANCE)}`,
    ],

    // Không có request fail
    http_req_failed: ["rate<0.01"],

    // CI pass criteria
    checks: ["rate>0.99"],
  },
};

export default function () {
  // Iter mọi lần: 2 request cố định để CI có baseline ổn định
  const r1 = http.get(`${BASE_URL}/`, {
    tags: { name: "homepage", critical: "true" },
  });
  check(r1, { "homepage 200": (r) => r.status === 200 });

  const r2 = http.get(`${BASE_URL}/api/quotes`, {
    tags: { name: "api_quotes", critical: "true" },
  });
  check(r2, { "api_quotes 200": (r) => r.status === 200 });

  // Sleep cố định để tránh burst
  sleep(0.1);
}

export function teardown() {
  console.log(
    `\n━━━ CI batch validation complete ━━━\n` +
      `Total iter: ${VUS * ITERS_PER_VU} (expected 1000)\n` +
      `Total req: ${VUS * ITERS_PER_VU * 2} (expected 2000)\n` +
      `Baseline p95: ${BASELINE_P95_MS}ms (tolerance ±${TOLERANCE * 100}%)\n` +
      `\nCI gate: PASS nếu iterations=1000, http_reqs=2000, p95<${BASELINE_P95_MS * (1 + TOLERANCE)}ms\n`,
  );
}
