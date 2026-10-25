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
pnpm repin <repository-id> # uses the current authenticated gh login
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
check on its head SHA after product CI passes. The summary lists one line per
finding under Standards and Spec, most severe first. Each finding's evidence,
failure scenario, and required change are in its line annotation.

Every finding with confidence of at least 0.9 is posted. The only ceiling is
GitHub's 50 annotations per check-run update; a review that reaches it says more
may exist, and the pull request should be split.

| Situation | Check |
|---|---|
| No change required | `success` |
| Findings with confidence of at least 0.9 (up to 50) | `failure`, one annotation per finding |
| Missing `## Change and measurable outcome` | `failure`; fix the description and re-run |
| Reviewer error or invalid output after one retry | `failure` (technical); re-run allowed |
| More than 400 changed lines or 15 changed files, excluding configured lockfiles | `neutral`; human review only, no provider usage |
| Fork pull request | `neutral`; human review only, no credentials used |
| Draft, or CI not green | no check yet; the required check stays pending |

A head SHA with a clean or findings result is never reviewed again. Findings
need a new commit or an audited owner-team bypass, so results cannot be
re-rolled.

### How it runs

`templates/factory-review-caller.yml` triggers on `workflow_run` after product
CI completes. Before starting a provider, the action excludes configured
lockfiles and measures changed lines and files. Oversized pull requests receive
a completed neutral check and never start an AI review. The
`factory-pr-review` action reads policy from the pinned factory commit, checks
out the head as untrusted evidence in `pr/` and the
target branch's guidance in `trusted/`, and runs the one provider pinned for
that repository in `policies/pr-review.yaml`: Claude or Codex, never a
fallback. Output is validated deterministically; a finding can block only if
it points at a line the pull request changed. Claude runs with subprocess
environment scrubbing, which needs bubblewrap, so when Claude is the provider
the action installs it. If the runner image still blocks bwrap's user
namespaces, the action relaxes `kernel.apparmor_restrict_unprivileged_userns`
on that disposable runner and logs a warning.

Claude is the initial provider for every repository. Codex calls the hosted
OpenAI API, which the factory allows as an exception AJ approved on
2026-10-25; no repository pins it yet.

### When the reviewer is unavailable

A provider outage or exhausted usage limit fails the check as technical, so
the pull request stays blocked and a same-SHA re-run is allowed. Re-run the
review once the limit resets. An urgent merge uses the owner-team bypass.
Switching provider is a factory policy commit plus a pinned-SHA bump in the
caller, and it starts a new advisory canary, so it is not an outage fix.

### Credentials

Provider credentials are the Actions secrets `CLAUDE_CODE_OAUTH_TOKEN` and
`OPENAI_API_KEY`, set on each product repository or as organization secrets
scoped to it. The caller template passes exactly these names, so
`pnpm policy:validate` rejects any other `credential.secret`. Personal
credentials need `owner`, `expiresOn`, and `rotateBy` in policy. An expired
credential fails `pnpm policy:validate` and stops new reviews, which keeps the
required check pending.

### Rollout per repository

1. Create the owner team from `policies/repo-registry.yaml`, point CODEOWNERS
   at it, and create the `factory-review:valid` and
   `factory-review:false-positive` labels.
2. Make the provider's secret available to the repository. Product repos are
   public, so this factory repo must be public for them to call its action.
3. Set `mode: advisory` with `canaryStartsAt`, `canaryProvider` equal to
   `provider`, and credential metadata. Merge it to factory `main`.
4. Copy the caller template to the product's default branch, pin it to the
   factory commit from step 3, and set its CI workflow name. A pin to a commit
   where the repository is `disabled` skips every review.
5. After every later factory merge, run `pnpm repin <repository-id>`. The
   command populates the target repository's `.github/pull_request_template.md`
   from `dev`. Merge the generated pull request into `dev`.
6. Label every finding-bearing pull request `factory-review:valid` or
   `factory-review:false-positive` for 10 pull requests or 14 days.
7. Run `pnpm review:evaluate`. It must pass.
8. Product CODEOWNERS approve `mode: enforced`, and the `factory-quality`
   ruleset requires `Factory PR Review` on `dev`, then on `main`.

A provider, model, rubric, or major action change returns that repository to
advisory and starts a new canary. `pnpm policy:validate` enforces the provider
and model half: it rejects a `provider` that differs from `canaryProvider`.

GitHub treats a neutral required check as passing. In enforced mode, oversized
pull requests therefore rely on CODEOWNER approval and the repository's human
review rules.

### Known residuals

- A draft pull request from a fork gets the neutral "human review only"
  check, because GitHub sends no draft state on fork CI runs.
- The provider step runs in the job that holds `checks: write`. Claude's
  subprocess environment is scrubbed of secrets; splitting start, review, and
  publish into separate jobs would remove the token and is deferred.

### Bypass

Only the owner team named in `policies/repo-registry.yaml` may bypass, in
`pull_request` mode. Every CODEOWNERS rule must include that team, and owners
must be teams; `pnpm drift:review-gate` enforces the match. See
[the ruleset notes](policies/rulesets/README.md) for the known check-spoofing
residual.

The Vite+ migration, native hooks, and commit-message enforcement are a
separate changeset so tooling changes cannot obscure correctness regressions.

See [the build plan](docs/software-factory-build-plan.md) for rollout gates.
