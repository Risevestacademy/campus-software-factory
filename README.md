# Campus by Rise Software Factory

This repository is the delivery control plane for Campus Web, Campus Server,
and Campus Mobile. It centralizes reusable CI, review policy, ruleset
expectations, flow metrics, drift detection, and operational documentation. It
does not run the Campus product or deploy production releases.

## Current state

The deterministic policy, baseline/current metrics, full ruleset drift, and
bounded Claude review modules are implemented. External inputs are validated
against strict schemas. The product registry and live `CODEOWNERS` entry intentionally
remain inactive until a read-only audit confirms the real GitHub organization,
repositories, team slugs, scripts, runtimes, contracts, and deployment
configuration.

## Local commands

The repository owner runs all commands:

```bash
pnpm policy:validate
pnpm test
pnpm typecheck
pnpm metrics:report path/to/metrics-input.json
pnpm drift:check policies/rulesets/expected.json path/to/actual-rulesets.json
```

## Adoption contract

Each product repository adds a caller workflow pinned to an audited full commit
SHA. Its package manifest provides the applicable standard scripts:

- All products: `lint`, `typecheck`, `test:ci`.
- Web: `build`, optionally `storybook:build` and `test:e2e`.
- Server: `build`, optionally `test:integration`, `contract:check`, and
  `migration:dry-run`.
- Mobile: optionally `contract:check`.

The stable required result is `quality-gate`. Its exact GitHub check name must
be recorded from a disposable integration PR before branch enforcement.

## Merge authority

Auto-merge and bot merge are disabled. Only qualified members of the owning
Code Owner team manually merge. An author who is a Code Owner may merge only
after a different qualified Code Owner approves the latest change.

## Claude review canary

The factory includes a reusable, advisory Claude review action for a three-day
`campus-web` canary. It runs only after successful PR CI on the current internal
head SHA. It uses pinned code-review, TDD, and Vitest skills, publishes at most
one consolidated review with up to three high-confidence findings, and remains
silent when no change should be requested.

Claude never approves or merges. Existing Code Owners retain sole approval and
manual merge authority. The local canary plan records activation, OAuth
handling, measurement, and rollback details.

The Vite+ migration, native hooks, and commit-message enforcement are a
separate changeset so tooling changes cannot obscure correctness regressions.

See [the build plan](docs/software-factory-build-plan.md) for rollout gates.
