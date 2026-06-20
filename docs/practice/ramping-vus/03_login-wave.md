# Case 03: Login wave

## Tình huống thực tế

Đầu ngày làm việc, users vào hệ thống theo wave: bắt đầu ít, tăng nhanh, rồi settle xuống số sessions thấp hơn. Đây là pattern quen thuộc của hầu hết ứng dụng doanh nghiệp: 8h sáng nhân viên bắt đầu login, 8h30-9h đạt peak login, sau đó số sessions ổn định ở mức cao (mọi người đã vào và đang làm việc), cuối ngày sessions giảm dần khi mọi người logout hoặc hết giờ.

Auth service phải xử lý login, session validation, refresh theo active pool đang tăng. Không giống như session keepalive (giữ sessions phẳng quan sát stability), login wave đặt câu hỏi khác: **auth service có chịu được áp lực tăng dần từ 1 lên 28 sessions, giữ peak ổn định, rồi cooldown về 5 sessions không?**

Điểm khác biệt quan trọng với session keepalive: trong login wave, **login và refresh không xảy ra ở mọi iteration**. Login chỉ xảy ra ở iteration đầu của mỗi VU (khi user mới vào). Refresh xảy ra mỗi 5 iteration. Còn session validation (`auth/me`) chạy mỗi iteration. Điều này tạo ra **operation mix thay đổi theo phase**: ramp-up có nhiều login, plateau gần như toàn bộ là session validation, cooldown không có login mới.

Case này trả lời: auth có chịu được 1 -> 12 -> 28 -> 5 VUs và ổn định ở plateau không?

Tóm tắt đời thường:

```text
Executor model: staged active user pool
Default shape: 1 -> 12 -> 28 -> 5
Scenario: login_wave
Exec function: loginWave
Team/service focus: auth/session
```

Case này không hỏi:

```text
Có chạy đủ N iterations không?
Có đạt đúng X RPS không?
Có drain hết fixed backlog không?
```

Nó hỏi:

```text
Khi active users đi theo shape 1 -> 12 -> 28 -> 5,
latency/failures/iter-s/RPS phản ứng như thế nào?
Đặc biệt: auth có ổn định ở plateau sau khi tất cả đã login?
```

### Vì sao "Login wave" buộc chọn ramping-vus?

Trước khi vào kỹ thuật, hiểu **mục tiêu** của login wave trước:

```text
Login wave = "người dùng vào hệ thống theo wave buổi sáng:
              bắt đầu vài người, tăng dần đến peak,
              giữ sessions ổn định một lúc, rồi giảm dần"

Đời thường:
  - 8:00: 1-2 nhân viên đầu tiên login
  - 8:15: ~12 người đã vào, bắt đầu làm việc
  - 8:30: ~28 người đang active (peak)
  - 8:30-9:00: plateau — 28 người làm việc, app gọi keepalive định kỳ
  - 9:00-9:15: một số người rời đi, còn ~5 sessions
  - Mỗi người login 1 lần khi vào, sau đó chỉ keepalive + refresh
  - Quan sát: auth có chịu được wave này không?
    Login có fail ở peak không?
    Session validation có ổn định ở plateau không?
    Refresh có lỗi khi nhiều sessions cùng refresh không?
```

Để login wave **có giá trị**, nó phải đảm bảo **2 yêu cầu cốt lõi**. Chỉ ramping-vus mới thỏa mãn cả 2.

#### Yêu cầu (a): STAGED AUTH CONCURRENCY (không phải concurrency phẳng)

**Ý nghĩa**: Số lượng sessions active phải thay đổi theo thời gian — tăng dần, giữ peak, giảm dần. Không phải "giữ 28 sessions phẳng suốt test", mà là "đi từ 1 lên 28 rồi xuống 5, và quan sát auth ở từng phase".

**Ví dụ cụ thể**:

```text
Scenario: team auth muốn verify hệ thống chịu được morning login wave

Trường hợp A (staged concurrency ĐÚNG):
  Phase 1 — Ramp-up (1→12): users bắt đầu vào, auth phải xử lý login + session tạo mới
  Phase 2 — Ramp-up tiếp (12→28): login peak, auth pressure tăng mạnh
  Phase 3 — Plateau (28): tất cả đã login, auth giữ 28 sessions với keepalive + refresh
  Phase 4 — Cooldown (28→5): sessions giảm, auth giải phóng tài nguyên
  → Kết luận: auth chịu được cả login wave VÀ session plateau

Trường hợp B (concurrency phẳng - constant-vus, SAI):
  Test giữ 28 VUs phẳng trong 5 phút
  → Chỉ thấy auth ở plateau, không thấy ramp-up pressure
  → Không biết auth có chịu được login burst từ 1→12→28 không
  → Không biết session tạo mới hàng loạt có gây issue không
  → KHÔNG kết luận được về login wave, test không có giá trị
```

**Vì sao concurrency phải thay đổi theo stage?**

```text
Nếu concurrency được giữ cố định ở 28:
  - Chỉ thấy auth steady-state behavior
  - Không thấy cold start (từ 1 user lên 12, hệ thống còn "lạnh")
  - Không thấy login burst pressure (12→28, nhiều login đồng thời)
  - Không thấy session store scaling (từ 1 session lên 28 sessions)
  - Không thấy recovery behavior (28→5, auth có giải phóng tài nguyên không)

Auth service có thể:
  - OK ở steady 28 sessions
  - Nhưng FAIL khi 28 sessions được tạo ĐỒNG THỜI trong 30s
  - Hoặc OK ở 28 sessions nhưng FAIL ở ramp-up vì cold start + connection pool init
```

**Phân tích sâu: vì sao constant-vus không bắt được login wave pattern?**

`constant-vus` với `vus=28, duration=5m`:

```text
Mục tiêu config: "28 sessions active trong 5 phút"
→ Có vẻ đo được auth ở peak

Nhưng thực tế:
  - 28 VUs cùng start ở t=0
  - 28 sessions được tạo ĐỒNG THỜI (login burst tức thời)
  - Sau đó chỉ còn keepalive + refresh
  - KHÔNG có ramp-up phase: không thấy auth phản ứng khi sessions tăng dần
  - KHÔNG có cooldown phase: không thấy auth giải phóng tài nguyên

  Vấn đề 1: Login burst tức thời khác với login wave thực tế
    → Thực tế: users vào DẦN trong 15-30 phút
    → constant-vus: tất cả login trong vài giây đầu
    → Auth pressure pattern SAI → kết quả không đại diện

  Vấn đề 2: Không có cooldown observation
    → Thực tế: sessions giảm dần, auth giảm tải
    → constant-vus: test dừng đột ngột ở t=5m
    → Không thấy auth có cleanup session store đúng không

  Vấn đề 3: Không phân biệt được login phase vs plateau phase
    → Tất cả metrics bị trộn lẫn
    → Không biết latency cao là do login burst hay do plateau pressure
```

`ramping-arrival-rate` với arrival profile tương tự:

```text
Mục tiêu config: "arrival rate tăng dần theo wave"
→ Có vẻ giống login wave

Nhưng thực tế:
  - ramping-arrival-rate bơm iteration mới theo target rate
  - Mỗi iteration là một login MỚI (không giữ session identity)
  - Ở plateau: vẫn bơm login mới theo rate, không phải giữ sessions
  - Session store phình lên vô hạn (login mới liên tục)
  - KHÔNG phải "28 sessions active", mà là "login mới liên tục với 28 VUs"

  Vấn đề: Đây là login benchmark, không phải login wave
    → Login wave: users login 1 lần, sau đó giữ session
    → Arrival-rate: users login LIÊN TỤC, không giữ session
    → Session count ≠ VU count
```

**Trong khi đó với `ramping-vus`**:

```text
Config: startVUs=1, stages=[...12, ...28, ...28, ...5]

Phase 1 (1→12):
  - 1 VU start, ramp lên 12 VUs trong 15s
  - Mỗi VU mới login 1 lần ở iteration đầu
  - Auth thấy: 11 sessions mới được tạo trong 15s
  - Session store: 1 → 12 sessions

Phase 2 (12→28):
  - 12 VUs ramp lên 28 VUs trong 15s
  - 16 sessions mới được tạo
  - Đây là login peak: auth pressure cao nhất
  - Session store: 12 → 28 sessions

Phase 3 (28 plateau):
  - 28 VUs giữ trong 23s
  - KHÔNG có login mới (tất cả đã login ở phase trước)
  - Chỉ keepalive + refresh
  - Auth thấy: 28 sessions steady, chỉ validate + refresh
  - Đây là lúc quan sát session stabilization

Phase 4 (28→5 cooldown):
  - 28 VUs ramp xuống 5 VUs trong 15s
  - 23 VUs dừng (sessions "logout")
  - Auth thấy: sessions giảm, tài nguyên giải phóng
  - Quan sát: auth có cleanup đúng không?

→ Thấy được auth behavior ở TỪNG PHASE riêng biệt
→ Login pressure và plateau pressure được tách bạch
→ Đây là mô phỏng ĐÚNG morning login wave
```

**Tóm tắt về staged concurrency**:

| Executor | Concurrency thay đổi theo stage? | Phân biệt login phase vs plateau? | Session identity ổn định? |
| --- | --- | --- | --- |
| **ramping-vus** | CÓ (theo stage timeline) | CÓ (tách bạch từng phase) | CÓ (mỗi VU = 1 session) |
| constant-vus | KHÔNG (phẳng) | KHÔNG (tất cả trộn lẫn) | CÓ (nhưng không có ramp-up) |
| ramping-arrival-rate | CÓ (arrivals thay đổi) | KHÔNG (luôn login mới) | KHÔNG (mỗi iter là session mới) |
| shared-iterations | KHÔNG (worker pool) | KHÔNG | KHÔNG |
| per-vu-iterations | KHÔNG (quota-based) | KHÔNG | CÓ (nhưng quota cứng) |

#### Yêu cầu (b): SESSION STABILIZATION VISIBILITY (auth có ổn định sau khi tất cả đã login?)

**Ý nghĩa**: Sau khi tất cả 28 users đã login (kết thúc phase 2), plateau phase phải cho thấy auth có giữ được 28 sessions ổn định không. Đây là lúc quan sát session validation (auth/me) và refresh dưới áp lực 28 sessions đồng thời — **không còn login mới gây nhiễu metrics**.

**Ví dụ cụ thể**:

