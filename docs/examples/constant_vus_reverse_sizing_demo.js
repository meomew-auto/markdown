// Demo: Tình huống 3 — "Đã có sẵn N VU, hỏi throughput được bao nhiêu?"
//
// Ngược với Tình huống 2: bạn đã BIẾT số VU (vd giới hạn 4 tài khoản test,
// hoặc server chỉ cho 10 connection), muốn ước lượng throughput sẽ đạt.
//
// Quy trình 3 bước:
//   Bước 1: Đo iter_time (W)
//   Bước 2: Tính peak_rate = N / W      (Công thức 1)
//   Bước 3: Tính total ≈ N × duration / W (Công thức 3)
//
// Cách dùng: đổi AVAILABLE_VUS và ITER_TIME_SEC, chạy, so summary với dự đoán.

import exec from "k6/execution";
import { sleep } from "k6";

// ─── Tham số (giả lập đã biết trước) ──────────────────────
const AVAILABLE_VUS = __ENV.VUS ? Number(__ENV.VUS) : 4;    // N: số VU có sẵn
const ITER_TIME_SEC = 0.7;  // W: đo được từ chạy thử 1 VU

// ─── Bước 1 & 2: tính peak ─────────────────────────────────
const W = ITER_TIME_SEC;
const N = AVAILABLE_VUS;
const peak = N / W;                         // Công thức 1
const totalEstimate = N * 10 / W;           // Công thức 3 (duration=10s)

export const options = {
  scenarios: {
    reverse_sizing: {
      executor: "constant-vus",
      vus: AVAILABLE_VUS,
      duration: "10s",
      gracefulStop: "5s",
    },
  },
};

if (__VU === 1) {
  console.log(`\n  ĐÃ BIẾT: N=${N} VU, W=${W}s`);
  console.log(`  Bước 2 — peak = N/W = ${N}/${W} = ${peak.toFixed(2)} iter/s`);
  console.log(`  Bước 3 — total ≈ N×10s/W = ${N}×10/${W} = ${totalEstimate.toFixed(0)} iter\n`);
}

export default function () {
  console.log(`[iter] __VU=${__VU} __ITER=${__ITER}`);
  sleep(ITER_TIME_SEC);
}
