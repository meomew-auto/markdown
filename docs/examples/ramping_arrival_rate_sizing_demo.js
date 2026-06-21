// Demo: Tình huống 1 — "Sắp viết config, không biết đặt số bao nhiêu"
//         Tình huống 2 — "Đã có sẵn N VU, hỏi chịu được rate cao nhất là bao nhiêu?"
//
// Quy trình 5 bước (từ cheat sheet ramping-arrival-rate):
//   Bước 1: Tính rate đỉnh λ_peak = max(startRate, mọi stage.target) / timeUnit
//   Bước 2: Đo iter_time (chạy thử 1 VU, xem iteration_duration)
//   Bước 3: Tính số VU cần = ceil(λ_peak × W) × 1.2
//   Bước 4: Đặt config, chạy, kiểm tra summary
//   Bước 5: Verify N_sched dự kiến vs N_done thực tế
//
// File này mô phỏng tình huống: học sinh đã có script (sleep giả request HTTP),
// muốn test với pattern ramp-up-hold-ramp-down, chưa biết đặt preAllocatedVUs.
//
// Cách dùng trong lớp:
//   1. Chạy file này với TARGET_RATE bạn muốn (mặc định 4 iter/s)
//   2. Đọc console log Bước 1-4 (tính toán)
//   3. Đọc summary để xem N_done có gần N_sched không, có drop không
//
//   Thay TARGET_RATE để thấy VU cần thay đổi:
//     k6 run -e TARGET_RATE=2  examples/ramping_arrival_rate_sizing_demo.js
//     k6 run -e TARGET_RATE=4  examples/ramping_arrival_rate_sizing_demo.js
//     k6 run -e TARGET_RATE=8  examples/ramping_arrival_rate_sizing_demo.js
//
//   Thêm env DROP_MODE=1 để demo thiếu VU:
//     k6 run -e TARGET_RATE=4 -e DROP_MODE=1 examples/ramping_arrival_rate_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 4;   // rate đỉnh (iter/s)
const ITER_TIME_SEC = 0.5;   // thời gian 1 iter (giả lập: sleep 0.5s)
const DROP_MODE = __ENV.DROP_MODE ? Number(__ENV.DROP_MODE) : 0;         // 1 = cố ý thiếu VU

// ─── Bước 1 & 2 & 3 — tính toán (init phase) ──────────────
const W = ITER_TIME_SEC;
const lambdaPeak = TARGET_RATE;
const requiredVUs = Math.ceil(lambdaPeak * W * 1.2);
const preAllocatedVUs = DROP_MODE ? Math.max(1, requiredVUs - 2) : requiredVUs;
const maxVUs = DROP_MODE ? preAllocatedVUs : requiredVUs + 2;

// ─── Tính N_sched dự kiến ──────────────────────────────────
const HOLD_DUR = 4;   // thời gian hold ở rate đỉnh
const RAMP_DUR = 2;   // thời gian ramp
const stages = [
  { duration: `${RAMP_DUR}s`, target: lambdaPeak },   // ramp 0 -> λ_peak
  { duration: `${HOLD_DUR}s`, target: lambdaPeak },    // hold λ_peak
  { duration: `${RAMP_DUR}s`, target: 0 },             // ramp λ_peak -> 0
];

function calcScheduled(stgs, startRate, timeUnitSec) {
  let total = 0;
  let prevRate = startRate / timeUnitSec;
  const details = [];
  for (const s of stgs) {
    const dur = parseFloat(s.duration);
    const nextRate = s.target / timeUnitSec;
    const slots = dur * (prevRate + nextRate) / 2;
    total += slots;
    details.push({ dur, prevRate, nextRate, slots });
    prevRate = nextRate;
  }
  return { total, details };
}

const { total: N_sched, details: stageDetail } = calcScheduled(stages, 0, 1);
const T_total = RAMP_DUR + HOLD_DUR + RAMP_DUR;  // tổng duration
const lambdaAvg = N_sched / T_total;

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: preAllocatedVUs,
      maxVUs: maxVUs,
      gracefulStop: "10s",
      stages: stages,
    },
  },
};