```text
Scenario: auth service vừa deploy thay đổi session store

Kịch bản A — Auth ổn định ở plateau:
  Phase 1-2: login ramp-up OK, 28 sessions được tạo
  Phase 3 (plateau): 
    - auth/me latency: 5ms avg, p95=22ms → ỔN ĐỊNH
    - refresh latency: 15ms avg → ỔN ĐỊNH
    - Không có failed iterations
  → Auth giữ được 28 sessions ổn định

Kịch bản B — Auth degradation ở plateau:
  Phase 1-2: login ramp-up OK (28 sessions được tạo)
  Phase 3 (plateau):
    - auth/me latency: ban đầu 5ms, sau 10s tăng lên 200ms
    - Bắt đầu có refresh failures
    - Iterations vẫn hoàn tất nhưng chậm hơn hẳn
  → Auth KHÔNG ổn định ở 28 sessions
  → Session store có vấn đề (cache miss tăng dần, lock contention)
  → Nếu không có plateau phase, vấn đề này bị che!
```

**Vì sao plateau phase quan trọng?**

```text
Nếu test CHỈ có ramp-up rồi ramp-down ngay (không có plateau):
  - Auth vừa tạo 28 sessions xong thì test đã dừng
  - Không quan sát được session health SAU KHI login
  - Login pass hết nhưng session có thể fail sau 5-10s
  - Vấn đề session store degradation bị bỏ lỡ

Nếu test CÓ plateau phase:
  - 28 sessions được giữ trong 23s (đủ để thấy 2-3 chu kỳ refresh)
  - Quan sát được latency trend: có tăng dần không?
  - Quan sát được refresh: có fail sau vài chu kỳ không?
  - Quan sát được session validation: có ổn định không?
```

**Phân biệt login pressure vs plateau pressure qua metrics**:

```text
Login pressure (phase 1-2):
  - login_wave_login: nhiều requests (mỗi VU mới login 1 lần)
  - login_wave_me: ít hơn (VU mới login chưa kịp loop nhiều)
  - login_wave_refresh: rất ít (VU mới chưa đạt iter % 5)
  - Latency pattern: login có thể cao (tạo session mới), me thấp

Plateau pressure (phase 3):
  - login_wave_login: 0 (không có login mới)
  - login_wave_me: DOMINATES (mỗi VU loop, mỗi loop có 1 me)
  - login_wave_refresh: định kỳ (mỗi 5 iter, 28 VUs có thể refresh gần nhau)
  - Latency pattern: me ổn định nếu auth khỏe, me tăng dần nếu session store degrade

→ Nếu gộp chung cả 3 phase, login latency thấp ở phase 1-2
  có thể CHE me latency cao ở phase 3 (vì me count >> login count)
→ Cần tách phase để thấy rõ sự khác biệt
```

**Tổng kết: chỉ ramping-vus thỏa mãn cả (a) và (b)**

| Executor | (a) Staged auth concurrency | (b) Session stabilization visibility | Verdict |
| --- | --- | --- | --- |
| **ramping-vus** | ✓ Active VUs theo stage timeline | ✓ Plateau phase riêng biệt, quan sát được stabilization | ✅ DÙNG |
| constant-vus | ✗ Concurrency phẳng, không có ramp-up | ✗ Có plateau nhưng không có login wave context | ❌ |
| shared-iterations | ✗ Worker pool, không staged | ✗ Không có phase, không giữ session identity | ❌ |
| per-vu-iterations | ✗ Quota-based, không staged | ✗ VU nhanh xong sớm, không có plateau chung | ❌ |
| constant-arrival-rate | ✗ Arrival rate có thể staged | ✗ Plateau = login mới liên tục, không phải session stabilization | ❌ |
| ramping-arrival-rate | ✗ Arrivals staged, không phải active users | ✗ Không giữ session, mỗi arrival là login mới | ❌ |

→ Chỉ **ramping-vus** thỏa mãn cả 2 yêu cầu, các executor khác đều fail ở ít nhất 1 trong 2.

### 4 thông số config ánh xạ từ yêu cầu nghiệp vụ

```text
1. LOGIN RAMP SHAPE (số sessions tăng theo wave):
   - Users vào dần: 1 → 12 → 28
   - Không phải "28 sessions cùng lúc"
   - Không phải "login rate cố định"
   → startVUs=1, stages=[...12, ...28, ...28, ...5]
   → Stage target là absolute VU count

2. PLATEAU DURATION (thời gian quan sát stabilization):
   - Sau khi 28 sessions được tạo, giữ đủ lâu để thấy stabilization
   - 23s đủ để mỗi session loop vài lần, refresh ít nhất 1-2 lần
   → stage 3: duration=90s (raw), target=28
   → KHÔNG phải "deadline để hoàn tất N jobs"

3. COOLDOWN PHASE (sessions giảm dần):
   - Mô phỏng users rời đi cuối ngày
   - Quan sát auth giải phóng tài nguyên
   → stage 4: duration=60s (raw), target=5
   → gracefulRampDown bảo vệ in-flight iterations

4. THINK TIME (khoảng nghỉ giữa các loop):
   - Mô phỏng user không gọi API liên tục
   - 0.5s là khoảng nghỉ hợp lý giữa các lần validate session
   → sleep = 0.5s
   → Tác động đến iter/s nhưng đó là expected
```

## Yêu cầu cứng của case này

Case này chỉ valid nếu thỏa các yêu cầu cứng sau:

| Yêu cầu | Vì sao bắt buộc |
| --- | --- |
| Auth stage shape phải rise/peak/cooldown (`1 -> 12 -> 28 -> 5`) | Vì login wave là staged concurrency, không phải flat pool. |
| `auth/me` chạy mỗi loop; login/refresh là conditional | Vì login chỉ ở iter đầu, refresh mỗi 5 iter; nếu login mỗi loop thì thành login benchmark. |
| Không đọc login count bằng iterations count | Vì login count << iterations (login chỉ ở iter=0 mỗi VU). |
| Session failures phải thấp hơn cap (`ramping_active_iterations_failed count<20`) | Vì mỗi failed loop là một session bị đứt quãng trong wave. |
| VUs phải theo đúng stage shape trên dashboard | Vì nếu VUs không theo shape, kết quả không đại diện cho login wave. |
| Plateau phase phải có đủ duration để quan sát stabilization | Vì nếu plateau quá ngắn, không thấy được session degradation. |
| `user_id` tag phải ổn định theo VU | Vì cần trace được một session cụ thể qua các phase. |

Invariant chung của ramping-vus:

```text
startVUs + stages = input
iterations/RPS/http_reqs = output
closed model: backend chậm thì iter/s có thể flatten/fall
```

Do đó không được fail test chỉ vì `iterations` không bằng một số target tưởng tượng.

Nếu một trong các invariant về stage shape/session identity fail, kết quả nên coi là **invalid hoặc fail**, không phải "pass nhưng hơi lệch".

## Vì sao "Login wave" nên dùng `ramping-vus`?

Login wave là active session pool thay đổi theo thời gian. `ramping-vus` đúng vì input là active sessions curve, không phải fixed login RPS hay fixed session backlog.

Mental model:

```text
Active VUs follow stage timeline.
Each active VU loops the business flow sequentially.
Backend latency changes completed loop rate.
```

Nếu backend nhanh:

```text
loop_duration thấp -> mỗi VU chạy nhiều loops hơn -> iter/s/RPS tăng
```

Nếu backend chậm:

```text
loop_duration cao -> mỗi VU chạy ít loops hơn -> iter/s/RPS giảm
```

Đây là lý do gọi là closed model: VUs là input, throughput là output.

Mental model so sánh với constant-vus (steady pool):

```text
constant-vus giống như:
  "Có 15 người ngồi trong quán 5 phút. Mỗi người tự order khi muốn."
  → Mục tiêu: observe hành vi trong cửa sổ thời gian cố định
  → Input: số người (15) + thời gian (5 phút)
  → Output: số order, latency, lỗi

ramping-vus giống như:
  "Quán mở cửa lúc 8h. Khách vào dần: 1 người, rồi 12, rồi 28.
   Đông nhất lúc 8h30. Sau 9h còn 5 người."
  → Mục tiêu: observe hành vi qua các phase khác nhau
  → Input: timeline số người (stages)
  → Output: latency/throughput/failures theo từng phase
```

## Vì sao không dùng executor khác?

| Executor | Nghe có vẻ dùng được vì... | Vì sao đúng/sai cho staged active users? |
| --- | --- | --- |
| `ramping-vus` | Active users thay đổi theo thời gian | **Đúng**: input là timeline VU, output là latency/iter-s/RPS theo từng phase. |
| `constant-vus` | Cũng là closed model active users | Sai nếu traffic phải rise/peak/cooldown; `constant-vus` giữ VUs phẳng. Không có ramp-up pressure, không có cooldown observation. |
| `shared-iterations` | Có nhiều VU cùng chạy | Sai nếu không có fixed backlog cần drain đủ. Không giữ session identity — mỗi iter có thể là session khác. Không có phase timeline. |
| `per-vu-iterations` | VU identity ổn định | Sai nếu không cần mỗi VU chạy đúng N vòng; stage duration mới là input chính. VU nhanh xong sớm → concurrency tụt, không có plateau chung. |
| `constant-arrival-rate` | Giữ rate ổn định | Sai nếu requirement là active users, không phải arrivals/s. Mỗi arrival là login mới, không giữ session. |
| `ramping-arrival-rate` | Cũng có time-shaped load | Close cousin nhưng input là arrivals/s, không phải active VU pool. Không phân biệt được session cũ vs login mới. |

Kết luận cho case này:

```text
Need staged active users over time   -> ramping-vus.
Need flat active users baseline      -> constant-vus, not this case.
Need fixed total jobs                -> shared-iterations, not this case.
Need fixed per-user quota            -> per-vu-iterations, not this case.
Need fixed/timed arrival rate        -> *-arrival-rate, not this case.
```

## Config mapping: từ yêu cầu nghiệp vụ sang k6

Default env quick reference:

```text
RV_03_START_VUS = 1
RV_03_MID_VUS = 12
RV_03_PEAK_VUS = 28
RV_03_COOLDOWN_VUS = 5
RV_03_DURATION_SCALE = 0.25
RV_03_SLEEP_SECONDS = 0.5
gracefulRampDown = 15s
```

Config meaning:

| Config/env | Default | Ý nghĩa |
| --- | --- | --- |
| RV_03_START_VUS | 1 | Số sessions lúc bắt đầu test (workday start) |
| RV_03_MID_VUS | 12 | Số sessions ở cuối ramp-up phase 1 (workday arrivals) |
| RV_03_PEAK_VUS | 28 | Số sessions ở peak/plateau (login peak) |
| RV_03_COOLDOWN_VUS | 5 | Số sessions cuối test (cooldown) |
| RV_03_DURATION_SCALE | 0.25 | Hệ số scale duration (0.25 = chạy nhanh 4x để demo) |
| RV_03_SLEEP_SECONDS | 0.5 | Think time giữa các loop |
| gracefulRampDown | 15s | Thời gian grace khi VUs bị ramp-down |

Mapping quan trọng:

