import { createJsonParser } from "../schema/index.js";

export interface RepositoryRegistryDocument {
  version: 1;
  repositories: {
    id: string;
    github: string;
    ownerTeam: string;
    workflow: "web" | "server" | "mobile";
  }[];
}

export interface SensitivePathsDocument {
  version: 1;
  mechanicalAllowlist: {
    pattern: string;
    tier: "R0" | "R1";
  }[];
  sensitivePaths: {
    pattern: string;
    tier: "R3" | "R4";
  }[];
}

export const validateRepositoryRegistry =
  createJsonParser<RepositoryRegistryDocument>(
    new URL("../../policies/schema/repo-registry.schema.json", import.meta.url),
    "Repository registry",
  );

export const validateSensitivePaths = createJsonParser<SensitivePathsDocument>(
  new URL("../../policies/schema/sensitive-paths.schema.json", import.meta.url),
  "Sensitive paths",
);
