# Analysis Log

**Rules**
1. Append-only: always add new entries at the end; do not rewrite past entries.
2. Use a timestamp header in ISO format: `YYYY-MM-DD HH:MM` (local time).
3. Each entry must include these fields: Context, Findings, Evidence, Decision, Next.
4. Evidence should reference code locations using file paths (and line numbers if known).
5. Keep entries concise (ideally 5-12 lines per entry).

**Entry Template**
```markdown
### YYYY-MM-DD HH:MM
- Context:
- Findings:
- Evidence:
- Decision:
- Next:
```

### 2026-02-26 17:13
- Context: Confirm default executor and per-vu-iterations option defaults used in JS.
- Findings: No execution options → scenario "default" uses executor per-vu-iterations; defaults VUs=1, Iterations=1, MaxDuration=10m; BaseConfig defaults gracefulStop=30s and exposes startTime/env/exec/tags/options.
- Evidence: `lib/executor/execution_config_shortcuts.go:99-119`, `lib/executor/per_vu_iterations.go:29-44,63-67`, `lib/executor/base_config.go:26-46`.
- Decision: Treat per-vu-iterations as default when no execution options; map its fields to JS scenario config.
- Next: Provide a JS snippet to print effective scenario values if needed.

### 2026-02-26 17:15
- Context: Explain what an iteration is relative to VUs in Go code.
- Findings: An iteration = one `ActiveVU.RunOnce()` call; VU runs iterations sequentially, while executors decide distribution (per-VU loop, shared counter, or time-bounded loop).
- Evidence: `lib/runner.go:11-16`, `internal/js/runner.go:824-900`, `lib/executor/helpers.go:72-112`, `lib/executor/per_vu_iterations.go:203-230`, `lib/executor/shared_iterations.go:254-260`, `lib/executor/constant_vus.go:185-192`.
- Decision: Describe iteration as VU-level unit of work; concurrency comes from multiple VUs.
- Next: Provide concrete example mapping executor type to iteration behavior if asked.

### 2026-02-26 17:21
- Context: Determine when VUs are initialized in Go code.
- Findings: Planned VUs are initialized during scheduler Init phase (before executor Init) via initVUsConcurrently → initVU → Runner.NewVU → AddInitializedVU; unplanned VUs can be created during run via ExecutionState.GetUnplannedVU/InitializeNewVU using initVUFunc set after Init.
- Evidence: `internal/execution/scheduler.go:124-176,252-309,378-413`, `lib/execution.go:491-533`.
- Decision: Describe initialization timing as Init phase for planned VUs, runtime for unplanned (arrival-rate/external) executors.
- Next: Mention temporary setup/teardown VUs if user asks about counts.

### 2026-02-26 17:23
- Context: Explain when planned VUs are created and how to observe them in a test run.
- Findings: Scheduler Init computes needed planned VUs from execution plan and initializes them before executors run; debug log includes field `neededVUs` at init start.
- Evidence: `internal/execution/scheduler.go:252-299`.
- Decision: Recommend using `--log-level debug` to see `neededVUs` and compare with scenario config (e.g., vus/preAllocatedVUs).
- Next: Provide example scripts showing planned vs max possible VUs if asked.

### 2026-02-26 17:25
- Context: Demonstrate planned VUs initialization in a real run.
- Findings: Verbose run shows `neededVUs=2` and VU #1/#2 initialized before executor start.
- Evidence: runtime log from `./k6 run -v planned-vus-demo.js`; script at `planned-vus-demo.js`.
- Decision: Use `-v` for verbose logs since `--log-level` flag is unsupported in this binary.
- Next: If needed, demo arrival-rate executor to show unplanned VUs.

### 2026-02-26 17:39
- Context: Check whether other executors include gracefulStop in max duration display.
- Findings: Most executors add GracefulStop to their execution plan end offset (per-vu/shared iterations, constant-vus, constant/ramping-arrival-rate, ramping-vus); externally-controlled forbids gracefulStop and uses Duration only (or infinite if 0).
- Evidence: `lib/executor/shared_iterations.go:98-123`, `lib/executor/constant_vus.go:82-97`, `lib/executor/constant_arrival_rate.go:127-143`, `lib/executor/ramping_arrival_rate.go:116-133`, `lib/executor/ramping_vus.go:422-452`, `lib/executor/externally_controlled.go:95-103,123-139`.
- Decision: Answer that “max duration (incl. graceful stop)” generally includes gracefulStop except externally-controlled.
- Next: None.

