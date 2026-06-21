// Demo: Tinh huong 1 — "Sap viet config, khong biet dat so bao nhieu"
//
// Quy trinh 4 buoc (tu cheat sheet constant-arrival-rate):
//   Buoc 1: Chon rate target (R iter/timeUnit)
//   Buoc 2: Do iter_time (chay thu 1 VU)
//   Buoc 3: Tinh preAllocatedVUs = ceil(R x iter_time / timeUnit_s) x 1.2
//   Buoc 4: Dat config, chay, kiem tra summary
//
// File nay mo phong tinh huong: hoc sinh da co script (sleep gia request HTTP),
// muon test chay o toc do target R iter/s, nhung chua biet dat preAllocatedVUs
// bao nhieu.
//
// Cach dung:
//   k6 run examples/constant_arrival_rate_sizing_demo.js              # R = 10
//   k6 run -e TARGET_RATE=5  examples/constant_arrival_rate_sizing_demo.js
//   k6 run -e TARGET_RATE=20 examples/constant_arrival_rate_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham so ───────────────────────────────────────────────
const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 10; // iter/s muon dat
const ITER_TIME_SEC = 0.5; // thoi gian 1 iter (gia lap: sleep 0.5s)
const DURATION = "10s";
const TIME_UNIT = "1s";

// ─── Buoc 1 & 2 & 3 — tinh toan (init phase) ──────────────
const W = ITER_TIME_SEC;         // Buoc 2: do iter_time
const R = TARGET_RATE;           // Buoc 1: chon rate target
const timeUnitSec = 1;           // timeUnit = "1s" => 1 giay
const requiredVUs = Math.ceil(R * W / timeUnitSec) * 1.2;
const preAllocatedVUs = Math.ceil(requiredVUs);

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "constant-arrival-rate",
      rate: R,
      timeUnit: TIME_UNIT,
      duration: DURATION,
      preAllocatedVUs: preAllocatedVUs,
      maxVUs: preAllocatedVUs,
      gracefulStop: "5s",
    },
  },
};

// ─── In ke hoach truoc khi chay (chi in 1 lan) ────────────
if (__VU === 1) {
  const N_sched = R * 10; // rate x duration (duration=10s, timeUnit=1s)
  const capacity = preAllocatedVUs / W;
  console.log(String.raw`
╔══════════════════════════════════════════════════════════╗
║  TINH HUONG 1: Sap viet config, khong biet dat so nao  ║
╠══════════════════════════════════════════════════════════╣
║                                                        ║
║  Buoc 1 — Chon rate target:                            ║
║    R = ${String(R).padStart(2)} iter/s                                    ║
║    timeUnit = "${TIME_UNIT}"                                   ║
║                                                        ║
║  Buoc 2 — Do iter_time:                                ║
║    W = sleep(${ITER_TIME_SEC}) = ${ITER_TIME_SEC}s                              ║
║    (gia lap request HTTP mat ${ITER_TIME_SEC}s)                      ║
║                                                        ║
║  Buoc 3 — Tinh preAllocatedVUs (CT3):                 ║
║    required_vus = ceil(R x W / timeUnit_s) x 1.2      ║
║                 = ceil(${String(R).padStart(2)} x ${ITER_TIME_SEC} / ${timeUnitSec}) x 1.2                     ║
║                 = ceil(${(R * W).toFixed(1)}) x 1.2                            ║
║                 = ${(Math.ceil(R * W) * 1.2).toFixed(1)}                                     ║
║    preAllocatedVUs = ceil(${(Math.ceil(R * W) * 1.2).toFixed(1)}) = ${String(preAllocatedVUs).padStart(2)} VU                        ║
║                                                        ║
║  Buoc 4 — Config se chay:                              ║
║    rate              = ${String(R).padStart(2)}                                  ║
║    duration          = ${DURATION}                                    ║
║    preAllocatedVUs   = ${String(preAllocatedVUs).padStart(2)}                                  ║
║    maxVUs            = ${String(preAllocatedVUs).padStart(2)}                                  ║
║    → N_sched du kien = R x duration = ${R} x 10 = ${N_sched}                 ║
║    → Capacity        = preAllocatedVUs / W = ${preAllocatedVUs} / ${ITER_TIME_SEC} = ${capacity} iter/s     ║
║    → R(${R}) <= capacity(${capacity}) => khong drop            ║
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
  console.log("    iterations.........: N  X/s");
  console.log(`  X/s co gan ${TARGET_RATE} khong?`);
  console.log("    - Gan dung → config OK, Buoc 1-3 chinh xac");
  console.log("    - Thap hon han → iter_time thuc te > W, can tang VU");
  console.log("");
  console.log("  Kiem tra drop:");
  console.log("    dropped_iterations co gan 0 khong?");
  console.log("    - > 0 → preAllocatedVUs khong du, can tang");
  console.log("");
  console.log("  Cong thuc kiem tra nguoc:");
  console.log("    preAllocatedVUs ≈ ceil(rate x iteration_duration.avg) x 1.2");
}