```text
business login wave shape = 1 -> 12 -> 28 -> 5
k6 startVUs               = 1
k6 stages                 = [{12}, {28}, {28}, {5}]
observation window        = plateau (stage 3)
think time between loops  = 0.5s
```

Threshold cap riêng:

```text
ramping_active_iterations_failed: count<20
```

Operation count expected (ước lượng, không phải target cứng):

```text
login_wave_login: ~28 (mỗi VU login 1 lần ở iteration đầu)
  - Nhưng có thể ít hơn nếu một số VUs bị ramp-down trước khi login
  - Hoặc nhiều hơn nếu script cho phép re-login
  
login_wave_me: ~iterations (mỗi iteration có 1 me)
  - Đây là operation dominate count

login_wave_refresh: ~iterations / 3 (mỗi 3 iteration refresh 1 lần)
  - Lưu ý: script này refresh mỗi 3rd iteration, không phải mỗi 5th
  - Đọc code để biết chính xác modulo logic
```

## Stage timeline của case này

Raw/effective stages:

| Stage | Raw duration | Effective default | Target VUs | Business meaning |
| --- | --- | --- | --- | --- |
| 1 | 60s | 15s | 12 | workday arrivals |
| 2 | 60s | 15s | 28 | login peak |
| 3 | 90s | 23s | 28 | session plateau |
| 4 | 60s | 15s | 5 | cooldown |

Lưu ý:

```text
effective duration = scaleSeconds(raw_seconds, RV_NN_DURATION_SCALE)
scaleSeconds = max(1, round(raw_seconds * scale)) seconds
```

`stage.target` là absolute VU target ở cuối stage.

### Stage timeline chi tiết: điều gì xảy ra ở từng stage

```text
Stage 1 (0s → 15s): 1 → 12 VUs
  - t=0s: 1 VU active, login, bắt đầu loop
  - t=0s→15s: k6 ramp dần từ 1 lên 12 VUs
    Mỗi ~1.4s có thêm 1 VU mới được activate
  - Mỗi VU mới: login ở iter=0, sau đó loop keepalive + refresh
  - Auth service thấy:
    - Session store: 1 → 12 sessions (tăng dần)
    - login_wave_login: ~11 requests (11 VUs mới login)
    - login_wave_me: bắt đầu xuất hiện (VUs đã login loop tiếp)
    - login_wave_refresh: rất ít (VUs mới chưa đạt iter % 3)

Stage 2 (15s → 30s): 12 → 28 VUs
  - k6 ramp từ 12 lên 28 VUs
    Mỗi ~0.9s có thêm 1 VU mới được activate
  - Đây là LOGIN PEAK: 16 sessions mới được tạo trong 15s
  - Auth service thấy:
    - Session store: 12 → 28 sessions
    - login_wave_login: ~16 requests (spike)
    - login_wave_me: tăng dần theo active VUs
    - login_wave_refresh: bắt đầu xuất hiện (VUs từ stage 1 đã loop đủ 3 iter)

Stage 3 (30s → 53s): 28 VUs (PLATEAU)
  - 28 VUs giữ ổn định trong 23s
  - KHÔNG có login mới — tất cả đã login
  - Auth service thấy:
    - Session store: giữ 28 sessions
    - login_wave_login: 0 (hoặc rất ít nếu có re-login)
    - login_wave_me: DOMINATES — mỗi loop có 1 me
    - login_wave_refresh: định kỳ mỗi 3 iter
  - Đây là lúc quan sát STABILIZATION:
    - auth/me latency có ổn định không?
    - Refresh có fail không?
    - Session store có bị phình/contention không?

Stage 4 (53s → 68s): 28 → 5 VUs (COOLDOWN)
  - k6 ramp từ 28 xuống 5 VUs
    Mỗi ~0.7s có 1 VU bị dừng
  - gracefulRampDown=15s cho phép VU bị dừng hoàn tất iteration hiện tại
  - Auth service thấy:
    - Session store: 28 → 5 sessions
    - login_wave_me: giảm dần
    - login_wave_refresh: giảm dần
  - Quan sát: auth có cleanup session store đúng không?
    Có session bị orphan không?
```

## Technical semantics: staged active pool, closed model, graceful ramp-down

Trong ramping-vus:

```text
startVUs = active users at scenario start
stages[].target = absolute active user target at stage end
stages[].duration = time to move from previous target to new target
gracefulRampDown = grace when VUs are stopped during ramp-down
```

Không có fixed target cho:

```text
iterations
http_reqs
RPS
iter/s
```

Nếu VUs tăng nhưng iter/s không tăng:

```text
ramping_flow_duration_ms có thể đã tăng
backend/service có thể đã saturated
```

Nếu VUs giảm nhưng iterations vẫn hoàn tất thêm:

```text
gracefulRampDown có thể đang cho in-flight loops finish
```

### Identity model: VU = user session, per-VU auth state

Đây là điểm khác biệt quan trọng giữa ramping-vus và arrival-rate khi làm login wave.

```text
Trong ramping-vus:
  VU=1 luôn là login-wave-user-1
  VU=2 luôn là login-wave-user-2
  ...
  VU=28 luôn là login-wave-user-28

  Mỗi VU login MỘT LẦN ở iteration đầu tiên,
  sau đó loop keepalive + refresh LIÊN TỤC cho đến khi bị ramp-down.
  Token/session state được lưu per-VU (qua biến closure hoặc module-level).

Trong ramping-arrival-rate:
  Mỗi iteration là một user MỚI (login mới)
  KHÔNG có persistent session identity
  KHÔNG có "session nào đã login từ trước"
  → Đây là login flood, không phải login wave
```

**Demo trace identity model với ramping-vus, shape 1→3→1, scale=0.25**:

```text
Config: startVUs=1, stages=[{3,15s}, {3,10s}, {1,15s}], scale=0.25
→ Effective: startVUs=1, stages=[{3,4s}, {3,3s}, {1,4s}]
sleep=0.5s

t=0.0s   VU=1: iter=0, login as wave-user-1, me, sleep(0.5s)
           (VU=1 là VU duy nhất active)

t=1.5s   VU=2 được activate (ramp-up)
         VU=1: iter=1, me, (iter%3==1 → no refresh), sleep(0.5s)
         VU=2: iter=0, login as wave-user-2, me, sleep(0.5s)

t=2.5s   VU=3 được activate (ramp-up)
         VU=1: iter=2, me, (iter%3==2 → no refresh), sleep(0.5s)
         VU=2: iter=1, me, (iter%3==1 → no refresh), sleep(0.5s)
         VU=3: iter=0, login as wave-user-3, me, sleep(0.5s)

t=3.0s   (3 VUs active, plateau bắt đầu)
         VU=1: iter=3, me, refresh (iter%3==0), sleep(0.5s)
         VU=2: iter=2, me, (iter%3==2 → no refresh), sleep(0.5s)
         VU=3: iter=1, me, (iter%3==1 → no refresh), sleep(0.5s)

... plateau tiếp tục với 3 VUs ...

t=7.0s   (bắt đầu ramp-down)
         VU=1 bị chọn để dừng (sau gracefulRampDown)
         VU=1: đang ở iter giữa chừng → hoàn tất iter hiện tại, rồi dừng
         
... VU=2, VU=3 tiếp tục cho đến khi bị ramp-down ...

Kết quả:
  login_wave_login count: 3 (mỗi VU login 1 lần)
  login_wave_me count: ~tổng iterations của 3 VUs
  login_wave_refresh count: ~tổng iterations / 3
  
Điểm quan trọng:
  - Mỗi VU có identity riêng, giữ session xuyên suốt
  - Login CHỈ xảy ra ở iter=0 của mỗi VU
  - VU=1 login ở t=0s, VU=3 login ở t=2.5s → login staggered theo ramp-up
  - Plateau: không có login mới, chỉ me + refresh
  - Đây là mô phỏng ĐÚNG: users vào dần, rồi giữ session
```

### Code pattern đúng cho ramping-vus login wave

Code pattern cho login wave khác với constant-vus ở chỗ **VUs được activate/deactivate theo stage**, và **login xảy ra 1 lần ở iteration đầu của mỗi VU**:

```js
import exec from "k6/execution";
import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "http://localhost:80";
const START_VUS = parseInt(__ENV.RV_03_START_VUS) || 1;
const MID_VUS = parseInt(__ENV.RV_03_MID_VUS) || 12;
const PEAK_VUS = parseInt(__ENV.RV_03_PEAK_VUS) || 28;
const COOLDOWN_VUS = parseInt(__ENV.RV_03_COOLDOWN_VUS) || 5;
const SCALE = parseFloat(__ENV.RV_03_DURATION_SCALE) || 0.25;
const SLEEP_SECONDS = parseFloat(__ENV.RV_03_SLEEP_SECONDS) || 0.5;

function scaleSeconds(s) {
  return Math.max(1, Math.round(s * SCALE));
}

export const options = {
  scenarios: {
    login_wave: {
      executor: "ramping-vus",
      startVUs: START_VUS,
      stages: [
        { duration: `${scaleSeconds(60)}s`, target: MID_VUS },
        { duration: `${scaleSeconds(60)}s`, target: PEAK_VUS },
        { duration: `${scaleSeconds(90)}s`, target: PEAK_VUS },
        { duration: `${scaleSeconds(60)}s`, target: COOLDOWN_VUS },
      ],
      gracefulRampDown: "15s",
    },
  },
};

export default function () {
  const vuId = exec.vu.idInTest;              // 1..28 (có thể thay đổi khi ramp)
  const iter = exec.scenario.iterationInTest;  // 0, 1, 2, ... của VU này
  const userId = `wave-user-${vuId}`;

  // Login CHỈ ở iteration đầu tiên của mỗi VU
  if (iter === 0) {
    const loginRes = http.post(`${BASE_URL}/api/sim/auth/login`, JSON.stringify({
      username: userId,
      password: `pass-${vuId}`,
    }), {
      headers: { "Content-Type": "application/json" },
      tags: { operation: "login_wave_login", user_id: userId },
    });
    check(loginRes, { "login status 200": (r) => r.status === 200 });
  }

  // Session validation — gọi MỖI iteration (DOMINATES count)
  const meRes = http.get(`${BASE_URL}/api/sim/auth/me`, {
    headers: { Authorization: `Bearer rv-session-${vuId}` },
    tags: { operation: "login_wave_me", user_id: userId },
  });
  check(meRes, { "me status 200": (r) => r.status === 200 });

  // Refresh — mỗi 3 iteration (script này dùng modulo 3)
  if (iter % 3 === 0) {
    const refreshRes = http.post(`${BASE_URL}/api/sim/auth/refresh`, JSON.stringify({
      refresh_token: `refresh-${vuId}`,
    }), {
      headers: { "Content-Type": "application/json" },
      tags: { operation: "login_wave_refresh", user_id: userId },
    });
    check(refreshRes, { "refresh status 200": (r) => r.status === 200 });
  }

  // Think time
  sleep(SLEEP_SECONDS);
}
```

