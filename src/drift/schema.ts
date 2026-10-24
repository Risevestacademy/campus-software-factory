import { createJsonParser, parseJson } from "../schema/index.js";
import type { RulesetSnapshot } from "./index.js";

const validateRulesetSnapshot = createJsonParser<RulesetSnapshot>(
  new URL("../../policies/schema/ruleset-snapshot.schema.json", import.meta.url),
  "Ruleset snapshot",
);

export function parseRulesetSnapshot(source: string): RulesetSnapshot {
  return validateRulesetSnapshot(parseJson(source, "Ruleset snapshot"));
}
