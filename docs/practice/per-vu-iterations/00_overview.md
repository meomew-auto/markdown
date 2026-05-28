# Series thực hành: 7 tình huống thực tế cho `per-vu-iterations`

## Mục đích series

Series này dạy **WHEN/WHY dùng `per-vu-iterations`** thay vì các executor khác,
qua 7 tình huống thực tế gặp trong dự án production.

Mỗi case:
- File JS chạy được (`pvi-NN-<topic>.js` trong `examples/per-vu-iterations/`)
- File doc giải thích why-per-vu, expected output, pass criteria
  (`NN_<topic>.md` trong `docs/practice/per-vu-iterations/`)

## Đặc trưng `per-vu-iterations`

```text
- Mỗi VU = 1 IDENTITY (user, customer, tenant)
- Mỗi VU chạy ĐÚNG N iterations cố định
- State per-VU SỐNG QUA nhiều iter (token, session, cart)
- Total work = VUs × iters (DETERMINISTIC, biết trước)
- VU nhanh xong -> IDLE (không cướp việc của VU chậm)
```

→ Khác hẳn `constant-vus` (random VU), `shared-iterations` (chia chung pool),
`arrival-rate` (rate-driven, identity không bound vào VU).

## Bảng tổng hợp 7 case

| # | Tình huống | Why per-vu | Endpoint chính |
| --- | --- | --- | --- |
| 01 | QA replay user journey | Mỗi VU giữ session/cart state qua iter | login + products + cart + checkout |
| 02 | Idempotency audit retry | Idempotency-Key stable per customer | login + orders/confirm (×5) |
| 03 | Per-user rate limit | Rate limit count theo user | login + products spam |
| 04 | Session lifecycle + refresh | Token bound theo VU | login + auth/me + refresh |
| 05 | A/B variant balanced exposure | Mỗi user 1 variant cố định | products/homefeed |
| 06 | Cart concurrency same-user | Race chỉ test được same user | login + cart/add |
| 07 | CI batch deterministic | Cần count chính xác | products + cart/add |

## Bảng so sánh: dùng executor nào cho tình huống nào?

| Mục tiêu test | Executor đúng | Vì sao |
| --- | --- | --- |
| Mỗi user N việc cố định | **per-vu-iterations** | identity bound vào VU |
| Test 5 phút duration | constant-vus | thời lượng cố định |
| Test 50 RPS không phụ thuộc VU | constant-arrival-rate | rate-driven |
| Backlog 200 jobs xử lý | shared-iterations | chia chung pool |
| Surge từ campaign | ramping-arrival-rate | rate biến thiên |
| User tăng dần theo giờ | ramping-vus | concurrency biến thiên |

## Pattern chung: VU = identity

Mọi case đều dùng `__VU` map sang real identity:

```js
const userId = `user-${__VU}`;
const tenantId = `tenant-${__VU}`;
const customerId = `cust-${__VU}`;
```

→ Mỗi VU là 1 actor phân biệt, không phải worker generic. Đây là điểm
mạnh nhất của `per-vu-iterations` so với các executor khác.

## Quy tắc đặt config

```js
export const options = {
  scenarios: {
    case_NN: {
      executor: "per-vu-iterations",
      vus: 30,              // số identity (user, customer, tenant)
      iterations: 10,       // số việc mỗi identity phải làm
      maxDuration: "5m",    // trần thời gian (default 10m)
      // gracefulStop: "30s"  (default)
    },
  },
};
```

Total iterations = `vus × iterations` = 30 × 10 = 300 (deterministic).

## Cách chạy

```bash
# 1. Start mock server (mỗi case có README hướng dẫn cụ thể)
cd examples/per-vu-iterations
node mock-server.js  # nếu cần

# 2. Run test
k6 run pvi-01-user-journey-replay.js

# 3. Đọc output theo Section 6.7 doc per-vu-iterations
```

## Reference docs

- Tham số chi tiết: `docs/20260514_02_per-vu-iterations-tham-so-cong-thuc.md`
- Quick index: `docs/20260514_01_per-vu-iterations-quick-index.md`
- Multi-scenario: `docs/20260521_00_per-vu-iterations-khai-bao-nhieu-scenario.md`

## Thứ tự đề xuất đọc/làm

```text
1. Đọc 00_overview.md (file này)
2. Đọc tham-so-cong-thuc Section 1-3 (hiểu cơ bản)
3. Làm 01_user-journey-replay (case dễ nhất, full flow)
4. Làm 02_idempotency-audit (trọng tâm: why-per-vu)
5. Tự chọn case còn lại theo nhu cầu thực tế
```