### 2026-02-26 18:00
- Context: Clarify VU iteration concurrency across executors.
- Findings: All executors run iterations sequentially within a single VU (RunOnce per VU is serialized); parallelism comes from multiple VUs (and overlapping scenarios) running in separate goroutines.
- Evidence: `internal/js/runner.go:824-834` (busy channel), `lib/executor/per_vu_iterations.go:203-230` (per-VU loop), `lib/executor/shared_iterations.go:239-262` (per-VU loop), `lib/executor/constant_vus.go:178-192` (per-VU loop).
- Decision: State that no executor runs multiple iterations concurrently inside one VU.
- Next: None.

### 2026-02-27 20:39
- Context: Clarify shared-iterations distribution and meaning of iterInTest.
- Findings: shared-iterations uses a global atomic counter to allocate iterations to whichever VU runs next (no fairness); `iterInTest` is the scenario-wide iteration counter, not HTTP request count.
- Evidence: `lib/executor/shared_iterations.go:239-261` (atomic counter), `lib/executor/base_executor.go:45-50` + `internal/js/runner.go:1005-1017` (iteration counters), `internal/js/modules/k6/execution/execution.go:111-124` (iterInTest accessor).
- Decision: Explain that iterInTest increments per iteration and only equals request count if user makes exactly one request per iteration.
- Next: None.

### 2026-02-27 20:44
- Context: Inspect `constant-vus` executor behavior from Go code.
- Findings: `constant-vus` keeps a fixed number of planned VUs looping as fast as possible for `duration`; no fixed iteration count. New iterations stop at regular duration, while in-flight iterations may finish during `gracefulStop`; after that, context interrupts remaining work.
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:82`, `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:125`, `/home/autoneko1/Downloads/k6/lib/executor/helpers.go:116`.
- Decision: Use this executor for time-based load with fixed VU concurrency; use `per-vu-iterations` or `shared-iterations` for iteration-targeted runs.
- Next: None.

### 2026-02-27 20:49
- Context: Run a concrete `constant-vus` script to observe runtime behavior.
- Findings: With `vus=2`, `duration=3s`, `sleep(0.6)`, both VUs loop concurrently and each VU iter counter (`__ITER`) increases sequentially; total 10 iterations completed in ~3s with no interruption.
- Evidence: `/home/autoneko1/Downloads/k6/constant-vus-demo.js`, runtime output from `./k6 run constant-vus-demo.js`.
- Decision: Keep this demo script as a baseline to compare against shared/per-vu executors.
- Next: None.

### 2026-02-27 20:53
- Context: Inspect `constant-arrival-rate` executor flow and behavior in Go.
- Findings: Iterations are scheduled by time (`rate`/`timeUnit`) and dispatched via a VU pool; if no free VU, iteration is dropped, and executor may initialize unplanned VUs up to `maxVUs`.
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:127`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:195`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:332`, `/home/autoneko1/Downloads/k6/lib/executor/ramping_arrival_rate.go:500`.
- Decision: Treat this executor as rate-targeted (throughput by schedule), not per-VU or total-iterations targeted.
- Next: If needed, run a demo script with low `preAllocatedVUs` to show dropped iterations and warning.