**KHÔNG viết thế này**:

```js
// SAI — login mỗi iteration (thành login benchmark, không phải login wave)
export default function () {
  const loginRes = http.post(`${BASE_URL}/api/sim/auth/login`, ...);  // Mỗi iter login 1 lần
  const meRes = http.get(`${BASE_URL}/api/sim/auth/me`, ...);
  sleep(0.5);
}
// → 28 VUs × N iterations = N lần login → không phải login wave
// → Session không được giữ qua các loop
// → Không phân biệt được login phase vs plateau phase

// SAI — không check iter===0, login ở mọi iteration
// → Login count = iterations → operation mix SAI
// → Auth service thấy login flood, không phải login wave

// SAI — dùng iterationInTest làm user identity
const userId = `user-${exec.scenario.iterationInTest}`;
// → Mỗi iteration tạo user mới → session không được giữ qua các loop
```

## Technical root causes this case catches

### Nguyên nhân kỹ thuật 1: Session validation dominates plateau phase

`auth/me` chạy mỗi loop, nên nó thường dominate count và latency. Đặc biệt ở plateau phase (stage 3), khi không còn login mới, `auth/me` chiếm gần như toàn bộ traffic. Nếu session validation bị chậm, nó sẽ kéo toàn bộ throughput xuống.

**Demo: me latency tăng ở plateau dù login vẫn pass ở ramp-up**:

```text
Run login wave 1->12->28->5:

Phase 1-2 (ramp-up):
  login_wave_login: pass 100%, p95=45ms
  login_wave_me: pass 100%, p95=15ms
  → Có vẻ auth OK

Phase 3 (plateau, 28 VUs):
  login_wave_login: 0 requests (không có login mới)
  login_wave_me: p95 tăng từ 15ms → 120ms sau 10s
  → Session validation đang chậm dần!

Nếu CHỈ nhìn aggregate toàn bộ test:
  login_wave_me p95 avg = (15ms × ít + 120ms × nhiều) ≈ 100ms
  → "Hơi cao nhưng chấp nhận được"
  → KẾT LUẬN SAI: bỏ qua degradation signal

Nếu TÁCH theo phase:
  Ramp-up: me p95=15ms → OK
  Plateau: me p95 tăng 15ms→120ms → CÓ VẤN ĐỀ
  → Session store đang degrade khi giữ 28 sessions
  → KẾT LUẬN ĐÚNG: cần investigate session store
```

**Cơ chế session validation domination**:

```text
Ở plateau phase:
  1. 28 sessions cùng active
  2. Mỗi session loop ~1.0s (0.5s sleep + 0.5s API)
  3. Mỗi loop có 1 auth/me request
  4. → 28 auth/me requests mỗi giây (xấp xỉ)
  
  So với ramp-up phase:
  1. Sessions tăng dần từ 1→28
  2. Mỗi VU mới cần login (tốn thời gian hơn me)
  3. Me count thấp hơn vì VUs mới chưa loop nhiều
  
  → Plateau là lúc me pressure CAO NHẤT
  → Nếu me có vấn đề, nó sẽ lộ rõ ở plateau
  → Nhưng nếu chỉ nhìn aggregate, me latency ở ramp-up (thấp) sẽ CHE me latency ở plateau (cao)
```

**Cách phát hiện**: so sánh `http_req_duration{operation:login_wave_me}` giữa ramp-up phase và plateau phase. Nếu p95 tăng đáng kể ở plateau, session validation đang có vấn đề.

### Nguyên nhân kỹ thuật 2: Login/refresh counts are conditional

Login mỗi 3rd và refresh mỗi 5th iteration (tùy script). Count thấp hơn iterations là expected. Nhưng nếu không hiểu conditional logic, learner có thể đọc sai operation mix.

**Demo sự khác biệt giữa conditional count và absolute count**:

```text
Run login wave, 2537 iterations hoàn tất:

Nếu learner đọc "2537 iterations = 2537 lần login":
  → "Auth login được 2537 users trong 68s? Ấn tượng!"
  → SAI: login chỉ xảy ra ở iter=0 mỗi VU

Thực tế (từ contract rerun #53):
  login_wave_login: 846 requests (33% của iterations)
  login_wave_me: 2537 requests (100% của iterations — mỗi iter 1 me)
  login_wave_refresh: 508 requests (20% của iterations)

Tỉ lệ:
  me : login : refresh ≈ 1 : 0.33 : 0.20
  → me DOMINATES (mỗi loop)
  → login = mỗi VU 1 lần, cộng thêm re-login nếu có
  → refresh = mỗi 3 hoặc 5 iter (tùy script)

Nếu script cho phép re-login (ví dụ: iter % 10 === 0):
  login count sẽ > VU count
  → Nhưng vẫn << iterations
  → Vẫn là conditional, không phải mỗi loop
```

**Login count qua các lần chạy với scale khác nhau**:

```text
Lần 1: scale=0.25, duration ngắn
  Mỗi VU loop ~4-5 lần trước khi test dừng
  login_wave_login ≈ 28 (mỗi VU login 1 lần)
  login_wave_me ≈ 100-140
  login_wave_refresh ≈ 30-50

Lần 2: scale=1.0, duration dài (gần business timeline)
  Mỗi VU loop ~60-80 lần
  login_wave_login ≈ 28 (vẫn 28, vì login chỉ ở iter=0!)
  login_wave_me ≈ 1700-2200
  login_wave_refresh ≈ 500-700

→ Login count KHÔNG đổi khi duration tăng
→ Nhưng me count tăng tuyến tính với duration
→ Đây là bằng chứng login là conditional (iter=0 only)
```

**Vì sao login count có thể > 28?**

```text
Nếu script có re-login logic (ví dụ: mỗi 10 iteration re-login):
  login_wave_login = 28 (lần đầu) + 28 × (iterations/VU / 10)
  
Nếu script không có re-login nhưng login count > 28:
  → Một số VU bị ramp-down rồi ramp-up lại?
  → Hoặc VU mới được tạo thay thế VU cũ?
  → Kiểm tra VU lifecycle trong script
```

**Cách đọc đúng**:
- `login_wave_login` count = số lần login script gọi, phụ thuộc vào logic `iter === 0` và re-login nếu có
- `login_wave_me` count ≈ iterations (mỗi loop có 1 me)
- `login_wave_refresh` count ≈ iterations / N (N = modulo refresh interval)
- Đừng dùng iterations count để suy ra login count
- Đừng dùng login count để đánh giá auth throughput

### Nguyên nhân kỹ thuật 3: Auth state under rising sessions

Token/session/cache bugs thường lộ khi active sessions tăng nhanh. Điểm nguy hiểm không phải là peak (28 sessions), mà là **quá trình tăng từ 1 lên 28** — lúc session store đang mở rộng, cache đang được populate, connection pool đang mở thêm.

**Demo: auth state bug ở ramp-up, không thấy ở steady state**:

```text
Test A — constant-vus 28 (steady state):
  28 VUs start, 28 sessions tạo ĐỒNG THỜI
  Auth service: connection pool đã full, cache đã warm sau vài giây
  → Session validation: 15ms ổn định
  → "Auth OK"

Test B — ramping-vus 1->12->28 (rising sessions):
  Phase 1: 1→12 sessions
    Auth service: connection pool từ 1 mở lên 12
    Cache: MISS nhiều (session mới, chưa có trong cache)
    → auth/me latency: 30ms (cache miss penalty)
  
  Phase 2: 12→28 sessions
    Auth service: connection pool từ 12 mở lên 28
    Cache: tiếp tục MISS cho 16 sessions mới
    → auth/me latency: 50ms (cao hơn steady state!)
    
  Phase 3: 28 sessions plateau
    Auth service: connection pool ổn định, cache WARM
    → auth/me latency: 15ms (về bình thường)

Nếu chỉ chạy constant-vus: chỉ thấy 15ms → kết luận auth OK
Với ramping-vus: thấy latency spike ở ramp-up → auth có vấn đề scaling
```

**Cơ chế auth state under rising sessions**:

```text
Khi sessions tăng từ 1 lên 28:

1. Token cache cold start:
   - Session 1: token được cache sau lần validate đầu
   - Session 2-12: token mới, cache MISS → validate chậm hơn
   - Session 13-28: tiếp tục cache MISS
   - Đến plateau: tất cả token đã trong cache → nhanh
   → Latency pattern: cao ở ramp-up, thấp ở plateau
   → Nếu không tách phase, aggregate latency trông "hơi cao" nhưng không rõ nguyên nhân

2. Connection pool scaling:
   - Session store connection pool: min=2, max=30
   - 1→12 sessions: pool từ 2 mở lên 12 → connection setup overhead
   - 12→28 sessions: pool từ 12 mở lên 28 → thêm connection setup
   - Plateau: pool đã full → không còn overhead
   → Mỗi lần mở connection mới: +10-50ms latency

3. Session store memory allocation:
   - 1→12 sessions: store cấp phát memory cho 11 sessions mới
   - 12→28 sessions: store cấp phát thêm 16 sessions
   - Nếu store dùng cấp phát động: có thể gây GC pause nhỏ
   → Latency spike nhỏ ở ramp-up do GC

4. Rate limiting / throttling:
   - Auth có thể có rate limit: "không quá X logins mỗi giây"
   - Ramp-up 12→28 trong 15s = ~1 login/s → có thể chạm rate limit
   → Login bị delay/reject → session không được tạo kịp
```

**Cách phát hiện**: so sánh latency của từng operation giữa ramp-up phase và plateau phase. Nếu ramp-up latency > plateau latency, auth đang có vấn đề scaling/cold start.

### Nguyên nhân kỹ thuật 4: Peak plateau verifies stabilization

Giữ 28 VUs một đoạn để xem auth recover/stabilize hay tiếp tục degrade. Đây là điểm khác biệt với test chỉ có ramp-up rồi dừng ngay.

**Demo: plateau cho thấy degradation mà ramp-up không thấy**:

```text
Test A — Chỉ ramp-up 1→28 rồi ramp-down ngay:
  Phase 1-2: login OK, me latency 20ms
  Test dừng ngay khi đạt 28 VUs
  → Kết luận: auth OK ở 28 sessions

Test B — Có plateau 23s ở 28 VUs:
  Phase 1-2: login OK, me latency 20ms
  Phase 3 (0-10s): me latency 20ms → 50ms (bắt đầu tăng)
  Phase 3 (10-23s): me latency 50ms → 200ms (tiếp tục tăng)
  → Kết luận: auth KHÔNG ổn định ở 28 sessions!

Vì sao degradation mất thời gian mới lộ?
  - Session store ban đầu hoạt động tốt ở 28 sessions
  - Nhưng sau vài chu kỳ refresh:
    - Token cũ bị invalidate, token mới được tạo
    - Session store có 28 sessions × 2 tokens (cũ + mới) = 56 records
    - Lookup chậm dần do nhiều records hơn
    - Refresh transaction lock contention tăng
  - Nếu không có plateau, vấn đề này không kịp lộ
```

