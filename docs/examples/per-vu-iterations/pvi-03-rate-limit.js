// Case 03: Per-user rate limit verification
//
// Tình huống: SLA: 100 req/min per token. Test: mỗi VU spam 150 request
// liên tục, verify 50 cuối bị 429 + Retry-After header.
//
// Why per-vu-iterations:
//   - Rate limit count theo USER (theo token), không phải theo IP/global
//   - Phải CÙNG VU spam 150 lần liên tục để hit limit
//   - constant-vus random VU pick -> không tạo được "cùng user 150 req"
//
// Run:
//   k6 run pvi-03-rate-limit.js
//
// Pass criteria:
//   - First 100 req: status 200 (count_200_per_vu == 100)
//   - Last 50 req: status 429 (count_429_per_vu == 50)
//   - 429 response có Retry-After header

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "https://quickpizza.grafana.com";
const VUS = 5;
const REQUESTS_PER_VU = 150;
// Mỗi VU = 1 user, gửi 150 request không sleep
// Server SLA: 100 req/min per token

export const options = {
  scenarios: {
    rate_limit_audit: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: REQUESTS_PER_VU,
      maxDuration: "2m",
    },
  },
  thresholds: {
    count_200: [`count==${VUS * 100}`],         // 5 × 100 = 500 OK
    count_429: [`count==${VUS * 50}`],          // 5 × 50 = 250 throttled
  },
};

const count200 = new Counter("count_200");
const count429 = new Counter("count_429");

let userToken = null;

export default function () {
  if (__ITER === 0) {
    userToken = `user-token-${__VU}`;
    console.log(`[VU=${__VU}] start spam test, token=${userToken}`);
  }

  const res = http.get(`${BASE_URL}/api/quotes`, {
    headers: {
      "Authorization": `Bearer ${userToken}`,
      "X-Request-Index": String(__ITER),
    },
    tags: { name: "rate_limit_test", iter: String(__ITER) },
  });

  // Count theo status
  if (res.status === 200) {
    count200.add(1);
  } else if (res.status === 429) {
    count429.add(1);
    // Verify Retry-After header
    check(res, {
      "429 has Retry-After header": (r) =>
        r.headers["Retry-After"] !== undefined,
    });
  }

  // Log key thresholds
  if (__ITER === 99) {
    console.log(`[VU=${__VU}] iter#100: should still be 200, got ${res.status}`);
  }
  if (__ITER === 100) {
    console.log(`[VU=${__VU}] iter#101: should be 429, got ${res.status}`);
  }
  if (__ITER === REQUESTS_PER_VU - 1) {
    console.log(`[VU=${__VU}] all ${REQUESTS_PER_VU} requests done`);
  }

  // KHÔNG sleep -> spam liên tục để hit rate limit
}

export function teardown() {
  console.log(
    `\n━━━ Rate limit audit complete ━━━\n` +
      `VUs (users): ${VUS}\n` +
      `Requests per user: ${REQUESTS_PER_VU}\n` +
      `Expected: ${VUS * 100} × 200, ${VUS * 50} × 429\n`,
  );
}
