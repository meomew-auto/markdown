// Demo: Tình huống 1 — "Sắp viết config, không biết đặt số bao nhiêu"
//
// Quy trình 5 bước (từ cheat sheet ramping-vus):
//   Bước 1: Tính tổng thời gian T = sum(stage.duration)
//   Bước 2: Tìm max VU = max(startVUs, mọi stage.target)
//   Bước 3: Tính max duration = T + gracefulStop
//   Bước 4: Đo iter_time (chạy thử 1 VU) → W
//   Bước 5: Ước lượng peak_rate ≈ max_vu / W
//
// Demo này mô phỏng tình huống: có script (sleep giả request HTTP),
// muốn test ramp-up/hold/ramp-down, chưa biết đặt stages ra sao.
//
// Cách dùng trong lớp:
//   k6 run examples/ramping_vus_sizing_demo.js
//   → Đọc console log tính toán (init phase)
//   → Đọc summary để kiểm chứng
//
//   Thay MAX_VUS để thấy kết quả thay đổi:
//     k6 run -e MAX_VUS=8 examples/ramping_vus_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const MAX_VUS = __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : 4;      // số VU đỉnh muốn test
const RAMP_UP_SEC = __ENV.RAMP_UP ? Number(__ENV.RAMP_UP) : 3;  // thời gian ramp lên
const HOLD_SEC = __ENV.HOLD ? Number(__ENV.HOLD) : 5;            // thời gian giữ đỉnh
const RAMP_DOWN_SEC = __ENV.RAMP_DOWN ? Number(__ENV.RAMP_DOWN) : 3; // thời gian ramp xuống
const ITER_TIME_SEC = 0.5;  // giả lập: sleep 0.5s ~ 1 request HTTP

// ─── Tính toán init phase ──────────────────────────────────
const W = ITER_TIME_SEC;
const T = RAMP_UP_SEC + HOLD_SEC + RAMP_DOWN_SEC;

// Ước lượng iter từng stage bằng tích phân
// stage 1: 1 -> MAX_VUS trong RAMP_UP giây
const avgVU1 = (1 + MAX_VUS) / 2;
const iterStage1 = avgVU1 * RAMP_UP_SEC / W;

// stage 2: MAX_VUS -> MAX_VUS trong HOLD giây
const iterStage2 = MAX_VUS * HOLD_SEC / W;

// stage 3: MAX_VUS -> 0 trong RAMP_DOWN giây
const avgVU3 = (MAX_VUS + 0) / 2;
const iterStage3 = avgVU3 * RAMP_DOWN_SEC / W;

const totalIter = iterStage1 + iterStage2 + iterStage3;
const peakRate = MAX_VUS / W;

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: `${RAMP_UP_SEC}s`, target: MAX_VUS },
        { duration: `${HOLD_SEC}s`, target: MAX_VUS },
        { duration: `${RAMP_DOWN_SEC}s`, target: 0 },
      ],
      gracefulRampDown: "30s",
      gracefulStop: "30s",
    },
  },
};

// ─── In kế hoạch trước khi chạy (chỉ in 1 lần) ────────────
if (__VU === 1) {
  const maxDuration = T + 30; // gracefulStop = 30s

  console.log(String.raw`
╔══════════════════════════════════════════════════════════════╗
║    TÌNH HUỐNG 1: Sắp viết config, không biết đặt số nào    ║
╠══════════════════════════════════════════════════════════════╣
║                                                            ║
║  Bước 1 — Tính tổng thời gian T:                          ║
║    T = sum(stage.duration)                                 ║
║      = ${RAMP_UP_SEC} + ${HOLD_SEC} + ${RAMP_DOWN_SEC}                                  ║
║      = ${T}s                                                  ║
║                                                            ║
║  Bước 2 — Tìm max VU:                                     ║
║    max_vu = max(startVUs=1, stage.targets=${MAX_VUS},${MAX_VUS},0)                   ║
║           = max(1,${MAX_VUS},${MAX_VUS},0)                              ║
║           = ${MAX_VUS} VU                                               ║
║    → Header sẽ in: "Up to ${MAX_VUS} looping VUs"                         ║
║                                                            ║
║  Bước 3 — Tính max duration:                              ║
║    max_duration = T + gracefulStop                         ║
║                 = ${T} + 30                                     ║
║                 = ${maxDuration}s                                              ║
║                                                            ║
║  Bước 4 — Đo iter_time (W):                               ║
║    W = sleep(${ITER_TIME_SEC}) = ${ITER_TIME_SEC}s                                ║
║    (giả lập request HTTP mất ${ITER_TIME_SEC}s)                         ║
║                                                            ║
║  Bước 5 — Ước lượng peak_rate:                            ║
║    peak_rate ≈ max_vu / W                                  ║
║              = ${MAX_VUS} / ${ITER_TIME_SEC}                                    ║
║              = ${peakRate} iter/s                                     ║
║    → Chỉ đạt được trong stage 2 (hold ${MAX_VUS} VU)                        ║
║                                                            ║
║  ─── Ước lượng iter từng stage (tích phân) ─────────────  ║
║    Stage 1 (1→${MAX_VUS}): avgVU=${avgVU1.toFixed(1)}  → ${iterStage1.toFixed(0)} iter                    ║
║    Stage 2 (${MAX_VUS}→${MAX_VUS}): avgVU=${MAX_VUS}    → ${iterStage2.toFixed(0)} iter                     ║
║    Stage 3 (${MAX_VUS}→0): avgVU=${avgVU3.toFixed(1)}  → ${iterStage3.toFixed(0)} iter                     ║
║                            Tổng ước lượng ≈ ${Math.round(totalIter)} iter                 ║
║                                                            ║
║  ─── Công thức kiểm tra ────────────────────────────────  ║
║    CT1  (step_interval) = ${RAMP_UP_SEC}/(${MAX_VUS}-1) = ${(RAMP_UP_SEC/(MAX_VUS-1)).toFixed(1)}s giữa 2 VU              ║
║    CT2  (per_vu_rate)   = 1/${ITER_TIME_SEC} = ${(1/ITER_TIME_SEC).toFixed(1)} iter/s                          ║
║    CT3  (peak_rate)     = ${MAX_VUS}/${ITER_TIME_SEC} = ${peakRate} iter/s                          ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// ─── Theo dõi thời gian scenario ────────────────────────
function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

// ─── Iteration ──────────────────────────────────────────
export default function () {
  console.log(
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(ITER_TIME_SEC); // giả lập request HTTP
}

// ─── Xử lý kết thúc ─────────────────────────────────────
export function teardown() {
  console.log("\n─── Kiểm tra output ───────────────────────────");
  console.log("  Nhìn dòng summary:");
  console.log("    iteration_duration...: avg=???ms");
  console.log("    iterations...........: N  X/s");
  console.log("    vus..................: N  min=N  max=N");
  console.log("");
  console.log("  Bảng kiểm tra:");
  console.log(`    1) W thực tế = avg iteration_duration  → kỳ vọng ~${ITER_TIME_SEC * 1000}ms`);
  console.log(`    2) N_done    = iterations count        → kỳ vọng ~${Math.round(totalIter)} iter`);
  console.log(`    3) M_peak    = vus max                 → kỳ vọng = ${MAX_VUS}`);
  console.log(`    4) N_int     = footer "interrupted"    → kỳ vọng = 0`);
  console.log(`    5) Rate      = iterations/s            → kỳ vọng < ${peakRate} iter/s`);
  console.log("");
  console.log("  Công thức kiểm tra ngược từng stage:");
  console.log("    iter_stage ≈ active_vus_avg × duration / W");
}