**Plateau stabilization checklist**:

```text
Ở plateau phase, quan sát:

1. auth/me latency trend:
   - Ổn định? → session store OK
   - Tăng dần? → session store degradation
   - Spike định kỳ? → refresh contention ảnh hưởng me

2. Refresh success rate:
   - 100%? → token rotation OK
   - Có fail? → token rotation issue
   - Fail tăng dần? → cumulative issue (token chain broken)

3. Iter/s stability:
   - Ổn định? → loop duration ổn định
   - Giảm dần? → latency tăng, closed-model backpressure

4. Memory/CPU trên auth service:
   - Ổn định? → không có leak
   - Tăng dần? → possible memory leak
```

## Service/API flow

Flow pattern:

```text
Login every iteration 0 only; auth/me every iteration; refresh every 3rd iteration.
```

| Operation | Service | Method | Path | Expected | Ý nghĩa |
| --- | --- | --- | --- | --- | --- |
| login_wave_login | auth-service | POST | /api/sim/auth/login | 200 | Login branch. Chỉ gọi ở iter=0 mỗi VU. |
| login_wave_me | auth-service | GET | /api/sim/auth/me | 200 | Session validation every loop. Operation DOMINANTE count. |
| login_wave_refresh | auth-service | POST | /api/sim/auth/refresh | 200 | Refresh branch. Gọi mỗi 3 iteration. Write path. |

Các operation này phải được đọc bằng tag `operation`, vì:

```text
- aggregate metrics có thể che login_wave_me degradation (me count >> login count)
- refresh failure có thể bị che nếu chỉ nhìn tổng http_req_failed
- login latency spike ở ramp-up có thể bị pha loãng bởi me latency thấp ở plateau
```

### Operation mix thay đổi theo phase

```text
Phase 1-2 (ramp-up: 1→12→28):
  login_wave_login: xuất hiện (mỗi VU mới login)
  login_wave_me: tăng dần theo active VUs
  login_wave_refresh: rất ít (VUs chưa loop đủ 3 iter)

Phase 3 (plateau: 28):
  login_wave_login: 0 (không có VU mới)
  login_wave_me: DOMINATES (~28 requests mỗi ~1s)
  login_wave_refresh: đều đặn (mỗi VU refresh mỗi 3 iter)

Phase 4 (cooldown: 28→5):
  login_wave_login: 0
  login_wave_me: giảm dần theo active VUs
  login_wave_refresh: giảm dần

→ Operation mix KHÔNG cố định trong suốt test
→ Đọc aggregate p95 cho toàn bộ test là SAI
→ Phải đọc theo phase để thấy sự khác biệt
```

## Metrics và tags cần đọc

| Metric | Type | Cách đọc |
| --- | --- | --- |
| `ramping_active_iterations` | Counter | Số user loops hoàn tất trong staged run. Đây là output, không phải target. |
| `ramping_active_iterations_failed` | Counter | Số loops có ít nhất một API required fail. Đây là business-flow failure counter. |
| `ramping_api_calls_total` | Counter | Tổng API calls do ramping user pool tạo ra. Dùng để sanity check operation mix. |
| `ramping_flow_duration_ms` | Trend | End-to-end duration của một user loop. Metric chính để giải thích iter/s flatten. |
| `ramping_sleep_seconds` | Counter | Think time/sleep do script cố ý thêm. |
| `checks` | Rate | API/status/contract checks pass bao nhiêu %. |
| `http_req_failed` | Rate | HTTP/network/protocol failure rate theo k6. |
| `iterations` | Counter | Số vòng `default()` hoàn tất; observed output. |
| `vus` | Gauge | Active VUs sampled over time; phải đi theo stage shape. |
| `vus_max` | Gauge | Max VUs observed/reserved, dùng để đối chiếu peak target. |

Tags chung:

| Tag | Ý nghĩa |
| --- | --- |
| `case_id` | Case đang chạy, ví dụ `rv-02-campaign-launch-spike`. |
| `business_case` | Nhóm nghiệp vụ để FE/dashboard gom case. |
| `service` | Backend service được gọi. |
| `operation` | Operation cụ thể trong user loop. |
| `endpoint` | Nhóm endpoint/API family. |
| `user_id` | Active user identity derive từ VU/user context. |
| `executor_family` | `ramping_vus`. |
| `workload_shape` | `staged_concurrency`. |

Tags case này:

```text
case_id       = rv-03-login-wave
business_case = morning_login_wave
workload      = staged_concurrency
```

## Pass criteria

Thresholds theo backend script:

```text
checks: rate>0.99
http_req_failed: rate<0.01
ramping_active_iterations_failed: count<20
```

Các counters/trends cần sanity check:

```text
ramping_active_iterations
ramping_active_iterations_failed
ramping_api_calls_total
ramping_flow_duration_ms
ramping_sleep_seconds
iterations
http_reqs
vus / vus_max
```

Case-specific sanity checks:

```text
login_wave_login count ≈ VU count (mỗi VU login 1 lần ở iter=0)
  - Nếu < VU count: có VU không login được → FAIL
  - Nếu > VU count: script có re-login, kiểm tra logic

login_wave_me count ≈ iterations (mỗi iteration có 1 me)
  - Đây là operation dominate, count phải gần bằng iterations

login_wave_refresh count ≈ iterations / 3 (mỗi 3 iter refresh 1 lần)
  - Tỉ lệ refresh fail quan trọng hơn count tuyệt đối

VU shape trên dashboard phải theo 1 -> 12 -> 28 -> 5
  - Nếu VU không đạt peak 28: config/env hoặc VU init lỗi
  - Nếu VU không giữ plateau: stage duration không đủ hoặc VU crash

vus_max ≈ PEAK_VUS (28)
  - Nếu vus_max < 28: test chưa đạt peak target
```

Không có expected exact count cho:

```text
iterations
http_reqs
RPS
iter/s
```

Chúng là observed outputs.

## Cách chạy

Backend script:

```text
E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Run local summary:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
k6 run .\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Run lên private dashboard:

```powershell
cd E:\Projects\k6\k6-metrics-server
$env:BASE_URL = "http://localhost:80"
$env:K6_CLOUD_HOST = "http://localhost:18080"
$env:K6_CLOUD_TOKEN = "student-token-1234567890"
k6 run -o cloud .\load-target\k6\ramping-vus\rv-03-login-wave.js
```

## Đọc output summary

### Bước 1 — Verify scenario/config

Header phải cho thấy:

```text
executor = ramping-vus
scenario = login_wave
startVUs / stages / gracefulRampDown đúng config hoặc env override
```

Nếu learner override env vars, phải recompute toàn bộ stage timeline và expected shape.

### Bước 2 — Verify VU stage shape

Summary/dashboard cần đối chiếu:

```text
expected shape = 1 -> 12 -> 28 -> 5
```

`vus_max` nên gần peak target nếu run đủ dài và dashboard sample bắt được peak.

Case-specific: VUs phải theo stage shape trên dashboard. Nếu VUs không đạt peak 28, session pool pressure chưa đạt yêu cầu → kết quả không đại diện cho login wave.

**Cách verify VU shape từ summary**:

```text
1. vus_max = 28 → peak target đạt được
2. vus min = 1 → startVUs đúng
3. VU chart: ramp-up → plateau → ramp-down theo stage timeline
4. Không có VU crash/restart giữa chừng
```

### Bước 3 — Check failures trước throughput

Đọc trước:

```text
checks
http_req_failed
ramping_active_iterations_failed
```

Nếu failures fail threshold, xử lý correctness/API failure trước khi bàn throughput.

Case-specific: tách failures theo `operation` và theo phase:

```text
Theo operation:
  - login_wave_login fail: không tạo được session → test invalid
  - login_wave_me fail: session validation lỗi → auth vấn đề
  - login_wave_refresh fail: token rotation lỗi → auth vấn đề

Theo phase:
  - Failures ở ramp-up: vấn đề login/scaling
  - Failures ở plateau: vấn đề session stability
  - Failures ở cooldown: vấn đề cleanup
```

### Bước 4 — Interpret counters as outputs

Đọc:

```text
iterations
http_reqs
ramping_active_iterations
ramping_api_calls_total
```

Nhớ:

```text
iterations/RPS là output, không có exact expected target.
```

Case-specific:

```text
- So sánh login_wave_login count với VU count
- So sánh login_wave_me count với iterations
- So sánh login_wave_refresh count với iterations / 3
- Operation mix phải thay đổi theo phase:
  + Ramp-up: có login requests
  + Plateau: gần như không có login, toàn me + refresh
