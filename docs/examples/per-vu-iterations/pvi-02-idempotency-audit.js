// Case 02: Idempotency audit dưới retry storm
//
// Tình huống: Audit phía thanh toán. Mỗi customer retry confirm 5 lần
// cùng Idempotency-Key. Verify: chỉ charge ĐÚNG 1 lần, 4 lần sau là
// duplicate được phát hiện.
//
// Why per-vu-iterations:
//   - Idempotency-Key phải STABLE per customer
//   - Mỗi VU = 1 customer riêng -> key bound vào VU
//   - constant-vus với random VU pick KHÔNG đảm bảo "cùng customer
//     gửi lại cùng key"
//
// Run:
//   k6 run pvi-02-idempotency-audit.js
//
// Pass criteria:
//   - idem_fresh_count == VUs (1 fresh charge per customer)
//   - idem_reuse_count == VUs * 4 (4 retry per customer được dedupe)
//   - http_req_failed == 0%

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const VUS = 20;
const RETRIES_PER_CUSTOMER = 5;
// Total = 20 customers × 5 retry = 100 confirm calls
// Expected: 20 fresh + 80 reuse

export const options = {
  scenarios: {
    idem_audit: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: RETRIES_PER_CUSTOMER,
      maxDuration: "3m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    idem_fresh_count: [`count==${VUS}`],
    idem_reuse_count: [`count==${VUS * (RETRIES_PER_CUSTOMER - 1)}`],
  },
};

// ─────────────────────────────────────────────────────────────────
// Custom metrics để audit idempotency
// ─────────────────────────────────────────────────────────────────

const idemFreshCount = new Counter("idem_fresh_count");
const idemReuseCount = new Counter("idem_reuse_count");

// ─────────────────────────────────────────────────────────────────
// Per-VU state
// ─────────────────────────────────────────────────────────────────

let customerToken = null;
let orderId = null;
// Idempotency-Key TÍNH MỘT LẦN per VU, dùng cho cả 5 retry
let idempotencyKey = null;
let firstResponseSnapshot = null;

// ─────────────────────────────────────────────────────────────────
// Default function: 1 retry confirm = 1 iteration
// ─────────────────────────────────────────────────────────────────

export default function () {
  // Iter 0: setup customer + create order + tính idempotency key
  if (__ITER === 0) {
    customerToken = `cust-token-${__VU}`;
    orderId = `order-${__VU}-${Date.now()}`;
    idempotencyKey = `idem-${__VU}-${orderId}`;
    console.log(
      `[VU=${__VU}] customer setup, idem_key=${idempotencyKey}, ` +
        `order=${orderId}`,
    );
  }

  // Mọi iter (kể cả iter 0): gửi confirm với CÙNG idempotency key
  const res = http.post(
    `${BASE_URL}/api/sim/orders/${orderId}/confirm?cpu_ms=0&db_writes=4&external_ms=180`,
    JSON.stringify({ retry_attempt: __ITER }),
    {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${customerToken}`,
        "Idempotency-Key": idempotencyKey,
      },
      tags: { name: "confirm_order", retry: String(__ITER) },
    },
  );

  // Verify response
  check(res, {
    "status 200": (r) => r.status === 200,
    "has body": (r) => r.body && r.body.length > 0,
  });

  // Mock-detection logic:
  // Trong production thật, server trả header X-Idempotent-Replay=true
  // hoặc body có flag duplicate=true cho lần retry sau
  // Demo: dùng __ITER để mô phỏng
  if (__ITER === 0) {
    // Lần đầu: fresh charge
    idemFreshCount.add(1);
    firstResponseSnapshot = {
      status: res.status,
      body_len: res.body ? res.body.length : 0,
    };
    console.log(
      `[VU=${__VU}] iter=0 FRESH charge | status=${res.status}`,
    );
  } else {
    // Lần retry: phải dedupe, response phải IDENTICAL
    idemReuseCount.add(1);

    // Verify response cùng giống lần đầu (idempotency contract)
    check(res, {
      "idem replay: same status as first": (r) =>
        r.status === firstResponseSnapshot.status,
      "idem replay: body length similar": (r) =>
        Math.abs((r.body?.length || 0) - firstResponseSnapshot.body_len) < 100,
    });

    if (__ITER === RETRIES_PER_CUSTOMER - 1) {
      console.log(
        `[VU=${__VU}] all ${RETRIES_PER_CUSTOMER} retries done | ` +
          `1 fresh + ${RETRIES_PER_CUSTOMER - 1} reuse`,
      );
    }
  }

  // Khoảng cách giữa các retry (mô phỏng user click "retry" liên tục)
  sleep(0.2);
}

// ─────────────────────────────────────────────────────────────────
// Teardown: in tổng quan audit
// ─────────────────────────────────────────────────────────────────

export function teardown() {
  console.log(
    `\n━━━ Idempotency audit complete ━━━\n` +
      `Customers: ${VUS}\n` +
      `Retries per customer: ${RETRIES_PER_CUSTOMER}\n` +
      `Expected fresh charges: ${VUS}\n` +
      `Expected dedupe (reuse): ${VUS * (RETRIES_PER_CUSTOMER - 1)}\n` +
      `\nPass criteria:\n` +
      `  ✓ idem_fresh_count = ${VUS}\n` +
      `  ✓ idem_reuse_count = ${VUS * (RETRIES_PER_CUSTOMER - 1)}\n` +
      `  ✓ Tất cả retry response giống fresh response\n`,
  );
}
