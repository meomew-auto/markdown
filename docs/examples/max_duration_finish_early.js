import exec from "k6/execution";
import { sleep } from "k6";

// Expected:
// - CLI says max duration is 12s (10s maxDuration + 2s gracefulStop).
// - Actual run ends after about 3s because all 3 iterations finish early.
export const options = {
	scenarios: {
		finish_early: {
			executor: "per-vu-iterations",
			vus: 1,
			iterations: 3,
			maxDuration: "10s",
			gracefulStop: "2s",
		},
	},
};

function elapsedSeconds() {
	return ((Date.now() - exec.scenario.startTime) / 1000).toFixed(1);
}
export default function () {
	if (__VU === 1 && __ITER === 0) {
		console.log(
			`[scenario] startTimeMs=${exec.scenario.startTime} startTimeISO=${new Date(exec.scenario.startTime).toLocaleTimeString()}`,
		);
	}
	console.log(
		`[iter-start] scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
	);
	sleep(1);
	console.log(
		`[iter-end]   scenario=${exec.scenario.name} t=${elapsedSeconds()}s __VU=${__VU} __ITER=${__ITER}`,
	);
}
