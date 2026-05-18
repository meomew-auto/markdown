import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - CLI says max duration is 5s (3s maxDuration + 2s gracefulStop).
// - Iteration #1 starts but is interrupted around t=5s.
// - Iteration #2 never starts, so it is counted as dropped_iterations.
export const options = {
	scenarios: {
		interrupted_demo: {
			executor: "per-vu-iterations",
			vus: 1,
			iterations: 2,
			maxDuration: "3s",
			gracefulStop: "2s",
		},
	},
};

function elapsedSeconds() {
	return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}

function sleepWithProgress(totalSeconds, step = 1) {
	for (let elapsed = 0; elapsed < totalSeconds; elapsed += step) {
		sleep(step);
		console.log(`[tick after sleep] t=${elapsedSeconds()}s`);
	}
}

export default function () {
	console.log(
		`[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
	);
	sleepWithProgress(10, 1);
	console.log(
		`[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
	);
}
