import { describe, expect, test } from "vitest";

import {
  classifyChangedPaths,
  parsePolicyDocuments,
  validatePolicyBundle,
  type FactoryPolicyBundle,
  type PathPolicy,
} from "../../src/policy/index.js";

const pathPolicy: PathPolicy = {
  mechanicalAllowlist: [{ pattern: "docs/guides/**", tier: "R0" }],
  sensitivePaths: [
    { pattern: "src/auth/**", tier: "R3" },
    { pattern: "migrations/**", tier: "R4" },
  ],
};

describe("classifyChangedPaths", () => {
  test("keeps a mixed documentation and authentication change sensitive", () => {
    expect(
      classifyChangedPaths(
        ["docs/guides/sign-in.md", "src/auth/authorize.ts"],
        pathPolicy,
      ),
    ).toBe("R3");
  });

  test("classifies only explicitly allowlisted documentation as mechanical", () => {
    expect(
      classifyChangedPaths(["docs/guides/getting-started.md"], pathPolicy),
    ).toBe("R0");
    expect(classifyChangedPaths(["docs/security.md"], pathPolicy)).toBe("R2");
  });

  test("uses the highest sensitive tier touched by the change", () => {
    expect(
      classifyChangedPaths(
        ["src/auth/authorize.ts", "migrations/004_drop_roles.sql"],
        pathPolicy,
      ),
    ).toBe("R4");
  });
});

describe("validatePolicyBundle", () => {
  test("rejects duplicate repository identifiers before an audit can target the wrong repository", () => {
    const bundle: FactoryPolicyBundle = {
      repositories: [
        {
          id: "campus-web",
          github: "rise/campus-web",
          ownerTeam: "campus-web",
          workflow: "web",
        },
        {
          id: "campus-web",
          github: "rise/another-web",
          ownerTeam: "campus-web",
          workflow: "web",
        },
      ],
      paths: pathPolicy,
    };

    expect(() => validatePolicyBundle(bundle)).toThrow(
      'Duplicate repository id "campus-web"',
    );
  });
});

describe("parsePolicyDocuments", () => {
  test("rejects a repository entry with an unsupported workflow", () => {
    const repositoryRegistry = `
version: 1
repositories:
  - id: campus-web
    github: rise/campus-web
    ownerTeam: campus-web
    workflow: desktop
`;
    const sensitivePaths = `
version: 1
mechanicalAllowlist: []
sensitivePaths: []
`;

    expect(() =>
      parsePolicyDocuments(repositoryRegistry, sensitivePaths),
    ).toThrow('Repository "campus-web" has unsupported workflow "desktop"');
  });

  test("rejects undocumented repository properties", () => {
    const repositoryRegistry = `
version: 1
repositories:
  - id: campus-web
    github: rise/campus-web
    ownerTeam: campus-web
    workflow: web
    privileged: true
`;
    const sensitivePaths = `
version: 1
mechanicalAllowlist: []
sensitivePaths: []
`;

    expect(() =>
      parsePolicyDocuments(repositoryRegistry, sensitivePaths),
    ).toThrow(/additional properties/);
  });

  test("rejects a malformed GitHub repository identifier", () => {
    const repositoryRegistry = `
version: 1
repositories:
  - id: campus-web
    github: campus-web
    ownerTeam: campus-web
    workflow: web
`;
    const sensitivePaths = `
version: 1
mechanicalAllowlist: []
sensitivePaths: []
`;

    expect(() =>
      parsePolicyDocuments(repositoryRegistry, sensitivePaths),
    ).toThrow(/pattern/);
  });
});
