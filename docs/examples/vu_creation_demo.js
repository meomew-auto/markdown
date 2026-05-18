import http from "k6/http";
import exec from "k6/execution";

export const options = {};

const target = "https://quickpizza.grafana.com/";

console.log(`[init] runtime created for __VU=${__VU}`);

export default function myTest() {
	console.log(
		`[run] scenario=${exec.scenario.name} __VU=${__VU} idInTest=${exec.vu.idInTest} ` +
			`idInInstance=${exec.vu.idInInstance} __ITER=${__ITER} ` +
			`iterationInScenario=${exec.vu.iterationInScenario}`,
	);

	http.get(target);
}