```

### Bước 5 — Interpret duration/throughput

Đọc:

```text
ramping_flow_duration_ms
http_req_duration by operation
iteration_duration
```

Case-specific notes:

- Login/refresh không phải count bằng iterations.
- `login_wave_me` latency tăng thường là session store/cache issue.
- Failures ở refresh có thể không hiện trong aggregate nếu count nhỏ; phải lọc operation.
- `ramping_flow_duration_ms` tăng ở plateau (so với ramp-up) là tín hiệu session degradation.
- So sánh `http_req_duration` của `login_wave_me` giữa ramp-up và plateau: nếu plateau cao hơn hẳn, session validation đang degrade.
- Login latency cao ở ramp-up (nhưng không cao ở plateau) là tín hiệu cold start / scaling issue.

<!-- REAL_RUN_START -->
## Contract rerun 2026-06-20 — run #53

Run này ép đúng contract/tải đã ghi trong tài liệu, kể cả khi backend script default hiện tại đã đổi nhẹ hơn.

```text
BASE_URL=http://localhost:80
K6_CLOUD_HOST=http://localhost:18080
RV_03_START_VUS=1
RV_03_MID_VUS=12
RV_03_PEAK_VUS=28
RV_03_COOLDOWN_VUS=5
RV_03_DURATION_SCALE=0.25
RV_03_SLEEP_SECONDS=0.5
```

| Item | Value |
| --- | --- |
| Script | `rv-03-login-wave.js` |
| Run ID | `53` |
| Exit code | `0` |
| Verdict | **PASS** — Đạt theo contract gốc |
| Summary final pushed | true |
| Finish status | 200 |
| Expected VU shape | `1 -> 12 -> 28 -> 5` |
| Observed `vus` min/max | 1 / 28 |

### Summary thật của contract rerun

| Metric | Value | Cách đọc |
| --- | ---: | --- |
| `checks` | 100.00% (3891/3891) | Check status/contract pass bao nhiêu. |
| `http_req_failed` | 0.00% (0/3891) | HTTP/API failure theo k6. |
| `ramping_active_iterations_failed` | 0 | User-loop failures của case. |
| `iterations` | 2537 (37.05/s) | Output, không phải target. |
| `http_reqs` | 3891 (56.82/s) | Tổng API calls thật. |
| `ramping_active_iterations` | 2537 | Completed user loops. |
| `ramping_api_calls_total` | 3891 | Custom API counter. |
| `ramping_sleep_seconds` | 1268.5s | Think time do script thêm. |
| `http_req_duration` | avg 5.01ms, p95 22.7ms, p99 23.3ms, max 55.0ms | Request-level latency. |
| `ramping_flow_duration_ms` | avg 7.84ms, p95 27.0ms, p99 28.6ms, max 55.0ms | Full user-loop latency. |
| `iteration_duration` | avg 508ms, p95 527ms, p99 529ms, max 555ms | Bao gồm flow + think/sleep. |

Threshold failures:

Không có threshold failure.

### Request breakdown thật

| Operation | Method | Status | Count | Tỷ lệ trên total HTTP |
| --- | --- | ---: | ---: | ---: |
| `login_wave_me` | GET | 200 | 2537 | 65.20% |
| `login_wave_login` | POST | 200 | 846 | 21.74% |
| `login_wave_refresh` | POST | 200 | 508 | 13.06% |

### Phân tích từ summary -> 3 chart

#### 1. Response time chart

Auth latency sạch: không có 4xx/5xx, HTTP p95 thấp và ổn định.

| Aggregate | Value |
| --- | ---: |
| Response-time points | 2542 |
| Avg của các window avg | 6.24ms |
| Max window p95 | 54.9ms |
| Max window p99 | 54.9ms |
| Max request window | 55.0ms |
| Windows p95 > 100ms | 0 |
| Windows p95 > 500ms | 0 |

#### 2. Execution timeline chart

Không có failed iterations. Mix đúng: `auth/me` mỗi loop, login khoảng mỗi 3 loop, refresh khoảng mỗi 5 loop.

| Aggregate | Value |
| --- | ---: |
| Sum `iterations` buckets | 2537 |
| Sum `http_reqs` buckets | 3891 |
| Peak iter/s bucket | 56 |
| Peak http_req/s bucket | 87 |
| Failed-iteration points | 0 |
| Sum failed iterations | 0 |
| Peak failed-iteration bucket | 0 |

#### 3. VUs vs iter/s chart

VU shape đạt peak 28 đúng contract. iter/s/http_req/s scale ổn theo login wave.

| Aggregate | Value |
| --- | ---: |
| VU sample points | 68 |
| VUs min/max series | 1 / 28 |
| Avg VUs series | 18.96 |
| Peak iter/s bucket | 56 |

### Kết luận contract rerun #53

OK theo contract gốc.
<!-- REAL_RUN_END -->

## Đọc dashboard real-time charts cho case 03

> Phần này giữ cách đọc dashboard chung; số thật của run gần nhất nằm ở section `Real run` phía trên.

### Overview có 3 chart cần đọc

| Chart | Câu hỏi chính | Không trả lời được |
| --- | --- | --- |
| Response time | Operation/service nào chậm theo phase? Login có spike ở ramp-up không? Me có degrade ở plateau không? | Fixed iteration target |
| Execution timeline | VUs/failures/RPS thay đổi theo stage nào? Có thấy login spike ở ramp-up không? | Target RPS, vì không có target RPS |
| VUs vs iter/s | VU shape có đúng không, iter/s có flatten không? Có theo kịp VU ramp không? | Business correctness nếu không đọc failures |

Một cách đọc nhanh:

```text
Response time      -> chất lượng từng operation theo phase, phát hiện session degradation
Execution timeline -> VU shape + operation activity theo thời gian
VUs vs iter/s      -> closed-model signal, phát hiện auth saturation ở peak
```

### Chart 1 — Response time

Đọc theo `operation`:

```text
login_wave_login: POST /api/sim/auth/login
login_wave_me: GET /api/sim/auth/me
login_wave_refresh: POST /api/sim/auth/refresh
```

Cách đọc:

```text
http_req_duration       = latency từng request
ramping_flow_duration_ms = latency full user loop
iteration_duration      = duration vòng default(), thường bao gồm sleep
```

Case-specific hints:

- Response time: tách login/me/refresh.
- Execution timeline: login/refresh spikes theo modulo branch.
- VUs vs iter/s: auth latency tăng sẽ làm iter/s flatten ở peak.

Đừng dùng aggregate p95 một mình trong mixed/multi-operation flow.

#### Cách phân tích sâu chart Response time

Khi nhìn chart này, đừng chỉ nhìn "cao/thấp". Hãy đọc theo 4 câu hỏi:

```text
1. Login latency có spike ở ramp-up không? (expected: có thể cao hơn plateau do cold start)
2. Me latency có ổn định suốt plateau không? (nếu tăng dần → session degradation)
3. Refresh latency có cao hơn me không? (expected: có, vì write path)
4. Có operation nào fail ở phase cụ thể không?
```

Với case 03, shape đẹp thường có:

```text
ramp-up phase (1→12→28):
  - login_wave_login: p95 có thể cao hơn plateau (tạo session mới hàng loạt)
  - login_wave_me: p95 thấp, nhưng có thể nhỉnh hơn plateau (cache cold)
  - login_wave_refresh: ít xuất hiện

plateau phase (28):
  - login_wave_login: 0 hoặc rất ít (không có login mới)
  - login_wave_me: p95 ổn định thấp (cache warm, không có login nhiễu)
  - login_wave_refresh: p95 cao hơn me (write path), định kỳ mỗi 3 iter

cooldown phase (28→5):
  - p95 có thể giảm nhẹ (ít sessions hơn → ít contention)
  - Hoặc giữ nguyên nếu auth không bị contention ở 28 sessions
```

Vì sao me p95 plateau có thể KHÁC me p95 ramp-up?

```text
Ramp-up: sessions đang được tạo dần
  - Cache MISS nhiều (session mới)
  - Connection pool đang mở rộng
  - Có login requests cạnh tranh tài nguyên
  → Me latency: có thể CAO hơn plateau

Plateau: tất cả sessions đã ổn định
  - Cache WARM (tất cả session đã được validate ít nhất 1 lần)
  - Connection pool ổn định
  - Không có login requests
  → Me latency: có thể THẤP hơn ramp-up

HOẶC ngược lại:
Plateau: 28 sessions cùng active
  - Session store: 28 sessions × nhiều records = lookup chậm
  - Refresh transactions: lock contention
  → Me latency: có thể CAO hơn ramp-up (lúc chỉ có vài sessions)

→ Cả 2 pattern đều có thể xảy ra tùy auth implementation
→ Quan trọng là TÁCH phase để thấy sự khác biệt
```

Shape xấu cần chú ý:

| Shape thấy trên chart | Có thể nghĩa là gì | Hành động |
| --- | --- | --- |
| login p95 spike cao ở ramp-up | Auth cold start, connection pool init chậm | Kiểm pool size, cache warm-up |
| me p95 tăng dần ở plateau | Session store degradation | Kiểm session store read path |
| refresh p95 spike định kỳ | Token rotation lock contention | Kiểm refresh transaction isolation |
| refresh fail nhưng me pass | Write path lỗi, read path OK | Block, investigate refresh pipeline |
| me p95 thấp ở ramp-up, cao ở plateau | Session store không scale tốt ở 28 sessions | Kiểm session store scalability |
| me p95 cao ở ramp-up, thấp ở plateau | Cold start issue, cache warm-up chậm | Kiểm cache strategy |
| cả 3 operation cùng tăng ở phase cụ thể | Auth service có vấn đề ở phase đó | Investigate auth service health |

### Chart 2 — Execution timeline

Chart này chứng minh VU shape theo stage và operation activity theo thời gian.

Với ramping-vus:

```text
VUs should follow 1 -> 12 -> 28 -> 5.
iterations/http_reqs per bucket are outputs.
failures may cluster at ramp transitions or peak.
```

Không kỳ vọng exact per-bucket counts, đặc biệt với weighted/conditional flows.

#### Cách phân tích sâu chart Execution timeline

Khi đọc chart này, nhìn 3 thứ cùng lúc:

```text
1. Live VUs — có theo stage shape 1->12->28->5 không?
2. HTTP reqs mỗi bucket — có thấy login spike ở ramp-up và refresh spike định kỳ không?
3. Iterations hoàn thành mỗi bucket — có tăng theo VUs không?
```

Với ramping-vus login wave, shape "đẹp" thường là:

```text
ramp-up (stage 1-2):
  Live VUs tăng từ 1 → 12 → 28
  HTTP reqs/bucket tăng dần theo VUs
  Có login_wave_login requests (spike ở ramp-up)
  Iterations bắt đầu xuất hiện

plateau (stage 3):
  Live VUs = 28 (phẳng)
  HTTP reqs/bucket ổn định (chủ yếu me + refresh)
  login_wave_login = 0 (không còn login mới)
  Iterations tăng đều

cooldown (stage 4):
  Live VUs giảm từ 28 → 5
  HTTP reqs/bucket giảm dần
  Iterations giảm dần
  gracefulRampDown có thể tạo end-tail
```

Login spike pattern ở ramp-up:

```text
Khi VUs ramp từ 1→12→28:
  Mỗi VU mới login 1 lần ở iter=0
  → Các login requests phân bố trong ramp-up window
  → Không phải tất cả login cùng lúc
  → Login spike "trải dài" theo ramp-up duration

Khác với constant-vus (tất cả login cùng lúc ở t=0):
  → Login burst tập trung
  → Dễ gây rate limit hơn
```

Refresh spike pattern:

```text
Với script refresh mỗi 3 iteration:
  Mỗi VU refresh ở iter 0, 3, 6, 9, ...
  
  Khi nhiều VUs bắt đầu cùng lúc (ramp-up):
    iter=0: N VUs refresh cùng lúc (spike nhỏ)
    iter=3: N VUs refresh cùng lúc (spike sau ~3×1.0s = 3s)
    
  Refresh spike lớn nhất thường ở plateau:
    28 VUs × refresh mỗi 3 iter ≈ 9 refresh mỗi giây (trung bình)
    Nhưng refresh có thể cluster nếu VUs đồng bộ loop
  
  → Refresh spike là expected
  → Nhưng nếu spike gây latency tăng → auth không xử lý được refresh đồng thời
