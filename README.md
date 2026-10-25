# Campus by Rise Software Factory

This repository is the delivery control plane for Campus Web, Campus Server,
and Campus Mobile. Its primary job is the merge-blocking `Factory PR Review`:
no pull request merges into `dev` or `main` until the factory has reviewed its
exact head SHA. It also centralizes reusable CI, review policy, ruleset
expectations, flow metrics, drift detection, and operational documentation. It
does not run the Campus product or deploy production releases.

## Current state

The deterministic policy, baseline/current metrics, full ruleset drift, and the
provider-neutral review gate are implemented. Every product is `disabled` in
`policies/pr-review.yaml` until its rollout starts. External inputs are validated
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
pnpm drift:review-gate    # needs FACTORY_AUDIT_TOKEN
pnpm review:evaluate <repository-id> --credential-incidents 0 --unsafe-reviews 0 --human-approval-intact
pnpm review:eval          # paid: runs the review prompt through local Claude Code
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

An owner-team member may bypass a failing `Factory PR Review` on a pull
request. GitHub records every bypass.

## Factory PR Review

### What contributors see

Every internal pull request into `dev` or `main` gets one `Factory PR Review`
check on its head SHA after product CI passes. The summary is split into
Standards and Spec, and each finding is a line annotation on the changed code.

| Situation | Check |
|---|---|
| No change required | `success` |
| 1-3 findings with confidence of at least 0.9 | `failure`, one annotation per finding |
| Missing `## Change and measurable outcome` | `failure`; fix the description and re-run |
| Reviewer error or invalid output after one retry | `failure` (technical); re-run allowed |
| Fork pull request | `neutral`; human review only, no credentials used |
| Draft, or CI not green | no check yet; the required check stays pending |

A head SHA with a clean or findings result is never reviewed again. Findings
need a new commit or an audited owner-team bypass, so results cannot be
re-rolled.

### How it runs

`templates/factory-review-caller.yml` triggers on `workflow_run` after product
CI completes. The `factory-pr-review` action reads policy from the pinned
factory commit, checks out the head as untrusted evidence in `pr/` and the
target branch's guidance in `trusted/`, and runs the one provider pinned for
that repository in `policies/pr-review.yaml`: Claude or Codex, never a
fallback. Output is validated deterministically; a finding can block only if
it points at a line the pull request changed.

### Credentials

Provider credentials are organization Actions secrets scoped to the three
product repositories. Personal credentials need `owner`, `expiresOn`, and
`rotateBy` in policy. An expired credential fails `pnpm policy:validate` and
stops new reviews, which keeps the required check pending.

### Rollout per repository

1. Copy the caller template to the product's default branch, pin the factory
   SHA, and set its CI workflow name.
2. Set `mode: advisory` with `canaryStartsAt` and credential metadata.
3. Label every finding-bearing pull request `factory-review:valid` or
   `factory-review:false-positive` for 10 pull requests or 14 days.
4. Run `pnpm review:evaluate`. It must pass.
5. Product CODEOWNERS approve `mode: enforced`, and the `factory-quality`
   ruleset requires `Factory PR Review` on `dev` and `main`.

A provider, model, rubric, or major action change returns that repository to
advisory and starts a new canary.

### Bypass

Only the owner team named in `policies/repo-registry.yaml` may bypass, in
`pull_request` mode. CODEOWNERS must name only that team; `pnpm
drift:review-gate` enforces the match. See
[the ruleset notes](policies/rulesets/README.md) for the known check-spoofing
residual.

The Vite+ migration, native hooks, and commit-message enforcement are a
separate changeset so tooling changes cannot obscure correctness regressions.

See [the build plan](docs/software-factory-build-plan.md) for rollout gates.
