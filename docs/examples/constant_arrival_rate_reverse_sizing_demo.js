// Demo: Tinh huong 2 — "Da co san N VU, hoi chiu duoc rate cao nhat la bao nhieu?"
//
// Quy trinh 3 buoc (tu cheat sheet constant-arrival-rate):
//   Buoc 1: Do iter_time (chay thu 1 VU)
//   Buoc 2: Tinh capacity = N / iter_time (CT4)
//   Buoc 3: So voi rate config → rate <= capacity: khong drop
//                                 rate > capacity: drop_rate = rate - capacity (CT5)
//
// File nay mo phong tinh huong: da biet so VU co san (vd gioi han tai khoan,
// server gioi han connection), muon uoc luong rate toi da pool nay chiu duoc.
//
// Cach dung:
//   k6 run examples/constant_arrival_rate_reverse_sizing_demo.js          # N=6, R=8
//   k6 run -e VUS=4 -e TEST_RATE=12 examples/constant_arrival_rate_reverse_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham so ───────────────────────────────────────────────
const AVAILABLE_VUS = __ENV.VUS ? Number(__ENV.VUS) : 6;      // N: so VU co san
const ITER_TIME_SEC = 0.5; // W: thoi gian 1 iter (gia lap HTTP)
const TEST_RATE = __ENV.TEST_RATE ? Number(__ENV.TEST_RATE) : 8;  // R: rate muon test
const DURATION = "10s";
const TIME_UNIT = "1s";

// ─── Tinh toan ────────────────────────────────────────────
const N = AVAILABLE_VUS;
const W = ITER_TIME_SEC;
const R = TEST_RATE;
const capacity = N / W;           // CT4: nang luc pool
const dropRate = Math.max(0, R - capacity);  // CT5: drop du kien moi giay
const willDrop = dropRate > 0;
const totalDropEstimate = dropRate * 10; // duration = 10s

export const options = {
  scenarios: {
    reverse_sizing: {
      executor: "constant-arrival-rate",
      rate: R,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: N,
      maxVUs: N,
      gracefulStop: "5s",
    },
  },
};

// ─── In ke hoach truoc khi chay (chi in 1 lan) ────────────
if (__VU === 1) {
  const N_sched = R * 10; // rate x duration (duration=10s, timeUnit=1s)
  console.log(String.raw`
╔══════════════════════════════════════════════════════════╗
║  TINH HUONG 2: Co N VU, hoi chiu rate cao nhat?        ║
╠══════════════════════════════════════════════════════════╣
║                                                        ║
║  Buoc 1 — Do iter_time:                                ║
║    W = sleep(${ITER_TIME_SEC}) = ${ITER_TIME_SEC}s                              ║
║    (gia lap request HTTP mat ${ITER_TIME_SEC}s)                      ║
║                                                        ║
║  Buoc 2 — Tinh capacity (CT4):                        ║
║    capacity = N / W                                   ║
║             = ${N} / ${ITER_TIME_SEC}                                    ║
║             = ${capacity} iter/s                               ║
║                                                        ║
║  Buoc 3 — So voi rate config R = ${R}:                    ║
║    R(${R}) vs capacity(${capacity}):                              ║
║    → ${willDrop ? `R > capacity => se DROP ${dropRate} iter/s` : `R <= capacity => khong drop`}      ║
║    → N_sched = R x duration = ${R} x 10 = ${N_sched}                    ║
║    → Drop du kien = drop_rate x duration                            ║
║                   = ${dropRate} x 10 = ${totalDropEstimate} iter                        ║
║    → N_done du kien ≈ ${N_sched} - ${totalDropEstimate} = ${N_sched - totalDropEstimate}                      ║
╚══════════════════════════════════════════════════════════╝
`);
}

// ─── Theo doi thoi gian scenario ────────────────────────
function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

// ─── Iteration ──────────────────────────────────────────
export default function () {
  console.log(
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(ITER_TIME_SEC); // gia lap request HTTP
}

// ─── Xu ly ket thuc ─────────────────────────────────────
export function teardown() {
  console.log("\n─── Kiem tra output ───────────────────────────");
  console.log("  Nhin dong summary:");
  console.log("    iterations..............: N_done");
  console.log("    dropped_iterations......: N_drop");
  console.log("");
  console.log("  Cong thuc verify:");
  console.log("    N_done + N_drop ≈ N_sched = R x duration");
  console.log("");
  if (willDrop) {
    console.log(`  Drop du kien: ${totalDropEstimate} iter (${dropRate}/s x 10s)`);
    console.log("  → Neu N_drop ≈ so nay => CT5 chinh xac");
    console.log("  → Neu N_drop > so nay => iter_time thuc te > W (code cham)");
    console.log("  → Neu N_drop < so nay => iter_time thuc te < W (code nhanh)");
  } else {
    console.log("  Drop du kien: 0 (R <= capacity)");
    console.log("  → dropped_iterations = 0 => CT4 chinh xac");
  }
}
