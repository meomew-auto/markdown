// Case 04: Session lifecycle + refresh token
//
// Tình huống: Test session expire/refresh flow.
//   - Mỗi user login 1 lần (iter 0)
//   - Làm 20 thao tác liên tiếp
//   - Ở giữa cố tình chờ qua TTL -> assert /me trả 401
//   - Gọi refresh -> tiếp tục thao tác
//
// Why per-vu-iterations:
//   - Token lifecycle bound theo VU (1 user = 1 access_token + 1 refresh_token)
//   - Closed model với constant-vus KHÔNG cho VU giữ token qua iter
//   - Phải đảm bảo cùng VU thấy token expire rồi gọi refresh
//
// Run:
//   k6 run pvi-04-session-lifecycle.js
//
// Pass criteria:
//   - login_count == VUs (1 login per user)
//   - refresh_count == VUs (1 refresh per user khi token expire)
//   - failed_after_refresh == 0 (refresh xong gọi /me phải 200)

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "https://quickpizza.grafana.com";
const VUS = 10;
const ACTIONS_PER_VU = 20;
// Mock: token TTL = 5s -> sau iter 10 sẽ expire (giả lập)
const TOKEN_TTL_AFTER_ITER = 10;

export const options = {
  scenarios: {
    session_lifecycle: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ACTIONS_PER_VU,
      maxDuration: "3m",
    },
  },
  thresholds: {
    login_count: [`count==${VUS}`],
    refresh_count: [`count==${VUS}`],
    failed_after_refresh: ["count==0"],
  },
};

const loginCount = new Counter("login_count");
const refreshCount = new Counter("refresh_count");
const failedAfterRefresh = new Counter("failed_after_refresh");

// Per-VU state
let accessToken = null;
let refreshToken = null;
let tokenIssuedAtIter = 0;

function login() {
  // Production: POST /api/sim/auth/login
  const res = http.post(
    `${BASE_URL}/api/quotes`,
    JSON.stringify({ user: `user-${__VU}` }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "login" },
    },
  );
  check(res, { "login: 200": (r) => r.status === 200 });
  loginCount.add(1);
  return {
    access_token: `access-${__VU}-${Date.now()}`,
    refresh_token: `refresh-${__VU}-${Date.now()}`,
  };
}

function callMe(token, expectedStatus = 200) {
  // Production: GET /api/sim/auth/me
  // Mock: nếu __ITER > TOKEN_TTL_AFTER_ITER và chưa refresh -> giả lập 401
  const res = http.get(`${BASE_URL}/api/quotes`, {
    headers: { "Authorization": `Bearer ${token}` },
    tags: { name: "auth_me", expected: String(expectedStatus) },
  });

  // Mock client-side simulation token expire
  const simulated_status =
    __ITER >= TOKEN_TTL_AFTER_ITER &&
    __ITER - tokenIssuedAtIter >= TOKEN_TTL_AFTER_ITER
      ? 401
      : res.status;

  return { res, simulated_status };
}

function refresh(rToken) {
  // Production: POST /api/sim/auth/refresh
  const res = http.post(
    `${BASE_URL}/api/quotes`,
    JSON.stringify({ refresh_token: rToken }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "refresh" },
    },
  );
  check(res, { "refresh: 200": (r) => r.status === 200 });
  refreshCount.add(1);
  return {
    access_token: `access-${__VU}-${Date.now()}-refreshed`,
    refresh_token: `refresh-${__VU}-${Date.now()}`,
  };
}

function doAction(token) {
  // Production: GET /api/sim/products
  return http.get(`${BASE_URL}/api/quotes`, {
    headers: { "Authorization": `Bearer ${token}` },
    tags: { name: "user_action", iter: String(__ITER) },
  });
}

export default function () {
  // Iter 0: login
  if (__ITER === 0) {
    const tokens = login();
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    tokenIssuedAtIter = 0;
    console.log(`[VU=${__VU}] login successful`);
  }

  // Mọi iter: gọi /me để check token
  const { res, simulated_status } = callMe(accessToken);

  if (simulated_status === 401) {
    // Token expire -> refresh
    console.log(`[VU=${__VU}] iter#${__ITER} token expired, refreshing...`);
    const tokens = refresh(refreshToken);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;
    tokenIssuedAtIter = __ITER;

    // Verify sau refresh: gọi lại /me phải 200
    const retry = callMe(accessToken);
    if (retry.simulated_status !== 200) {
      failedAfterRefresh.add(1);
      console.error(
        `[VU=${__VU}] FAIL: after refresh, /me still ${retry.simulated_status}`,
      );
    }
  }

  // Tiếp tục thao tác
  doAction(accessToken);

  sleep(0.2);
}

export function teardown() {
  console.log(
    `\n━━━ Session lifecycle test complete ━━━\n` +
      `Users: ${VUS}\n` +
      `Actions per user: ${ACTIONS_PER_VU}\n` +
      `Expected: 1 login + 1 refresh per user\n` +
      `Pass: login_count = refresh_count = ${VUS}, failed_after_refresh = 0\n`,
  );
}