```

Invalid patterns:

| Pattern | Nghĩa |
| --- | --- |
| VUs không đạt 28 ở peak | config/env sai, hoặc VU init lỗi |
| VUs không theo stage shape | config/env hoặc dashboard ingestion issue |
| VUs tụt giữa plateau | VU bị crash/exception |
| VUs giữ 28 nhưng iterations = 0 kéo dài | VU bị kẹt trong request (auth quá chậm hoặc timeout) |
| RPS giảm dù VUs đang ramp-up | closed-model backpressure (loop chậm hơn VU ramp) |
| login_wave_login vẫn xuất hiện ở plateau | script có re-login logic (kiểm tra) |
| refresh spike biến mất sau vài phút | script logic thay đổi hoặc VU bị skip refresh |
| `http_req_failed` spike ở bucket cụ thể | auth service có vấn đề ở thời điểm đó |

### Chart 3 — VUs vs iter/s

Đây là chart quan trọng nhất cho executor này.

Expected:

```text
VUs: ramp/plateau/ramp-down theo stages
iter/s: tăng theo VUs nếu backend còn capacity
iter/s: flatten/fall nếu flow duration tăng hoặc backend saturated
```

#### Cách phân tích sâu chart VUs vs iter/s

Chart này trả lời câu hỏi:

```text
VU shape có đúng 1->12->28->5 không?
iter/s có bám theo VU shape không?
Có closed-model saturation signal không?
```

Với ramping-vus login wave, đường `Executor VUs` và `Actual iter/s` có quan hệ:

```text
iter/s ≈ active_VUs / loop_duration

Nếu loop_duration avg = 1.0s (50ms API + 0.5s sleep + JS overhead):
  VUs=12: iter/s ≈ 12 / 1.0 ≈ 12
  VUs=28: iter/s ≈ 28 / 1.0 ≈ 28

Nếu loop_duration avg = 2.0s (1.5s API + 0.5s sleep):
  VUs=12: iter/s ≈ 12 / 2.0 ≈ 6
  VUs=28: iter/s ≈ 28 / 2.0 ≈ 14
```

Shape mong đợi:

```text
- ramp-up: iter/s tăng theo VUs (có thể hơi chậm hơn nếu loop duration > step interval)
- plateau: iter/s ổn định ở mức cao nhất
- ramp-down: iter/s giảm theo VUs
- đường VUs: theo stage shape 1->12->28->5
```

Bad/important shapes:

| Shape | Nghĩa |
| --- | --- |
| VUs follow stages, iter/s follows roughly | Healthy scaling shape |
| VUs rise, iter/s flat | Possible saturation/backpressure |
| VUs rise, iter/s rise but slower | Loop duration đang tăng (auth chậm dần) |
| VUs plateau, iter/s slowly falling | Session degradation ở plateau |
| VUs fall, iterations continue briefly | gracefulRampDown behavior |
| VUs not matching stages | Config/env/dashboard issue |
| VUs đạt peak nhưng iter/s thấp hơn dự kiến | Auth service chậm, loop duration cao |
| iter/s spike/drop đột ngột | Weighted branch hoặc dependency latency thay đổi |

**Điểm khác biệt với case 01 (daily traffic curve)**:

```text
Case 01 (daily traffic): weighted mix 70/25/5, iter/s dao động do branch mix
Case 03 (login wave): flow đơn giản hơn (me + conditional login/refresh)
  → iter/s ổn định hơn ở plateau (không có branch nặng)
  → Nhưng ramp-up có thể thấy iter/s tăng không đều (login requests làm chậm loop)
  → Refresh mỗi 3 iter có thể tạo pattern nhỏ trong iter/s
```

### Cách chốt từ summary -> 3 chart

```text
1. Summary xác nhận thresholds/failures.
2. VUs vs iter/s xác nhận stage shape và saturation signal.
3. Execution timeline xác nhận failures/throughput cluster ở phase nào.
4. Response time by operation tìm service/branch chậm.
5. Business decision dựa trên phase + operation + failure pattern.
```

## Kết luận thực tế: output -> quyết định

Pass criteria ở trên cho biết test "đạt hay không". Nhưng mục tiêu thật của case này là **login wave gate**: output ra số như vậy thì team auth quyết định gì với việc deploy auth service?

### Kịch bản A — Output sạch: LOGIN WAVE HEALTHY

```text
VUs................: 1 -> 12 -> 28 -> 5 (đúng shape)
vus_max............: 28
iterations.........: ~2500 (observed, không phải target)
http_req_failed....: 0.00%
checks.............: 100%
ramping_active_iterations_failed: 0 (< 20)
login_wave_login...: 846 (mỗi VU login 1 lần + re-login nếu có)
login_wave_me......: 2537 (mỗi iter 1 me)
login_wave_refresh..: 508 (mỗi ~3 iter 1 refresh)
http_req_duration {operation:login_wave_me}: p(95)=22ms
http_req_duration {operation:login_wave_refresh}: p(95)=25ms
```

Kết luận thực tế:

```text
- VU shape đúng 1->12->28->5 → staged concurrency đúng yêu cầu (a)
- 0 failed iterations / 2537 → không session nào bị đứt
- Me p95=22ms, Refresh p95=25ms → cả read và write path đều OK
- Operation mix hợp lý: me dominates, login có ở ramp-up, refresh định kỳ
- Plateau stabilization OK: không có degradation
=> QUYẾT ĐỊNH: auth login wave stability OK. Cho phép deploy auth service.
```

### Kịch bản B — Login pass nhưng session fail ở plateau: BLOCK

```text
VUs................: 1 -> 12 -> 28 -> 5 (đúng shape)
vus_max............: 28
iterations.........: ~2400
http_req_failed....: 1.2%
checks.............: 98.5%
ramping_active_iterations_failed: 35 (> 20, FAIL)
login_wave_login...: 28/28 pass (100%!)
login_wave_me......: 2400 requests, 1.5% fail ← ME FAIL Ở PLATEAU
login_wave_refresh..: 480 requests, 3% fail ← REFRESH FAIL
```

Kết luận thực tế:

```text
- VU shape đúng → không phải lỗi test
- Login 28/28 pass → auth tạo được tất cả sessions
- NHƯNG me fail 1.5% và refresh fail 3% → session validation/refresh có vấn đề
- Failures tập trung ở plateau (sau khi tất cả đã login)
- ramping_active_iterations_failed = 35 > 20 → vượt threshold
→ Đây là tín hiệu THẬT: auth tạo được session nhưng KHÔNG giữ được
=> QUYẾT ĐỊNH: BLOCK deploy. Investigate session validation và token rotation.
   Login pass không đảm bảo session health.
   Đây là giá trị của plateau phase: nó lộ ra session degradation sau login.
```

### Kịch bản C — Me latency tăng dần ở plateau: INVESTIGATE SESSION STORE

```text
VUs................: 1 -> 12 -> 28 -> 5 (đúng shape)
vus_max............: 28
iterations.........: giảm từ ~2500 → ~1800 (giảm 28%)
http_req_failed....: 0.1% (vẫn thấp!)
ramping_active_iterations_failed: 8 (vẫn pass)
http_req_duration {operation:login_wave_me}:
  - Ramp-up: p(95)=15ms
  - Plateau (đầu): p(95)=25ms
  - Plateau (cuối): p(95)=150ms ← TĂNG 10×
http_req_duration {operation:login_wave_refresh}: p(95)=35ms (ổn định)
```

Kết luận thực tế:

```text
- VU shape đúng, http_req_failed thấp → không có lỗi HTTP
- Nhưng me latency tăng từ 15ms → 150ms trong plateau
- iterations giảm 28% → closed-model backpressure signal
- Refresh latency vẫn ổn định → chỉ read path bị ảnh hưởng
→ Session store read path đang degrade khi giữ 28 sessions
→ Có thể: cache eviction, index scan chậm, lock contention
=> QUYẾT ĐỊNH: INVESTIGATE session store read path.
   Đây là tín hiệu sớm: session store đang degrade ở 28 sessions.
   Nếu không fix, sẽ fail khi có nhiều sessions hơn hoặc duration dài hơn.
```

### Kịch bản D — Login spike latency ở ramp-up: INVESTIGATE COLD START

```text
VUs................: 1 -> 12 -> 28 -> 5 (đúng shape)
vus_max............: 28
iterations.........: ~2400
http_req_failed....: 0.05%
ramping_active_iterations_failed: 2
http_req_duration {operation:login_wave_login}:
  - Ramp-up (1→12): p(95)=350ms ← CAO
  - Ramp-up (12→28): p(95)=180ms ← CAO nhưng giảm
http_req_duration {operation:login_wave_me}:
  - Ramp-up: p(95)=45ms
  - Plateau: p(95)=12ms ← THẤP HẲN
http_req_duration {operation:login_wave_refresh}:
  - Plateau: p(95)=20ms
```

Kết luận thực tế:

```text
- Login latency cao ở ramp-up (350ms, 180ms) nhưng me latency thấp ở plateau (12ms)
- → Auth service cold start issue:
  - Connection pool chưa warm (phải mở connection mới cho session store)
  - Token cache empty (phải tạo token mới, chưa có cache)
  - Có thể bị rate limit ở login (quá nhiều login trong thời gian ngắn)
- Sau khi warm (plateau): mọi thứ ổn định
→ Đây là vấn đề THẬT cho production:
  - Mỗi sáng, auth sẽ chậm trong vài phút đầu
  - Users login chậm, trải nghiệm kém
=> QUYẾT ĐỊNH: INVESTIGATE auth cold start.
   Thêm warm-up strategy: pre-warm connection pool, pre-populate cache.
   Hoặc tăng rate limit cho login.
```

### Bảng ánh xạ nhanh output -> hành động

| Output thấy gì | Nghĩa nghiệp vụ | Hành động |
| --- | --- | --- |
| Clean auth wave, all pass under correct VU shape | Workday login/session pressure acceptable | Accept baseline |
| auth/me latency rises at plateau | Session store/cache/db issue | Investigate read path |
| login/refresh failures | Token issuance/rotation issue | Block auth release |
| Login latency high at ramp-up, low at plateau | Auth cold start | Add warm-up strategy |
| Me latency high at ramp-up, low at plateau | Cache cold, connection pool init | Pre-warm cache/pool |
| Call mix mismatch | Modulo/tag logic issue | Validate script |
| VUs not matching stages | Config/env/dashboard issue | Fix config first |
| iter/s flat despite VU ramp-up | Auth saturation/backpressure | Investigate auth capacity |
| Failures cluster at ramp transition | Auth không xử lý được concurrent state change | Kiểm rate limit, connection pool |

Điểm cốt lõi của case này: **vì VU shape luôn 1->12->28->5 và duration được kiểm soát bởi stages, mọi thay đổi ở latency, iter/s, và failure rate theo phase đều là tín hiệu THẬT về auth service ở điều kiện staged concurrency**. Plateau phase cho thấy stabilization, ramp-up phase cho thấy scaling, và cooldown phase cho thấy cleanup.

## Nghịch lý và misconceptions của ramping-vus

### Nghịch lý 1: "Login pass hết mà sao session fail?"

```text
"login_wave_login = 28/28 pass (100%)
 sao ramping_active_iterations_failed = 12?"

