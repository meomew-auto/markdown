// Case 05: A/B variant balanced exposure
//
// Tình huống: Marketing chạy A/B test recommendation algorithm.
//   - 50% users nhận variant A (collaborative filtering)
//   - 50% users nhận variant control (popular items)
//   - Mỗi user nhận ĐÚNG 1 variant cố định
//   - Verify exposure balanced sau khi test xong
//
// Why per-vu-iterations:
//   - Variant assignment dùng __VU % 2 -> deterministic
//   - 1 user = 1 variant nhất quán qua tất cả iter
//   - ramping-vus skew exposure (variant lazy assign theo time)
//   - constant-vus random pick có thể gây skew khi test ngắn
//
// Run:
//   k6 run pvi-05-ab-variant.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const VUS = 100;             // 100 users (50 + 50)
const VIEWS_PER_VU = 5;      // mỗi user xem 5 trang
// Total = 500 views

export const options = {
  scenarios: {
    ab_test: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: VIEWS_PER_VU,
      maxDuration: "3m",
    },
  },
  thresholds: {
    variant_a_count: [`count==${(VUS / 2) * VIEWS_PER_VU}`],     // 250
    variant_control_count: [`count==${(VUS / 2) * VIEWS_PER_VU}`], // 250
  },
};

const variantA = new Counter("variant_a_count");
const variantControl = new Counter("variant_control_count");

let userVariant = null;
let userSegment = null;

export default function () {
  // Iter 0: assign variant deterministic theo VU
  if (__ITER === 0) {
    userVariant = __VU % 2 === 0 ? "a" : "control";
    userSegment = __VU < 50 ? "premium" : "free";
    console.log(
      `[VU=${__VU}] assigned variant=${userVariant}, segment=${userSegment}`,
    );
  }

  // GET homefeed với variant header
  // Real endpoint: GET /api/sim/products/homefeed
  const res = http.get(
    `${BASE_URL}/api/sim/products/homefeed?personalized=1&cpu_ms=2&db_rows=5`,
    {
      headers: {
        "X-User-Segment": userSegment,
        "X-Ab-Variant": userVariant,
      },
      tags: {
        name: "homefeed",
        variant: userVariant,
        segment: userSegment,
      },
    },
  );

  check(res, { "homefeed: 200": (r) => r.status === 200 });

  // Count variant exposure
  if (userVariant === "a") {
    variantA.add(1);
  } else {
    variantControl.add(1);
  }

  // Recommendation request (chỉ variant A có)
  if (userVariant === "a") {
    const productId = ((__VU + __ITER) % 5) + 1;
    http.get(
      `${BASE_URL}/api/sim/products/${productId}/recommendations?algorithm=collaborative&cpu_ms=3&db_rows=3`,
      {
        headers: { "X-Ab-Variant": "a" },
        tags: { name: "recommendations", variant: "a" },
      },
    );
  }

  sleep(0.3);
}

export function teardown() {
  console.log(
    `\n━━━ A/B test complete ━━━\n` +
      `Total users: ${VUS} (${VUS / 2} A + ${VUS / 2} control)\n` +
      `Views per user: ${VIEWS_PER_VU}\n` +
      `Expected: ${(VUS / 2) * VIEWS_PER_VU} variant_a + ${(VUS / 2) * VIEWS_PER_VU} control\n`,
  );
}
