import { Trend } from "k6/metrics";

export const options = {
  scenarios: {
    tail_latency_demo: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "10s",
    },
  },
  summaryTrendStats: ["count", "avg", "min", "med", "max", "p(90)", "p(95)"],
  thresholds: {
    tail_latency: [
      "avg>=589",
      "avg<=591",
      "max==5000",
      "p(95)>2790",
      "p(95)<2800",
    ],
  },
};

const tailLatency = new Trend("tail_latency", true);

export default function () {
  const values = [100, 100, 100, 100, 100, 100, 100, 100, 100, 5000];

  for (const value of values) {
    tailLatency.add(value);
    console.log(`[tail-latency-sample] value=${value}ms`);
  }
}
