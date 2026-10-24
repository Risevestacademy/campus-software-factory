import type { MetricsInput } from "./index.js";
import { createJsonParser, parseJson } from "../schema/index.js";

const validateMetricsInput = createJsonParser<MetricsInput>(
  new URL("../../policies/schema/metrics-input.schema.json", import.meta.url),
  "Metrics input",
);

export function parseMetricsInput(source: string): MetricsInput {
  return validateMetricsInput(parseJson(source, "Metrics input"));
}
