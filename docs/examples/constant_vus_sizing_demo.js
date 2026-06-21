// Demo: Tình huống 1 — "Sắp viết config, không biết đặt số bao nhiêu"
//
// Quy trình 4 bước (từ cheat sheet constant-vus):
//   Bước 1: Đo iter_time (chạy thử 1 VU)
//   Bước 2: Quyết định tốc độ mong muốn X iter/s
//   Bước 3: Tính vus = ceil(X × W)
//   Bước 4: Đặt config, chạy, kiểm tra summary
//
// File này mô phỏng tình huống: học sinh đã có script (sleep giả request HTTP),
// muốn test chạy ở tốc độ target X iter/s, nhưng chưa biết đặt vus bao nhiêu.
//
// Cách dùng trong lớp:
//   1. Chạy file này với TARGET_RATE bạn muốn (mặc định 10 iter/s)
//   2. Đọc console log Bước 1-3 (tính toán)
//   3. Đọc summary để xem iterations/s thực tế có gần target không
//
//   Thay TARGET_RATE để thấy vus thay đổi:
//     k6 run -e TARGET_RATE=5  examples/constant_vus_sizing_demo.js
//     k6 run -e TARGET_RATE=20 examples/constant_vus_sizing_demo.js

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số ───────────────────────────────────────────────
const TARGET_RATE = __ENV.TARGET_RATE ? Number(__ENV.TARGET_RATE) : 10; // iter/s muốn đạt
const ITER_TIME_SEC = 0.5; // thời gian 1 iter (giả lập: sleep 0.5s)

// ─── Bước 1 & 2 & 3 — tính toán (init phase) ──────────────
const W = ITER_TIME_SEC;
const X = TARGET_RATE;
const calculatedVUs = Math.ceil(X * W);

export const options = {
  scenarios: {
    sizing_demo: {
      executor: "constant-vus",
      vus: calculatedVUs,
      duration: "10s",
      gracefulStop: "5s",
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
║  Bước 1 — Đo iter_time:                                ║
║    W = sleep(${ITER_TIME_SEC}) = ${ITER_TIME_SEC}s                      ║
║    (giả lập request HTTP mất ${ITER_TIME_SEC}s)                      ║
║                                                        ║
║  Bước 2 — Quyết định tốc độ mong muốn:                  ║
║    X = ${String(TARGET_RATE).padStart(2)} iter/s                                ║
║    (tốc độ sẽ hiện ở summary: iterations/s ≈ ${String(TARGET_RATE).padStart(2)})         ║
║                                                        ║
║  Bước 3 — Tính số VU cần:                              ║
║    vus = ceil(X × W)                                   ║
║        = ceil(${String(TARGET_RATE).padStart(2)} × ${ITER_TIME_SEC})                                ║
║        = ceil(${(X * W).toFixed(1)})                                  ║
║        = ${String(calculatedVUs).padStart(2)} VU                                      ║
║                                                        ║
║  Bước 4 — Config sẽ chạy:                              ║
║    vus      = ${String(calculatedVUs).padStart(2)}                                      ║
║    duration = 10s                                       ║
║    → Tổng iter dự kiến ≈ ${String(calculatedVUs).padStart(2)} × 10 / ${ITER_TIME_SEC} = ${calculatedVUs * 10 / ITER_TIME_SEC}                       ║
║    → Summary kỳ vọng: iterations/s ≈ ${String(TARGET_RATE).padStart(2)}                  ║
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
    `[iter] t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
  );

  sleep(ITER_TIME_SEC); // giả lập request HTTP
}

// ─── Xử lý kết thúc ─────────────────────────────────────
export function teardown() {
  console.log("\n─── Kiểm tra output ───────────────────────────");
  console.log("  Nhìn dòng summary:");
  console.log(`    iterations.........: N  X/s`);
  console.log(`  X/s có gần ${TARGET_RATE} không?`);
  console.log("    - Gần đúng → config OK, Bước 1-3 chính xác");
  console.log("    - Thấp hơn hẳn → iter_time thực tế > W, cần tăng vus");
  console.log("    - Cao hơn hẳn → iter_time thực tế < W (hiếm)");
  console.log("");
  console.log("  Công thức kiểm tra ngược:");
  console.log("    vus_thực_tế ≈ (iterations/s) × iteration_duration.avg");
}
