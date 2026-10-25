import { randomUUID } from "node:crypto";

// Always the delimiter form: review reasons carry model-controlled text, and a
// newline in the single-line "name=value" form would forge extra step outputs.
export function formatOutput(name: string, value: string): string {
  const delimiter = `campus_${randomUUID()}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

export function formatNotice(message: string): string {
  return `::notice::${escapeCommandData(message)}\n`;
}

function escapeCommandData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
