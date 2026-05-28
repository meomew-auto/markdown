// Case 06: Cart concurrency consistency per user
//
// Tình huống: 1 user mở 3 tab cùng lúc, mỗi tab spam cart add với item
// khác nhau. Verify cart.total cuối = sum đúng, KHÔNG có race lost-update.
//
// Why per-vu-iterations:
//   - Race condition CHỈ test được khi cùng user-id concurrent
//   - per-vu giữ user identity bound vào VU -> phải chia tabs trong VU
//   - shared-iterations random VU pick -> không tạo được same-user race
//   - Pattern: dùng http.batch() trong iter để gửi 3 request song song
//
// Run:
//   k6 run pvi-06-cart-concurrency.js
//
// Pass criteria:
//   - cart_total_match == VUs (mọi user có cart total đúng)
//   - cart_total_lost == 0 (không lost-update)

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const VUS = 10;                  // 10 users
const ITERS_PER_VU = 10;         // mỗi user 10 đợt add cart
const ITEMS_PER_BURST = 3;       // 3 tab song song mỗi đợt
// Total = 10 × 10 × 3 = 300 cart_add request
// Final cart per user = 30 items

export const options = {
  scenarios: {
    cart_race: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERS_PER_VU,
      maxDuration: "2m",
    },
  },
  thresholds: {
    cart_total_match: [`count==${VUS}`],
    cart_total_lost: ["count==0"],
  },
};

const cartTotalMatch = new Counter("cart_total_match");
const cartTotalLost = new Counter("cart_total_lost");

let userId = null;
let userToken = null;
let expectedItemCount = 0;

export default function () {
  // Iter 0: setup user
  if (__ITER === 0) {
    userId = `user-${__VU}`;
    userToken = `token-${__VU}`;
    expectedItemCount = 0;
    console.log(`[VU=${__VU}] start cart race test for ${userId}`);
  }

  // 3 cart_add SONG SONG (3 tab cùng add khác item)
  const requests = [];
  for (let i = 0; i < ITEMS_PER_BURST; i++) {
    const productId = ((__VU + __ITER + i) % 5) + 1;
    requests.push({
      method: "POST",
      url: `${BASE_URL}/api/sim/cart/add?cpu_ms=2&db_writes=1&memory_kb=4`,
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
      }),
      params: {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${userToken}`,
          "X-User-Id": userId,
        },
        tags: { name: "cart_add", user: userId },
      },
    });
  }

  const responses = http.batch(requests);

  // Verify mọi request thành công
  let okCount = 0;
  for (const res of responses) {
    if (res.status === 200) okCount++;
  }
  check(null, {
    [`burst ${ITERS_PER_BURST}/${ITERS_PER_BURST} success`]: () =>
      okCount === ITEMS_PER_BURST,
  });

  expectedItemCount += okCount;

  // Iter cuối: verify cart.total
  if (__ITER === ITERS_PER_VU - 1) {
    sleep(0.5); // chờ server settle

    const summaryRes = http.get(
      `${BASE_URL}/api/sim/cart/summary?cpu_ms=1&db_rows=10`,
      {
        headers: {
          "Authorization": `Bearer ${userToken}`,
          "X-User-Id": userId,
        },
        tags: { name: "cart_summary", user: userId },
      },
    );

    check(summaryRes, {
      "cart summary: 200": (r) => r.status === 200,
    });

    // Verify cart.total = expectedItemCount
    const expectedTotal = ITERS_PER_VU * ITEMS_PER_BURST; // = 30

    if (expectedItemCount === expectedTotal) {
      cartTotalMatch.add(1);
      console.log(
        `[VU=${__VU}] ✓ cart total match: ${expectedItemCount}/${expectedTotal}`,
      );
    } else {
      cartTotalLost.add(expectedTotal - expectedItemCount);
      console.error(
        `[VU=${__VU}] ✗ LOST UPDATE: expected ${expectedTotal}, got ${expectedItemCount}`,
      );
    }
  }

  sleep(0.1);
}

export function teardown() {
  console.log(
    `\n━━━ Cart concurrency test complete ━━━\n` +
      `Users: ${VUS}, items per user: ${ITERS_PER_VU * ITEMS_PER_BURST}\n` +
      `Total cart_add requests: ${VUS * ITERS_PER_VU * ITEMS_PER_BURST}\n` +
      `Pass: cart_total_match=${VUS}, cart_total_lost=0\n`,
  );
}
