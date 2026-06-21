// Demo: shared-iterations — Tình huống 1: "Sắp viết config, không biết đặt số bao nhiêu"
//
// Quy trình 5 bước (từ cheat sheet shared-iterations):
//   Bước 1: Quyết tổng iter cần (iterations)
//   Bước 2: Quyết số VU song song (vus)
//   Bước 3: Đo iter_time (chạy thử 1 VU)
//   Bước 4: Tính T_est (Công thức 3) → chọn maxDuration
//   Bước 5: Đặt config hoàn chỉnh, chạy, kiểm tra summary
//
// File này mô phỏng tình huống: học sinh đã có script (sleep giả request HTTP),
// muốn test tổng N iter, nhưng chưa biết đặt maxDuration bao nhiêu cho đủ.
//
// Cách dùng:
//   k6 run examples/shared_iterations_sizing_demo.js                       # mặc định: 40 iter, 4 VU, W=0.5s
//   k6 run -e ITERATIONS=100 -e VUS=5 examples/shared_iterations_sizing_demo.js
//   k6 run -e ITERATIONS=200 -e VUS=10 examples/shared_iterations_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TOTAL_ITERATIONS = __ENV.ITERATIONS ? Number(__ENV.ITERATIONS) : 40; // N: tổng iter toàn scenario
const VUS = __ENV.VUS ? Number(__ENV.VUS) : 4;                             // số VU song song
const ITER_TIME_SEC = 0.5;  // W: sleep cố định giả lập request HTTP

// ─── Bước 1-4: tính toán (init phase) ──────────────────────
const N = TOTAL_ITERATIONS;
const W = ITER_TIME_SEC;
const vusCount = VUS;

// Công thức 3: T_est ≈ iterations × iter_time / vus
const T_est = N * W / vusCount;

// Công thức 2: peak_rate ≈ vus / iter_time
const peak_rate = vusCount / W;

// Công thức 5: iter_per_vu ≈ iterations / vus
const iter_per_vu_avg = N / vusCount;

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "shared-iterations",
      vus: vusCount,
      iterations: N,
      maxDuration: "2m",
      gracefulStop: "10s",
    },
  },
};

// ─── In kế hoạch trước khi chạy (chỉ in 1 lần) ────────────
if (__VU === 1) {
  console.log(String.raw`
╔══════════════════════════════════════════════════════════╗
║  TÌNH HUỐNG 1: Sắp viết config, không biết đặt số nào  ║
╠══════════════════════════════════════════════════════════╣
║                                                        ║
║  Bước 1 — Quyết tổng iter cần:                         ║
║    iterations = ${String(N).padStart(3)}                                      ║
║    (muốn test ${String(N).padStart(3)} lượt request)                              ║
║                                                        ║
║  Bước 2 — Quyết số VU song song:                       ║
║    vus = ${vusCount}                                           ║
║    (vừa phải, không quá tải máy local)                  ║
║    Ràng buộc: vus (${vusCount}) <= iterations (${N}) ✓                     ║
║                                                        ║
║  Bước 3 — Đo iter_time:                                ║
║    W = sleep(${W}) = ${W}s                                    ║
║    (giả lập request HTTP mất ${W}s)                          ║
║    per_vu_rate = 1/${W} = ${(1/W).toFixed(1)} iter/s/VU                        ║
║                                                        ║
║  Bước 4 — Tính T_est (Công thức 3):                    ║
║    T_est = N × W / vus                                 ║
║          = ${N} × ${W} / ${vusCount}                                 ║
║          = ${T_est.toFixed(1)}s                                         ║
║    → Đặt maxDuration > T_est (dùng "2m" cho an toàn)   ║
║                                                        ║
║  Bước 5 — Config sẽ chạy:                              ║
║    executor     = shared-iterations                    ║
║    vus          = ${vusCount}                                      ║
║    iterations   = ${N}                                      ║
║    maxDuration  = 2m                                    ║
║    gracefulStop = 10s                                   ║
║                                                        ║
║  Dự kiến từ công thức:                                 ║
║    CT3: T_run ≈ ${T_est.toFixed(1)}s                                    ║
║    CT2: peak  ≈ ${vusCount} / ${W} = ${peak_rate.toFixed(1)} iter/s                       ║
║    CT5: avg   ≈ ${N} / ${vusCount} = ${iter_per_vu_avg.toFixed(1)} iter/VU                        ║
║    N_done = ${N} (clean run)                                 ║
║    N_drop = 0 (không hit maxDuration)                  ║
╚══════════════════════════════════════════════════════════╝
`);
}

// ─── Theo dõi thời gian scenario ────────────────────────
function elapsedSeconds() {
  return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

// ─── Iteration ──────────────────────────────────────────
export default function () {
  console.log(
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER} iterInScenario=${exec.scenario.iterationInTest}`,
  );

  sleep(ITER_TIME_SEC); // giả lập request HTTP
}

// ─── Xử lý kết thúc ─────────────────────────────────────
export function teardown() {
  console.log("\n─── Kiểm tra output ───────────────────────────");
  console.log("  Nhìn dòng summary:");
  console.log("    iterations.........: N  X/s");
  console.log(`  Kỳ vọng: N_done = ${N}, N_drop = 0, N_int = 0`);
  console.log("");
  console.log("  Công thức kiểm tra chéo:");
  console.log(`    CT3: T_est = ${N} × ${W} / ${vusCount} = ${T_est.toFixed(1)}s`);
  console.log(`    CT2: peak  = ${vusCount} / ${W} = ${peak_rate.toFixed(1)} iter/s`);
  console.log(`    CT5: avg   = ${N} / ${vusCount} = ${iter_per_vu_avg.toFixed(1)} iter/VU`);
  console.log("");
  console.log("  Đọc kết quả thực tế:");
  console.log("    - Footer 'running (X.Xs)': T_run có gần T_est không?");
  console.log("    - Summary iterations/s: có gần peak_rate không?");
  console.log("    - Summary iteration_duration avg: có gần W không?");
  console.log("    - Có dropped_iterations không? (không có = clean run)");
}
