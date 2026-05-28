# Case 01: QA replay user journey

## Tình huống thực tế

QA team chuẩn bị release version mới. Họ cần đảm bảo các flow nghiệp vụ
chính (login → browse → add to cart → checkout → confirm order)
**vẫn hoạt động đúng như version cũ** — không bị "regression".

> **Regression là gì?** = lỗi xuất hiện ở chức năng đã chạy đúng trước
> đây, sau khi code thay đổi (bug cũ quay lại, hoặc feature cũ bị hỏng
> do code mới).
>
> ```text
> Version 1.0: login OK, checkout OK
> Version 1.1: login OK, checkout BỊ LỖI (do code mới)
>                              ↑
>                              "regression" ở checkout
> ```
>
> **Đời thường**: sửa xe đổi phanh mới → quên test đèn xi-nhan → đèn hỏng
> (do động vào dây điện) → đèn bị "regression". QA phải test LẠI cả
> phanh + đèn + còi + ... mỗi lần sửa xe.
>
> **Regression test** = replay TẤT CẢ flow nghiệp vụ chính (không skip)
> với input giống lần trước, so kết quả với baseline. Nếu lệch → có
> regression → không release.

Yêu cầu cụ thể:

```text
- 30 user accounts khác nhau
- Mỗi user replay đúng 5 lần journey hoàn chỉnh
- Tổng = 150 journey replay (deterministic, biết trước số)
- Mỗi user phải GIỮ session token, cart state qua các lần replay
- Không cướp identity của user khác
```

## Why per-vu-iterations?

```text
Vì YÊU CẦU NGHIỆP VỤ là:
  - "Mỗi user N việc cố định" -> per-vu-iterations đúng nhất
  - "Tổng N việc xác định" -> per-vu cho biết trước (vus × iters)
  - "User giữ state qua iter" -> closed model + identity bound vào VU

Tại sao KHÔNG dùng executor khác?
  - constant-vus (5m duration): không biết bao nhiêu journey sẽ chạy,
                                và VU random -> session lost
  - shared-iterations (150 iter chung): VU nhanh "cướp" iter của VU
                                         chậm -> 1 user replay 100 lần,
                                         user khác chỉ 5 lần
  - constant-arrival-rate: rate-driven, không bound identity với user
  - ramping-vus: concurrency biến thiên, phá deterministic count
```

## Config

```js
export const options = {
  scenarios: {
    qa_replay: {
      executor: "per-vu-iterations",
      vus: 30,
      iterations: 5,
      maxDuration: "5m",
      gracefulStop: "30s",
    },
  },
};
```

→ 30 × 5 = **150 iteration**, mỗi VU chạy đúng 5 journey.

## Endpoint flow per iteration

```text
1. login          (CHỈ iter 0, lưu session)
2. browse         GET /api/quotes (proxy cho /api/products)
3. view detail    GET ×2
4. add to cart    POST ×2
5. checkout       POST với Idempotency-Key
6. confirm order  POST ×2 (test idempotency)
```

## Per-VU state

```js
let session = null;       // login 1 lần, dùng nhiều iter
let totalCartItems = 0;   // tích lũy qua iter
```

→ Đây là điểm mạnh của per-vu-iterations: state sống trong cùng VU
xuyên suốt nhiều iter.

## Cách chạy

```bash
# Mặc định dùng QuickPizza demo
k6 run examples/per-vu-iterations/pvi-01-user-journey-replay.js

# Đổi BASE_URL nếu cần
BASE_URL=https://my-staging.example.com \
  k6 run examples/per-vu-iterations/pvi-01-user-journey-replay.js
```

## Expected output

```text
scenarios: (100.00%) 1 scenario, 30 max VUs, 5m30s max duration ...
         * qa_replay: 5 iterations for each of 30 VUs

running (XX.Xs), 0/30 VUs, 150 complete and 0 interrupted iterations

  █ TOTAL RESULTS

    EXECUTION
    iterations.........: 150
    iteration_duration.: avg=...
    http_req_failed....: 0.00%
    checks_total.......: ~1500 (10 check/iter × 150 iter)
    vus................: 30
    vus_max............: 30
```

## Pass criteria

```text
1. iterations == 150       -> đúng số journey
2. http_req_failed == 0%   -> không request fail
3. checks rate >= 99%      -> mọi check pass
4. p(95) < 2000ms          -> latency OK
5. interrupted == 0        -> không VU nào bị cắt
```

## Áp 5 bước phân tích output (Section 8.7)

### Bước 1: Verify config [Header]

```text
Header in:    "5 iterations for each of 30 VUs"
Config có:    vus=30, iterations=5 ✓

Header in:    "5m30s max duration"
Tính:         maxDuration + gracefulStop = 5m + 30s = 5m30s ✓
```

### Bước 2: Tính total dự kiến [CT 1]

```text
total = vus × iterations = 30 × 5 = 150
```

### Bước 3: So với N_done [CT 5]

```text
Summary cho:  iterations = 150
Tỷ lệ:        150 / 150 = 100% -> hoàn hảo
```

### Bước 4: Verify N_drop, N_int [CT 5]

```text
Footer:       "0 interrupted iterations"
Summary:      không có dropped (per-vu-iterations chỉ drop khi maxDuration tới)

KẾT LUẬN: test thành công
```

### Bước 5: Đo iter_time thực tế [CT 2 đảo]

```text
iteration_duration avg = ~2s (phụ thuộc network)
T_max = iterations × iter_time = 5 × 2 = 10s mỗi VU
T_run = max(T_vu) ≈ 12s (do VU chậm nhất)

Đánh giá:
  - maxDuration = 5m, T_run = 12s -> dư rất nhiều, có thể giảm xuống "1m"
  - Hoặc tăng iterations lên 30 (mỗi user 30 journey thay vì 5)
```

## Mở rộng / variation

### Variation A: Test data per-user

```js
const users = new SharedArray("users", () => {
  // Read từ file CSV/JSON
  return Array.from({length: 30}, (_, i) => ({
    username: `qa-user-${i + 1}`,
    role: i < 5 ? "admin" : "customer",
  }));
});

// Trong default function:
const user = users[(__VU - 1) % users.length];
```

### Variation B: Tăng độ khó với throttle

```js
// Iter dài hơn để mô phỏng user nghĩ lâu trước khi mua
sleep(Math.random() * 3 + 1);  // 1-4s think time
```

### Variation C: Multi-scenario gộp

```js
scenarios: {
  customers: { executor: "per-vu-iterations", vus: 25, iterations: 5, ... },
  admins:    { executor: "per-vu-iterations", vus: 5, iterations: 10,
               startTime: "30s", ... },
},
```

## Liên hệ với case khác

- **Case 02 (idempotency)**: dùng cùng pattern Idempotency-Key, sâu hơn về retry storm
- **Case 04 (session lifecycle)**: mở rộng phần login/refresh token
- **Case 06 (cart concurrency)**: tập trung vào race condition cùng user

## Reference

- Doc tham số: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- Section 8.7: quy trình 5 bước phân tích output