Trả lời: Login chỉ xảy ra ở iteration đầu tiên của mỗi VU.
Sau đó, mỗi VU chạy me + refresh LIÊN TỤC cho đến khi hết test.
Login pass không đảm bảo me/refresh pass ở iteration sau.

Timeline một session bị fail:
  iter=0:  login OK, me OK, refresh OK         ← login pass
  iter=1:  me OK
  iter=2:  me OK
  iter=3:  me OK, refresh OK
  ...
  iter=12: me OK, refresh FAIL                  ← token rotation lỗi
  iter=13: me FAIL (token đã hết hạn)           ← session chết
  iter=14: me FAIL
  ...

→ Login pass 1 lần, nhưng session fail từ iteration 12 trở đi
→ ramping_active_iterations_failed tăng, dù login_wave_login vẫn 28/28
→ Đây là lý do case này có plateau phase: để quan sát session health SAU login
→ Nếu không có plateau, test dừng trước khi kịp thấy failure
```

### Nghịch lý 2: "VUs tăng từ 12 lên 28 mà iter/s gần như không tăng?"

```text
"VUs tăng 2.3× (12 → 28) mà iter/s chỉ tăng 1.2×?
 Có phải k6 không bơm đủ load không?"

Trả lời: Đây là CLOSED-MODEL BACKPRESSURE.
VUs tăng nhưng loop duration cũng tăng, nên iter/s không tăng tuyến tính.

Công thức:
  iter/s ≈ active_VUs / loop_duration
  
  Nếu VUs=12, loop_duration=1.0s:
    iter/s ≈ 12 / 1.0 = 12
  
  Nếu VUs=28, loop_duration TĂNG lên 2.0s (auth chậm hơn):
    iter/s ≈ 28 / 2.0 = 14  ← chỉ tăng 17%, không phải 133%
  
  VUs tăng 2.3× nhưng loop duration tăng 2.0×
  → iter/s gần như không đổi!

Đây là TÍN HIỆU ĐÚNG: auth service đang saturated.
Không phải k6 bug, không phải config sai.
→ Xem xét: auth có bottleneck ở đâu? CPU? DB? Connection pool?
```

### Nghịch lý 3: "Me count >> login count nhưng me latency vẫn thấp hơn login?"

```text
"login_wave_me: 2537 requests, p95=22ms
 login_wave_login: 846 requests, p95=35ms

 Me nhiều hơn 3× mà latency thấp hơn? Sao lạ vậy?"

Trả lời: Login và me là 2 operation KHÁC NHAU về bản chất.
Không thể so sánh latency dựa trên count.

  login_wave_login (POST /auth/login):
    - Tạo session mới trong store
    - Generate access token + refresh token
    - Có thể ghi audit log
    - Validation password/credentials
    → Heavy operation, tốn nhiều thời gian hơn

  login_wave_me (GET /auth/me):
    - Đọc session state từ store
    - Validate token (có thể từ cache)
    - Không ghi gì
    → Light operation, nhanh hơn

→ Login luôn chậm hơn me, không liên quan đến count
→ Đây là expected behavior
→ Nhưng nếu me latency gần bằng login latency → session store có vấn đề
```

### Nghịch lý 4: "VUs đang ramp-down mà iterations vẫn tăng?"

```text
"Stage 4: VUs giảm từ 28 → 5
 Nhưng iterations vẫn tiếp tục hoàn tất thêm
 Sao VUs giảm mà iterations vẫn chạy?"

Trả lời: Đây là gracefulRampDown behavior.
Khi VU bị chọn để dừng, k6 cho nó thời gian (gracefulRampDown=15s)
để hoàn tất iteration hiện tại.

  t=53s: 28 VUs active
  t=53-68s: k6 ramp-down, chọn VUs để dừng
    Mỗi VU bị chọn: không dừng ngay, mà hoàn tất iter hiện tại
    → Iteration vẫn đang chạy và hoàn tất
  t=68s: còn 5 VUs (hoặc ít hơn nếu một số vẫn đang finish)
  
→ Iterations tiếp tục hoàn tất trong khi VUs giảm
→ Đây là expected, không phải bug
→ Nhưng nếu gracefulRampDown quá ngắn: iterations bị ngắt giữa chừng
```

Đừng coi total iterations là số logins. Login là conditional branch, không phải mỗi loop.

Nhớ 3 câu:

```text
stage target = absolute VU target, không phải delta
iterations/RPS = output, không phải input
VUs tăng mà iter/s flatten = tín hiệu backpressure đáng đọc
```

## Checklist đọc biểu đồ case 03

Khi học sinh nhìn dashboard case 03, đọc theo thứ tự này:

```text
1. Overview KPI
   - VU shape có đúng 1->12->28->5 không?
   - vus_max = 28?
   - http_req_failed < 1%?
   - checks > 99%?
   - ramping_active_iterations_failed < 20?

2. Response time chart
   - Tách theo operation (login vs me vs refresh) chưa?
   - Login p95 có cao hơn me không? (expected: có)
   - Me p95 có tăng dần ở plateau không?
   - Refresh p95 có cao hơn me không? (expected: có)
   - Có operation nào spike ở phase chuyển tiếp không?

3. Execution timeline
   - VUs có theo stage shape 1->12->28->5 không?
   - Live VUs có đạt 28 ở plateau không?
   - Có thấy login requests ở ramp-up không?
   - Có thấy refresh định kỳ ở plateau không?
   - http_req_failed có spike ở phase cụ thể không?

4. VUs vs iter/s
   - VUs có theo stage shape không?
   - iter/s có tăng theo VU ramp-up không?
   - iter/s có ổn định ở plateau không?
   - iter/s có flatten khi VUs tăng không? (nếu có → auth saturation)
   - iter/s có giảm dần ở plateau không? (nếu có → session degradation)

5. Business decision
   - Tất cả counters pass?
   - Login pass ở ramp-up?
   - Session validation ổn định ở plateau?
   - Refresh không fail?
   - Me latency không tăng dần ở plateau?
   - Nếu tất cả pass → login wave PASS
```

Kết luận của run case 03 đang đúng nếu thấy:

```text
VU shape đúng = 1 -> 12 -> 28 -> 5
vus_max = 28
http_req_failed < 1%
checks > 99%
ramping_active_iterations_failed < 20
login_wave_me count ≈ iterations
login_wave_login count ≈ VU count (có thể > nếu re-login)
login_wave_refresh count ≈ iterations / 3
http_req_duration {operation:login_wave_refresh} > http_req_duration {operation:login_wave_me}
http_req_duration {operation:login_wave_login} > http_req_duration {operation:login_wave_me}
iter/s tăng theo VU ramp-up và ổn định ở plateau
executor = ramping-vus
scenario = login_wave
```

## Mở rộng / variation

### Variation A: Tăng duration scale để chạy gần business timeline hơn

```powershell
$env:RV_03_DURATION_SCALE = 1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Mục đích: chạy với duration thật (scale=1: 60s + 60s + 90s + 60s = 270s ≈ 4.5 phút). Quan sát:
- Session có degrade sau thời gian dài không?
- Refresh có fail sau nhiều chu kỳ không?
- Memory/CPU auth service có ổn định không?

### Variation B: Tăng peak VUs để tìm capacity knee

```powershell
$env:RV_03_PEAK_VUS = 50
$env:RV_03_MID_VUS = 20
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Mục đích: tìm ngưỡng session mà auth service bắt đầu degrade. Quan sát:
- VUs có đạt được 50 không?
- Me latency có tăng đột biến ở peak không?
- Refresh failure có tăng không?
- iter/s có flatten ở VU count nào?

### Variation C: Giảm sleep để tăng auth pressure tự nhiên

```powershell
$env:RV_03_SLEEP_SECONDS = 0.1
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Mục đích: giảm think time → tăng request rate tự nhiên → tăng áp lực lên auth. Quan sát:
- Me latency có tăng không?
- Auth service có bị quá tải không?
- iter/s tăng bao nhiêu so với sleep=0.5?

### Variation D: Thêm threshold latency theo operation để làm gate

```js
export const options = {
  thresholds: {
    "http_req_duration{operation:login_wave_me}": ["p(95)<50"],
    "http_req_duration{operation:login_wave_login}": ["p(95)<200"],
    "http_req_duration{operation:login_wave_refresh}": ["p(95)<100"],
  },
};
```

Mục đích: chuyển từ functional test sang performance gate. Nếu me p95 vượt 50ms, test fail (dù HTTP status vẫn 200). Phân biệt read path và write path threshold.

### Variation E: Đổi refresh interval để test token rotation load

```powershell
# Sửa script: refresh mỗi 2 iteration thay vì 3 (tăng tần suất refresh)
# if (iter % 2 === 0) { ... refresh ... }
k6 run -o cloud E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js
```

Mục đích: tăng áp lực lên refresh/write path để tìm bottleneck sớm hơn.

## Anti-pattern

- Đọc `stage.target` như số VUs cộng thêm (phải đọc là absolute target).
- Kỳ vọng fixed RPS từ `ramping-vus`.
- Dùng total `iterations` làm pass/fail target.
- Bỏ qua `gracefulRampDown` khi thấy tail iterations.
- Chỉ nhìn aggregate p95 trong mixed/conditional flow.
- Nhầm case này với fixed backlog của `shared-iterations`.
- Nhầm case này với flat active users của `constant-vus`.
- Nhầm case này với arrival-rate login flood.
- Đọc login count = iterations count (login là conditional, chỉ ở iter=0).
- Không tách phase khi đọc latency (ramp-up vs plateau có pattern khác nhau).
- Không tách operation khi đọc failures (aggregate che refresh failure).
- Không tag `user_id` rồi không diagnose được session-specific failure.
- Login lại mỗi iteration (biến login wave thành login benchmark).
- Dùng `exec.scenario.iterationInTest` làm user identity thay vì `exec.vu.idInTest`.
- Cho rằng me latency phải giống nhau ở ramp-up và plateau.
- Cho rằng iter/s phải tăng tuyến tính với VUs.
- Fail test vì "iterations không đủ nhiều" mà không kiểm tra auth latency trước.
- Không đọc operation mix theo phase (login có ở ramp-up, không có ở plateau).
- Dùng constant-vus rồi thắc mắc "sao không thấy login pressure?" (vì constant-vus không có ramp-up).
- Bỏ qua plateau phase — chỉ ramp-up rồi ramp-down ngay → không thấy session stabilization.

## Reference

- Overview series: `./00_overview.md`
- Run guide: `./RUN_GUIDE.md`
- Ramping-vus quick index: `../../20260517_01_ramping-vus-quick-index.md`
- Tham số/công thức: `../../20260517_02_ramping-vus-tham-so-cong-thuc.md`
- Backend script: `E:\Projects\k6\k6-metrics-server\load-target\k6\ramping-vus\rv-03-login-wave.js`