// ─── In kế hoạch trước khi chạy (chỉ in 1 lần) ────────────
if (__VU === 1) {
  const pad10 = (s) => String(s).padStart(10);
  const capMsg = DROP_MODE ? "CỐ Ý THIẾU VU (DROP_MODE=1)" : "ĐỦ VU";

  console.log(String.raw`
╔══════════════════════════════════════════════════════════════════╗
║  TÌNH HUỐNG: Sizing VU cho ramping-arrival-rate                ║
╠══════════════════════════════════════════════════════════════════╣
║  Mode: ${capMsg}${' '.repeat(46 - capMsg.length)}║
║                                                                ║
║  Bước 1 — Tính rate đỉnh (CT 2):                              ║
║    λ_peak = max(startRate=0, mọi stage.target) / timeUnit      ║
║           = max(0, ${lambdaPeak}, ${lambdaPeak}, 0) / 1                         ║
║           = ${String(lambdaPeak).padStart(2)} iter/s                                        ║
║                                                                ║
║  Bước 2 — Đo iter_time:                                       ║
║    W = sleep(${ITER_TIME_SEC}) = ${ITER_TIME_SEC}s                                        ║
║    (giả lập request HTTP mất ${ITER_TIME_SEC}s)                                  ║
║                                                                ║
║  Bước 3 — Tính số VU cần (CT 1):                             ║
║    required_vus = ceil(λ_peak × W) × 1.2                      ║
║                 = ceil(${lambdaPeak} × ${ITER_TIME_SEC}) × 1.2                              ║
║                 = ceil(${lambdaPeak * ITER_TIME_SEC}) × 1.2                                ║
║                 = ${requiredVUs} VU                                           ║
║                                                                ║
║  Config hiện tại:                                             ║
║    preAllocatedVUs = ${String(preAllocatedVUs).padStart(2)}                                        ║
║    maxVUs          = ${String(maxVUs).padStart(2)}                                        ║
║    stages          = [                                        ║
║      { dur: ${RAMP_DUR}s, target: ${lambdaPeak} }                              ║
║      { dur: ${HOLD_DUR}s, target: ${lambdaPeak} }                              ║
║      { dur: ${RAMP_DUR}s, target: 0 }                               ║
║    ]                                                          ║
║                                                                ║
║  Bước 4 — N_sched dự kiến (CT 3):                            ║
║    Stage 0: ${pad10(RAMP_DUR + 's')} × (0 + ${lambdaPeak})/2  = ${String(stageDetail[0].slots.toFixed(1)).padStart(8)} slot  ║
║    Stage 1: ${pad10(HOLD_DUR + 's')} × (${lambdaPeak} + ${lambdaPeak})/2  = ${String(stageDetail[1].slots.toFixed(1)).padStart(8)} slot  ║
║    Stage 2: ${pad10(RAMP_DUR + 's')} × (${lambdaPeak} + 0)/2  = ${String(stageDetail[2].slots.toFixed(1)).padStart(8)} slot  ║
║                                       Tổng = ${String(N_sched.toFixed(1)).padStart(8)} slot  ║
║    λ_avg  = ${N_sched.toFixed(1)} / ${T_total}s = ${lambdaAvg.toFixed(2)} iter/s                          ║
║                                                                ║
║  Kiểm tra:                                                    ║
║    - Header: "Up to ${lambdaPeak}.00 iterations/s for ${T_total}s"              ║
║    - Summary iterations ≈ ${Math.round(N_sched)} (N_sched)                          ║
║    - dropped_iterations: ${DROP_MODE ? '> 0 (thiếu VU)' : '= 0 (đủ VU)'}                         ║
╚══════════════════════════════════════════════════════════════════╝
`);
}

// ─── Theo dõi thời gian scenario ────────────────────────────
function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

// ─── Iteration ──────────────────────────────────────────────
export default function () {
  console.log(
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );
  sleep(ITER_TIME_SEC); // giả lập request HTTP
}

// ─── Xử lý kết thúc ─────────────────────────────────────────
export function teardown() {
  console.log("\n─── Kiểm tra output ───────────────────────────");
  console.log(`  Nhìn dòng summary:`);
  console.log(`    iterations.........: N  X/s`);
  console.log(`    dropped_iterations.: D`);
  console.log(`    vus max............: V`);
  console.log("");
  console.log(`  CT 5 verify: N_done + N_drop + N_int ≈ N_sched (${N_sched.toFixed(1)})`);
  console.log(`    - N_drop = 0  → đủ VU, rate target nằm trong capacity`);
  console.log(`    - N_drop > 0  → thiếu VU, tăng preAllocatedVUs`);
  console.log(`    - N_int  > 0  → iter chưa xong khi grace hết, tăng gracefulStop`);
  console.log("");
  console.log(`  CT 1 đảo: capacity = vus_max / W`);
  console.log(`    vus_max từ summary × ${ITER_TIME_SEC}s = ? iter/s`);
  console.log(`    Nếu capacity >= ${lambdaPeak}/s → không drop ✓`);
}