### 2026-02-27 21:00
- Context: Identify which executors support `preAllocatedVUs`.
- Findings: `preAllocatedVUs` exists only in arrival-rate executors: `constant-arrival-rate` and `ramping-arrival-rate` (paired with `maxVUs`).
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:44`, `/home/autoneko1/Downloads/k6/lib/executor/ramping_arrival_rate.go:44`, search over `/home/autoneko1/Downloads/k6/lib/executor` for `preAllocatedVUs`.
- Decision: Treat `preAllocatedVUs` as arrival-rate specific option.
- Next: None.

### 2026-02-27 21:16
- Context: Demonstrate logs when `preAllocatedVUs`/`maxVUs` are insufficient for constant-arrival-rate target.
- Findings: With `rate=10/s`, `duration=3s`, `preAllocatedVUs=maxVUs=2`, and `sleep(1)`, runtime logs warn `Insufficient VUs...`; summary shows high `dropped_iterations` and low completed iterations.
- Evidence: `/home/autoneko1/Downloads/k6/constant-arrival-not-enough-vus.js`, output from `./k6 run -v constant-arrival-not-enough-vus.js`.
- Decision: Use this script as baseline to verify VU starvation and dropped iterations behavior.
- Next: None.

### 2026-02-27 22:23
- Context: Consolidate all practical formulas discussed for VU/iteration behavior and executor sizing.
- Findings: Common formulas: , iterations are sequential per VU and parallel only across VUs. : . :  and each VU claims work via shared atomic counter (distribution not guaranteed fair). : fixed concurrency , approximate completed iterations  where  is avg iteration duration. :  (iters/s), required VUs , capacity with  VUs , drop rate , dropped total ; scheduled slots are approximately , and runtime accounting is .
- Evidence: , , , , , , , .
- Decision: Use these formulas as sizing heuristics; validate with real run metrics (, , , , ) because scheduler timing and app latency variance affect results.
- Next: None.

### 2026-02-27 22:23
- Context: Correct and consolidate formula notes for VU/iteration sizing (supersedes malformed entry at 2026-02-27 22:23).
- Findings: Core: `1 iteration = 1 RunOnce()`, iterations are sequential per VU and parallel only across VUs. `per-vu-iterations`: `total_iters = vus * iterations`. `shared-iterations`: `total_iters_target = iterations`; each VU claims work via shared counter, so per-VU share is non-deterministic. `constant-vus`: fixed concurrency `active_vus = vus`, rough completed iterations `iters_approx ~= vus * duration / W` (`W` = avg iteration time). `constant-arrival-rate`: `lambda = rate / timeUnit` (iters/s), required VUs `N_req ~= lambda * W`, capacity with `M` VUs `mu ~= M / W`, drop rate `drop_rate ~= max(0, lambda - mu)`, dropped total `dropped ~= drop_rate * duration`, and practical accounting `scheduled ~= complete + interrupted + dropped`.
- Evidence: `/home/autoneko1/Downloads/k6/lib/runner.go:11`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:824`, `/home/autoneko1/Downloads/k6/lib/executor/per_vu_iterations.go:153`, `/home/autoneko1/Downloads/k6/lib/executor/shared_iterations.go:254`, `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:125`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:201`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:332`, `/home/autoneko1/Downloads/k6/lib/executor/base_executor.go:45`.
- Decision: Use formulas as planning heuristics; confirm with runtime metrics `iteration_duration`, `iterations`, `dropped_iterations`, `vus`, `vus_max`.
- Next: None.

### 2026-02-27 22:39
- Context: Clarify `tickerPeriod` and why completed iterations/s can be lower than theoretical capacity in constant-arrival-rate.
- Findings: `tickerPeriod = timeUnit / rate` and each tick is one scheduled start slot. In short tests with `gracefulStop=0s`, some started iterations end as interrupted, so `iterations` (completed) can be below steady-state `maxVUs / W`. Practical accounting per run: `scheduled ~= complete + interrupted + dropped`.
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:202`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:327`, `/home/autoneko1/Downloads/k6/lib/executor/helpers.go:141`, `/home/autoneko1/Downloads/k6/lib/executor/helpers.go:177`.
- Decision: Use `tickerPeriod` to reason about scheduled attempts, and use `iterations + interrupted + dropped` to validate slot accounting.
- Next: None.

