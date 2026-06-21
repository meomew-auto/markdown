// Demo: shared-iterations — Tình huống 2: "Đã có target tổng iter, cần bao nhiêu VU?"
//
// Quy trình 4 bước:
//   Bước 1: Đảo ngược Công thức 3 → vus = ceil(iterations × iter_time / target_duration)
//   Bước 2: Áp số
//   Bước 3: Làm tròn LÊN (ceil) cho an toàn
//   Bước 4: Verify lại T_est
//
// File này mô phỏng tình huống: đã biết tổng iter muốn test và thời gian tối đa
// cho phép, cần tính xem phải dùng bao nhiêu VU.
//
// Cách dùng:
//   k6 run examples/shared_iterations_reverse_sizing_demo.js                       # mặc định: 80 iter trong 10s, W=0.5s → vus=4
//   k6 run -e ITERATIONS=100 -e TARGET_DURATION=10 examples/shared_iterations_reverse_sizing_demo.js
//   k6 run -e ITERATIONS=200 -e TARGET_DURATION=20 -e VUS=10 examples/shared_iterations_reverse_sizing_demo.js  # skip tính, dùng vus chỉ định

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TOTAL_ITERATIONS = __ENV.ITERATIONS ? Number(__ENV.ITERATIONS) : 80;        // N: tổng iter muốn test
const TARGET_DURATION_SEC = __ENV.TARGET_DURATION ? Number(__ENV.TARGET_DURATION) : 10; // target: xong trong bao lâu
const FORCE_VUS = __ENV.VUS ? Number(__ENV.VUS) : 0;                               // nếu > 0: skip tính, dùng giá trị này
const ITER_TIME_SEC = 0.5;  // W: sleep cố định giả lập request HTTP

// ─── Bước 1-3: tính toán (init phase) ──────────────────────
const N = TOTAL_ITERATIONS;
const W = ITER_TIME_SEC;
const T_target = TARGET_DURATION_SEC;

// Đảo Công thức 3: vus = ceil(iterations × iter_time / target_duration)
const calculatedVUs = FORCE_VUS > 0 ? FORCE_VUS : Math.ceil(N * W / T_target);
const vusCount = calculatedVUs;

// Verify lại: T_est với số VU đã tính
const T_est = N * W / vusCount;

// Công thức 2: peak_rate ≈ vus / iter_time
const peak_rate = vusCount / W;

// Công thức 5: iter_per_vu ≈ iterations / vus
const iter_per_vu_avg = N / vusCount;

// Kiểm tra ràng buộc
const vuOk = vusCount <= N;

export const options = {
  scenarios: {
    reverse_sizing: {
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
║  TÌNH HUỐNG 2: Đã có target tổng iter, cần bao nhiêu VU║
╠══════════════════════════════════════════════════════════╣
║                                                        ║
║  Đề bài:                                               ║
║    Muốn xong ${String(N).padStart(3)} iter trong ${String(T_target).padStart(2)}s                          ║
║    Mỗi iter mất ${W}s (W = ${W}s)                             ║
║    Hỏi: cần bao nhiêu VU?                              ║
║                                                        ║
║  Bước 1 — Đảo ngược Công thức 3:                       ║
║    T_est = N × W / vus                                 ║
║    <=> vus = N × W / T_est                             ║
║                                                        ║
║  Bước 2 — Áp số:                                       ║
║    vus = ${N} × ${W} / ${T_target}                                  ║
║        = ${(N * W / T_target).toFixed(2)}                                        ║
║                                                        ║
║  Bước 3 — Làm tròn LÊN (ceil):                         ║
║    vus = ceil(${(N * W / T_target).toFixed(2)})                                        ║
║        = ${String(vusCount).padStart(2)} VU                                          ║
║    ${vuOk ? 'Ràng buộc: vus (' + vusCount + ') <= iterations (' + N + ') ✓' : 'CẢNH BÁO: vus > iterations, config sẽ fail validate!'}                 ║
║                                                        ║
║  Bước 4 — Verify lại:                                  ║
║    T_est = ${N} × ${W} / ${vusCount}                                    ║
║          = ${T_est.toFixed(1)}s                                          ║
║    ${T_est <= T_target ? 'T_est (' + T_est.toFixed(1) + 's) <= target (' + T_target + 's) ✓' : 'T_est > target — cần thêm VU hoặc giảm N'}          ║
║                                                        ║
║  Config sẽ chạy:                                       ║
║    executor     = shared-iterations                    ║
║    vus          = ${String(vusCount).padStart(2)}                                      ║
║    iterations   = ${String(N).padStart(3)}                                    ║
║    maxDuration  = 2m                                    ║
║    gracefulStop = 10s                                   ║
║                                                        ║
║  Dự kiến từ công thức:                                 ║
║    CT3: T_run ≈ ${T_est.toFixed(1)}s                                    ║
║    CT2: peak  ≈ ${vusCount} / ${W} = ${peak_rate.toFixed(1)} iter/s                       ║
║    CT5: avg   ≈ ${N} / ${vusCount} = ${iter_per_vu_avg.toFixed(1)} iter/VU                        ║
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
  console.log(`    Đảo CT3: vus_calc = ceil(${N} × ${W} / ${T_target}) = ${calculatedVUs}`);
  console.log(`    CT3 verify: T_est = ${N} × ${W} / ${vusCount} = ${T_est.toFixed(1)}s`);
  console.log(`    CT2: peak = ${vusCount} / ${W} = ${peak_rate.toFixed(1)} iter/s`);
  console.log("");
  console.log("  Đọc kết quả thực tế:");
  console.log("    - Footer 'running (X.Xs)': T_run có gần T_est không?");
  console.log("    - T_run có <= target_duration không?");
  console.log("    - Summary iterations: có đủ N_done = N không?");
  console.log("    - Summary vus max: có đúng vus tính được không?");
}
