import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export type JsonParser<T> = (value: unknown) => T;

export function createJsonParser<T>(
  schemaUrl: URL,
  label: string,
): JsonParser<T> {
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as object;
  const validate = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
  }).compile<T>(schema);

  return (value: unknown): T => {
    if (!validate(value)) {
      throw new Error(formatValidationErrors(label, validate));
    }
    return value;
  };
}

export function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`, { cause: error });
  }
}

function formatValidationErrors(
  label: string,
  validate: ValidateFunction,
): string {
  const details = (validate.errors ?? [])
    .map((error) => {
      const path = error.instancePath.length === 0 ? "/" : error.instancePath;
      return `${path} ${error.message ?? error.keyword}`;
    })
    .join("; ");
  return `${label} does not match its schema: ${details}`;
}