### 2026-02-27 23:25
- Context: Document impact of `sleep()` on throughput and VU sufficiency.
- Findings: `sleep()` increases average iteration time `W`, reducing effective capacity. For arrival-rate executors, capacity `mu ~= M/W` (`M` active/max VUs); if target `lambda = rate/timeUnit` exceeds `mu`, dropped iterations and `Insufficient VUs` warnings appear. For constant-vus, no drop scheduling exists, but completed iterations decrease as `W` increases.
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:202`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:332`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:352`, `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:185`.
- Decision: Include `sleep()` (and app latency) in VU sizing; use safety margin above `rate*W` for arrival-rate tests.
- Next: None.

### 2026-02-27 23:31
- Context: Clarify meaning of `W` in throughput formulas.
- Findings: `W` is total average iteration time of the executed function (`exec`/`default`), including `sleep`, network latency, JS processing, checks, parsing, and any waiting inside one iteration; not `sleep` alone.
- Evidence: `/home/autoneko1/Downloads/k6/internal/js/runner.go:824`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:874`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:888`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:980`.
- Decision: When tuning arrival-rate, optimize full iteration path and size VUs against measured `iteration_duration`.
- Next: None.

### 2026-02-27 23:54
- Context: Verify scenarios can run in parallel with a concrete script.
- Findings: Two scenarios (`sc1`, `sc2`) with `startTime=0`, each `constant-vus` (`vus=1`, `duration=3s`) produced same-millisecond timestamps per step, showing concurrent execution; with `gracefulStop=1s`, both completed 3 iterations each (total `iterations=6`).
- Evidence: `/home/autoneko1/Downloads/k6/scenario-parallel-check.js`, output from `./k6 run -q scenario-parallel-check.js`.
- Decision: Keep this script for future parallel-scenario sanity checks.
- Next: None.

### 2026-02-28 00:16
- Context: Clarify the statement "workload depends on VU iteration completion time" for closed model (`constant-vus`).
- Findings: In `constant-vus`, each VU starts a new iteration only after the previous one finishes. Therefore throughput changes with iteration duration `W`: slower iterations reduce load, faster iterations increase load.
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:123`, `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:185`, `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:191`.
- Decision: Treat `constant-vus` as closed-loop load generation; use arrival-rate executors when fixed start rate is required.
- Next: None.

### 2026-02-28 00:21
- Context: Classify executors into closed vs open model based on Go implementation.
- Findings: Closed model executors: `constant-vus`, `ramping-vus`, `per-vu-iterations`, `shared-iterations`, `externally-controlled` (VU-loop driven). Open model executors: `constant-arrival-rate`, `ramping-arrival-rate` (time-scheduled arrival with potential drops).
- Evidence: `/home/autoneko1/Downloads/k6/lib/executor/constant_vus.go:123`, `/home/autoneko1/Downloads/k6/lib/executor/ramping_vus.go:495`, `/home/autoneko1/Downloads/k6/lib/executor/per_vu_iterations.go:132`, `/home/autoneko1/Downloads/k6/lib/executor/shared_iterations.go:163`, `/home/autoneko1/Downloads/k6/lib/executor/externally_controlled.go:344`, `/home/autoneko1/Downloads/k6/lib/executor/constant_arrival_rate.go:327`, `/home/autoneko1/Downloads/k6/lib/executor/ramping_arrival_rate.go:500`.
- Decision: Use arrival-rate executors for fixed start-rate goals; use closed-model executors when load should naturally depend on iteration completion.
- Next: None.

### 2026-02-28 00:26
- Context: Explain where thresholds are defined and evaluated in Go code.
- Findings: User-facing thresholds are declared in options as `map[string]metrics.Thresholds`. Core implementation is in `metrics/thresholds.go` (`Threshold`, `Thresholds`, parsing/validation/run). Expressions are parsed by `metrics/thresholds_parser.go` (BNF-like grammar and supported operators/aggregation methods). Metric-type compatibility is enforced via `metrics/metric_type.go` (`supportedAggregationMethods`). Runtime wiring is in `internal/metrics/engine/engine.go` (init, periodic evaluation, abort-on-fail), and enabled/disabled in `internal/cmd/run.go` via runtime option `--no-thresholds` from `internal/cmd/runtime_options.go`.
- Evidence: `/home/autoneko1/Downloads/k6/lib/options.go:288`, `/home/autoneko1/Downloads/k6/metrics/thresholds.go:17`, `/home/autoneko1/Downloads/k6/metrics/thresholds.go:170`, `/home/autoneko1/Downloads/k6/metrics/thresholds_parser.go:52`, `/home/autoneko1/Downloads/k6/metrics/metric_type.go:90`, `/home/autoneko1/Downloads/k6/internal/metrics/engine/engine.go:118`, `/home/autoneko1/Downloads/k6/internal/metrics/engine/engine.go:216`, `/home/autoneko1/Downloads/k6/internal/cmd/run.go:187`, `/home/autoneko1/Downloads/k6/internal/cmd/runtime_options.go:33`.
- Decision: Answer with code-level flow: define in options -> parse/validate -> evaluate periodically/finally -> mark tainted/abort or fail exit code.
- Next: If needed, add a tiny JS threshold script and map each JS field to Go structs (`thresholdConfig`).

### 2026-02-28 00:51
- Context: Clarify meaning of VM and temporary VU (`__VU=0`) in lifecycle logs.
- Findings: In k6, a VU wraps a JS VM/runtime (`sobek.Runtime`) plus execution state. `__VU=0` is an internal/transient VU used for init and non-load lifecycle functions, so init logs can appear more than planned load VUs. It is created for: (1) bundle warmup/init when loading script and exports/options, (2) `setup()`/`teardown()` via `runPart()`, and (3) `handleSummary()`. Planned load VUs are `__VU>=1` and run scenario iterations.
- Evidence: `/home/autoneko1/Downloads/k6/internal/js/bundle.go:114`, `/home/autoneko1/Downloads/k6/internal/js/bundle.go:126`, `/home/autoneko1/Downloads/k6/internal/js/bundle.go:260`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:291`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:340`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:374`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:634`.
- Decision: When reading init logs, separate internal `__VU=0` from scenario VUs; count load VUs using `__VU>=1` or scheduler debug lines `Initialized VU #...`.
- Next: If needed, add a compact lifecycle table mapping each stage to the exact Go entrypoint.

