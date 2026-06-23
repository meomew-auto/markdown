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

## ⭐ 2 bài tiêu biểu nhất để dạy per-vu-iterations

Trong 7 case, đây là 2 bài **thực tế hay gặp nhất** và **bao quát toàn bộ tinh thần executor**:

### Bài 1: Case 01 — QA replay user journey (`01_user-journey-replay.md`)

**Vì sao chọn làm bài nền tảng:**

```text
Đây là "canonical example" của per-vu-iterations.
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | QA team cần regression test: mỗi user login → browse → add to cart → checkout → confirm. Mỗi user chạy đúng N lần, state (token, cart) sống qua nhiều iteration. |
| **Tinh thần executor** | VU = identity (user-1, user-2, ...). Mỗi VU chạy đúng N iterations. State per-VU (session, cart) duy trì qua các iteration. VU nhanh xong → IDLE, không cướp việc VU khác. |
| **Stateful flow** | Đây là điểm mạnh nhất: login 1 lần ở iteration đầu, dùng token cho các iteration sau. Không executor nào khác giữ được state per-identity tự nhiên như per-vu-iterations. |
| **Output deterministic** | Total iterations = VUs × iters (biết trước). Pass/fail rõ ràng: đủ iterations, không fail, mỗi user hoàn tất đủ flow. |
| **Độ khó** | ⭐ — Full flow quen thuộc (login→browse→cart→checkout), dễ hiểu vì ai cũng biết shopping flow. |

**Dạy trong bao lâu:** 30-40 phút — đi từ "VU = identity", qua stateful flow, đến đọc output.

### Bài 2: Case 03 — Per-user rate limit (`03_rate-limit.md`)

**Vì sao chọn làm bài nâng cao:**

```text
Rate limit là bài toán phổ biến nhất trong API production.
Mọi API public đều có rate limit — và per-vu-iterations là executor
DUY NHẤT có thể test chính xác "mỗi user bị giới hạn riêng".
```

| Tiêu chí | Giá trị dạy |
| --- | --- |
| **Business scenario** | API có SLA: 100 req/phút/user. 5 user, mỗi user gửi 150 request. Verify: 100 đầu 200, 50 cuối 429 + Retry-After. User A spam không ảnh hưởng user B. |
| **Tinh thần executor** | Mỗi VU = 1 user với token riêng. Mỗi VU gửi đúng 150 requests. Rate limit scope là PER-USER → cần đếm riêng từng user → chỉ per-vu-iterations làm được chính xác. |
| **Scope isolation** | Đây là bài học **quan trọng nhất**: nếu dùng shared-iterations hoặc constant-vus, request từ các user bị trộn lẫn → không thể verify "user A vừa chạm limit, user B vẫn OK". |
| **Output validation** | 5 users × (100 success + 50 rate-limited) = khớp chính xác. `http_req_failed` vẫn 0 vì 429 là expected business response, không phải HTTP failure. |
| **Độ khó** | ⭐⭐ — Cần hiểu rate limit scope, phân biệt 429 expected vs 500 bug. |

**Dạy trong bao lâu:** 35-45 phút — rate limit concept + scope isolation + code pattern.

### Lộ trình dạy 2 bài

```text
Buổi 1 (nền tảng): Case 01 QA replay user journey
  1. Mental model: VU = identity, state sống qua iterations
  2. Code pattern: login 1 lần, token dùng lại
  3. So sánh với constant-vus: vì sao không dùng duration-based?
  4. Đọc output: deterministic count, per-VU state

Buổi 2 (nâng cao): Case 03 Per-user rate limit
  1. Rate limit concept: SLA, scope, Retry-After
  2. Vì sao per-vu-iterations là executor DUY NHẤT test được per-user limit
  3. Code pattern: gửi 150 req/VU, đếm 200/429
  4. Đọc output: verify từng user, verify scope isolation
```

### Vì sao không chọn các case khác?

| Case | Vì sao không chọn làm bài chính? |
| --- | --- |
| 02 Idempotency audit | Rất hay (retry storm, idempotency key), nhưng hẹp hơn về business domain (chủ yếu payment). Case 03 (rate limit) phổ biến hơn — API nào cũng có. |
| 04 Session lifecycle | Tốt (token refresh), nhưng gần với Case 01 (session state). Case 01 + 03 phủ rộng hơn (stateful flow + per-identity counting). |
| 05 A/B variant | Hay (balanced exposure), nhưng là use case đặc thù (marketing/experiment). Ít phổ biến hơn rate limit. |
| 06 Cart concurrency | Hay (race condition detection), nhưng đặc thù (cart service). Rate limit phổ biến hơn. |
| 07 CI batch | Deterministic count cho CI — nhưng Case 01 đã dạy deterministic count rồi. Case 03 thêm chiều "per-identity scope" mới. |

## Thứ tự đề xuất đọc/làm

```text
1. Đọc 00_overview.md (file này)
2. Đọc tham-so-cong-thuc Section 1-3 (hiểu cơ bản)
3. Làm 01_user-journey-replay (case dễ nhất, full flow)
4. Làm 02_idempotency-audit (trọng tâm: why-per-vu)
5. Tự chọn case còn lại theo nhu cầu thực tế
```
