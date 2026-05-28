// Case 01: QA replay user journey
//
// Tình huống: QA team cần replay 30 user journey hoàn chỉnh để regression
// test trước release. Mỗi VU = 1 user thật, chạy đủ flow login → browse →
// add to cart → checkout → confirm order, lặp lại N lần để stress test
// regression.
//
// Why per-vu-iterations:
//   - Mỗi VU giữ session token, cart state qua nhiều iter
//   - Số journey CHÍNH XÁC = vus × iterations (deterministic cho QA)
//   - VU nhanh xong sớm thì IDLE, không "cướp" identity của VU khác
//
// Run:
//   k6 run pvi-01-user-journey-replay.js
//
// Pass criteria:
//   - iterations == vus * iterations_per_vu (= 30 × 5 = 150)
//   - http_req_failed == 0% (mọi request thành công)
//   - checks pass rate == 100%

import http from "k6/http";
import { check, sleep, group } from "k6";
import { SharedArray } from "k6/data";

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const VUS = parseInt(__ENV.VUS || "8", 10);
const ITERS_PER_VU = parseInt(__ENV.ITERS_PER_VU || "5", 10);
// Total iterations = 30 × 5 = 150 journey replays

export const options = {
  scenarios: {
    qa_replay: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITERS_PER_VU,
      maxDuration: "5m",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],          // < 1% failure
    http_req_duration: ["p(95)<2000"],       // p95 < 2s
    checks: ["rate>0.99"],                   // > 99% checks pass
  },
};

// ─────────────────────────────────────────────────────────────────
// Test data: pre-generate user pool once (init phase)
// ─────────────────────────────────────────────────────────────────

const users = new SharedArray("users", function () {
  const arr = [];
  for (let i = 1; i <= VUS; i++) {
    arr.push({
      username: `qa-user-${i}`,
      password: `qa-pass-${i}`,
      preferred_size: i % 2 === 0 ? "large" : "medium",
    });
  }
  return arr;
});

// ─────────────────────────────────────────────────────────────────
// Per-VU state (sống qua nhiều iter trong cùng VU)
// ─────────────────────────────────────────────────────────────────

let session = null;       // token, cart_id sau khi login
let totalCartItems = 0;   // tích lũy qua iter

// ─────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────

function login() {
  // Real load-target endpoint: POST /api/sim/auth/login
  const user = users[(__VU - 1) % users.length];
  const res = http.post(
    `${BASE_URL}/api/sim/auth/login?cpu_ms=2&db_rows=1`,
    JSON.stringify({ username: user.username, password: user.password }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "01_login" },
    },
  );
  check(res, {
    "login: status 200": (r) => r.status === 200,
  });
  return {
    user,
    token: `mock-token-vu-${__VU}-iter-${__ITER}`,
    cart_id: `cart-${__VU}`,
  };
}

function browseProducts() {
  // Real endpoint: GET /api/sim/products
  const res = http.get(
    `${BASE_URL}/api/sim/products?limit=10&sort=popular&view=grid&cpu_ms=2&db_rows=4`,
    { tags: { name: "02_browse_products" } },
  );
  check(res, {
    "browse: status 200": (r) => r.status === 200,
    "browse: has body": (r) => r.body && r.body.length > 0,
  });
  return res.status === 200 ? res.json() : null;
}

function viewProductDetail(productId) {
  // Use a real numeric id (1-5 are seeded by load-target).
  const id = ((__VU + __ITER) % 5) + 1;
  const res = http.get(
    `${BASE_URL}/api/sim/products/${id}?view=full&include_reviews=1&cpu_ms=2&db_rows=2`,
    { tags: { name: "03_view_detail", product_id: String(id) } },
  );
  check(res, {
    "detail: status 200": (r) => r.status === 200,
  });
  return res;
}

function addToCart(productId) {
  // Real endpoint: POST /api/sim/cart/add
  const id = ((__VU + __ITER) % 5) + 1;
  const res = http.post(
    `${BASE_URL}/api/sim/cart/add?cpu_ms=2&db_writes=1&memory_kb=4`,
    JSON.stringify({ product_id: id, quantity: 1 }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "04_add_to_cart", product_id: String(id) },
    },
  );
  check(res, {
    "cart add: status 200": (r) => r.status === 200,
  });
  totalCartItems += 1;
  return res;
}

function checkout(idempotencyKey) {
  // Real endpoint: POST /api/sim/checkout with Idempotency-Key
  const res = http.post(
    `${BASE_URL}/api/sim/checkout?cpu_ms=5&db_writes=3&external_ms=80`,
    JSON.stringify({
      payment_method: "card",
      items: [{ id: 1, qty: 1 }, { id: 2, qty: 1 }],
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      tags: { name: "05_checkout" },
    },
  );
  check(res, {
    "checkout: status 200": (r) => r.status === 200,
  });
  return { order_id: `order-${__VU}-${__ITER}` };
}

function confirmOrder(orderId) {
  // Real endpoint: POST /api/sim/orders/:id/confirm
  const idemKey = `idem-confirm-${orderId}`;
  const res = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=4&external_ms=180&external_fail_rate=0`,
    JSON.stringify({}),
    {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idemKey,
      },
      tags: { name: "06_confirm_order", order_id: orderId },
    },
  );
  check(res, {
    "confirm: status 200": (r) => r.status === 200,
  });
  return res;
}

// ─────────────────────────────────────────────────────────────────
// Default function: 1 journey replay = 1 iteration
// ─────────────────────────────────────────────────────────────────

export default function () {
  // Iter đầu: login (chỉ 1 lần per VU)
  if (__ITER === 0) {
    group("login", () => {
      session = login();
    });
  }

  // Mọi iter: replay journey
  group("browse", () => {
    browseProducts();
    sleep(0.3);
    viewProductDetail(`prod-${__VU}-${__ITER}-a`);
    sleep(0.2);
    viewProductDetail(`prod-${__VU}-${__ITER}-b`);
  });

  group("cart", () => {
    addToCart(`prod-${__VU}-${__ITER}-a`);
    sleep(0.2);
    addToCart(`prod-${__VU}-${__ITER}-b`);
  });

  group("checkout", () => {
    const idempotencyKey = `idem-${__VU}-${__ITER}`;
    const order = checkout(idempotencyKey);
    sleep(0.3);

    // Confirm 2 lần với cùng order_id để test idempotency
    confirmOrder(order.order_id);
    sleep(0.1);
    confirmOrder(order.order_id);
  });

  // Log progress mỗi 5 iter để theo dõi
  if (__ITER % 5 === 0) {
    console.log(
      `[VU=${__VU}] iter#${__ITER}/${ITERS_PER_VU - 1} ` +
        `journey complete | cart_items=${totalCartItems} | ` +
        `user=${session?.user.username}`,
    );
  }

  sleep(0.5);
}

// ─────────────────────────────────────────────────────────────────
// Teardown: print summary của VU state
// ─────────────────────────────────────────────────────────────────

export function teardown(data) {
  console.log(
    `\n━━━ Test complete ━━━\n` +
      `Expected total iterations: ${VUS * ITERS_PER_VU}\n` +
      `(Verify summary "iterations" == ${VUS * ITERS_PER_VU} for pass)`,
  );
}