### 2026-02-28 10:37
- Context: Explain why `[INIT] __VU=0` appears after `default` and after `teardown` in lifecycle logs.
- Findings: Extra `INIT` lines are from newly created transient internal VUs (`__VU=0`), not from re-running iterations on planned scenario VUs. Typical sequence: warmup/init VM (`__VU=0`) -> planned VUs (`__VU>=1`) -> transient `__VU=0` for `setup()` -> scenario `default` iterations -> transient `__VU=0` for `teardown()` -> transient `__VU=0` for summary/`handleSummary` path.
- Evidence: `/home/autoneko1/Downloads/k6/internal/js/bundle.go:114`, `/home/autoneko1/Downloads/k6/internal/js/bundle.go:126`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:291`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:340`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:374`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:634`.
- Decision: Treat `INIT __VU=0` as lifecycle-internal runtime initialization events; use `__VU>=1` to reason about load VUs and executor behavior.
- Next: If needed, create a one-page lifecycle diagram (stage -> Go function -> expected log pattern).

### 2026-02-28 10:49
- Context: Clarify default setup timeout in k6.
- Findings: `setupTimeout` default is 60 seconds (1 minute) when not explicitly set. `setup()` is executed under this timeout; if exceeded, run fails with setup-timeout exit path.
- Evidence: `/home/autoneko1/Downloads/k6/internal/cmd/config.go:315`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:288`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:690`, `/home/autoneko1/Downloads/k6/internal/js/timeout_error.go:57`.
- Decision: Use explicit `options.setupTimeout` (or `K6_SETUP_TIMEOUT`) for long provisioning setup.
- Next: If needed, add a tiny timeout demo script showing setup timeout behavior.

### 2026-02-28 10:59
- Context: Identify which Go HTTP library k6 uses for `import http from 'k6/http'` requests.
- Findings: k6 ultimately sends HTTP via Go standard library `net/http` (`http.Client` + `http.Transport`). The JS module `k6/http` maps to Go module `go.k6.io/k6/js/modules/k6/http`, which calls `httpext.MakeRequest`; that function builds `http.Client{Transport: ...}` and executes `client.Do(...)`. k6 wraps transport for tracing/metrics/debug but underlying network call is still stdlib `net/http`.
- Evidence: `/home/autoneko1/Downloads/k6/internal/js/jsmodules.go:43`, `/home/autoneko1/Downloads/k6/js/modules/resolution.go:151`, `/home/autoneko1/Downloads/k6/js/modules/k6/http/request.go:51`, `/home/autoneko1/Downloads/k6/lib/netext/httpext/request.go:238`, `/home/autoneko1/Downloads/k6/lib/netext/httpext/request.go:271`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:197`, `/home/autoneko1/Downloads/k6/internal/js/runner.go:210`.
- Decision: When analyzing HTTP behavior/perf, inspect both stdlib transport settings and `lib/netext/httpext` wrappers.
- Next: If needed, map each JS API (`get`, `batch`, `asyncRequest`) to exact Go entrypoints.

### 2026-02-28 11:22
- Context: Split `http params.tags` analysis into two streams (code path + runtime behavior).
- Findings: Stream A (code): request-level `tags` are parsed in HTTP params and merged into a cloned `TagsAndMeta` for that request, then emitted in HTTP metric samples. Stream B (runtime): even with DNS-blocked requests, submetrics by custom tags still aggregate correctly (`{name:...}`, `{custom:...}`); system `method` remains `GET` even if user sets `tags.method`, and setting `name` makes `url` use the same value.
- Evidence: `/home/autoneko1/Downloads/k6/js/modules/k6/http/request.go:172`, `/home/autoneko1/Downloads/k6/js/modules/k6/http/request.go:366`, `/home/autoneko1/Downloads/k6/js/common/tags.go:15`, `/home/autoneko1/Downloads/k6/lib/netext/httpext/transport.go:87`, `/home/autoneko1/Downloads/k6/lib/netext/httpext/transport.go:103`, `/home/autoneko1/Downloads/k6/lib/netext/httpext/tracer.go:44`, runtime scripts `/home/autoneko1/Downloads/k6/tags-2-luong-demo.js`, `/home/autoneko1/Downloads/k6/tags-override-check.js`.
- Decision: Recommend using `tags.name` as stable business label for dynamic URLs and using submetric thresholds on `http_reqs{...}` / `http_req_duration{...}`.
- Next: If needed, add one script that compares per-request tags vs `exec.vu.tags` persistence across iterations.

### 2026-05-16 00:16
- Context: Continue executor lessons with `constant-vus` using local core code and runnable demos.
- Findings: `constant-vus` pre-reserves `vus` planned VUs, starts one load goroutine per VU, and each VU loops `RunOnce()` until regular `duration` ends. In-flight iterations can finish during `gracefulStop`; after `duration + gracefulStop`, unfinished iterations are interrupted. There is no normal `dropped_iterations` path because this executor has no target iteration quota or scheduled arrival slots.
- Evidence: `lib/executor/constant_vus.go:36-97,125-206`, `lib/executor/helpers.go:72-141`, `lib/executor/execution_config_shortcuts.go:21-94`, demo runs from `examples/constant_vus_loop_demo.js`, `examples/constant_vus_interrupt_demo.js`, and `examples/constant_vus_quickpizza_two_requests_demo.js`.
- Decision: Document `constant-vus` as closed-model, time-based fixed-concurrency executor; use `iteration_duration` to estimate iteration throughput and use arrival-rate executors later for fixed start-rate goals.
- Next: Continue with `ramping-vus` or `constant-arrival-rate` depending on the next lesson.

### 2026-05-16 00:34
- Context: Expand `constant-vus` notes to match the structure and depth of `per-vu-iterations` and `shared-iterations`.
- Findings: Added a parameter/formula doc, quick index, QuickPizza worked example, and a fast/slow VU count demo. Key formulas: `executor_wall_time_after_start = duration + gracefulStop`, `scenario_end_from_test_start = startTime + duration + gracefulStop`, `per_vu_rate_i = 1 / t_i`, `peak_iteration_rate_if_all_vus_active = sum(1/t_i)`, `average_iteration_rate = completed_iterations / actual_runtime`, and `actual_runtime = counter_count / counter_rate`.
- Evidence: `docs/20260516_constant-vus-tham-so-cong-thuc.md`, `docs/20260516_constant-vus-quick-index.md`, `docs/20260516_constant_vus_quickpizza_two_requests_worked_example.md`, `examples/constant_vus_vu_speed_count_demo.js`, run output from `rtk k6 run .\examples\constant_vus_vu_speed_count_demo.js`.
- Decision: Keep the older `docs/20260115_constant-vus-executor.md` as core-flow notes and point it to the newer formula/example docs.
- Next: Use the same doc pattern for the next executor.

### 2026-05-16 00:52
- Context: Review whether all important `constant-vus` formulas and core-code caveats were captured.
- Findings: Added the missing core caveats: `startTime` is added by `ScenarioConfigs.GetFullExecutionRequirements()` and waited by scheduler before `Run()`, `effective_vus` can be scaled by `ExecutionTuple.ScaleInt64()`, `vus`/`vus_max` are scheduler-emitted Gauge samples from active/initialized counters, `BaseConfig` supplies `exec/env/tags/options`, and `iterations` counts only completed iterations while interrupted iterations are tracked separately.
- Evidence: `lib/executor/constant_vus.go:54-98,125-202`, `lib/executor/base_config.go:27-45,85-123`, `lib/executor/helpers.go:77-152,224-238`, `lib/executors.go:249-260`, `internal/execution/scheduler.go:199-224,329-363`, `lib/execution.go:462-481,544-550`, `internal/js/runner.go:885-899,977-998`.
- Decision: Treat `docs/20260516_constant-vus-tham-so-cong-thuc.md` section `3.9` as the review checklist for core-derived notes.
- Next: If more precision is needed, add a `startTime` demo scenario.

### 2026-05-16 10:42
- Context: Check what happens when users add fields from another executor into an explicit `scenarios` config.
- Findings: Explicit scenario config parsing is strict. `constant-vus` with `iterations` errors with `json: unknown field "iterations"`; `constant-vus` with `maxDuration` errors with `json: unknown field "maxDuration"`; `per-vu-iterations` or `shared-iterations` with `duration` error with `json: unknown field "duration"`. Top-level shortcut `{ vus, iterations, duration }` is different: it derives to `shared-iterations` and maps `duration` to `maxDuration`.
- Evidence: `lib/helpers.go:13-16`, `lib/executor/constant_vus.go:36-40`, `lib/executor/per_vu_iterations.go:30-35`, `lib/executor/shared_iterations.go:33-38`, `lib/executor/execution_config_shortcuts.go:54-94`, stdin `rtk k6 run -` checks.
- Decision: Document executor-specific valid fields and warn that explicit scenario configs reject unknown fields.
- Next: None.

### 2026-05-17 00:27
- Context: Continue executor lessons with `ramping-vus` using local core code and runnable demos.
- Findings: `ramping-vus` is a closed-model, time-based variable-concurrency executor. Core computes `rawSteps` for scheduled active VUs and `gracefulSteps` for reserved VUs during ramp-down. `gracefulRampDown` applies when scaling down inside the timeline, while `gracefulStop` caps the tail at `sum(stages)+gracefulStop`. There is no normal `dropped_iterations` path in `ramping-vus`; instead, unfinished work can show up as interrupted iterations when `hardStop()` cancels VU contexts. Explicit `ramping-vus` scenarios reject `duration`, `vus`, `iterations`, and `maxDuration` as unknown fields.
- Evidence: `lib/executor/ramping_vus.go:177-247,313-451,494-717`, `lib/executor/vu_handle.go:13-264`, `lib/executor/helpers.go:77-153`, `lib/executor/execution_config_shortcuts.go:28-36,78-82`, `lib/executor/ramping_vus_test.go:91-552`, stdin `rtk k6 run -` checks, and demo runs from `examples/ramping_vus_stage_timeline_demo.js`, `examples/ramping_vus_vu_speed_count_demo.js`, `examples/ramping_vus_graceful_rampdown_demo.js`, `examples/ramping_vus_interrupt_demo.js`, `examples/ramping_vus_quickpizza_two_requests_demo.js`.
- Decision: Document `ramping-vus` with separate sections for timeline shape, VU speed imbalance, graceful ramp-down vs hard interruption, and QuickPizza worked-example formulas.
- Next: Review the new docs/examples for consistency with the earlier `constant-vus` structure.
