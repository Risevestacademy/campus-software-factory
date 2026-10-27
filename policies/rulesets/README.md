# Expected GitHub rulesets

`expected.json` is the live snapshot of every `policies/repo-registry.yaml`
repository's `factory-*` rulesets. A repository with none is listed with
`rulesets: []`, because the collector reports every registry repository.
Regenerate it after an intended ruleset change instead of editing it by hand:

```bash
FACTORY_AUDIT_TOKEN="$(gh auth token)" pnpm --silent drift:collect \
  | jq '{"$schema": "../schema/ruleset-snapshot.schema.json"} + .' \
  > policies/rulesets/expected.json
```

Each product repository carries one factory ruleset:

- `factory-quality` targets `refs/heads/dev` and `refs/heads/main`. It
  requires a pull request, latest-change approval, conversation resolution,
  specialist review where applicable, and the repository's stable CI check.
  Once the repository's review mode is `enforced` in
  `policies/pr-review.yaml`, it also requires the `Factory PR Review` check.
  It replaces any earlier hand-made branch rulesets, which drift cannot see.

| Repository | Ruleset | Request body | Stable CI check |
| --- | --- | --- | --- |
| campus-web | `factory-quality` | `campus-web-factory-quality.json` | `build` |
| campus-server | none yet | | |
| campus-mobile | none yet | | |

`factory-merge-actor`, which would let only the owner team merge into the
default branch, is not adopted in V1. With a two-person owner team it would
recreate the single-reviewer bottleneck the factory exists to remove.

## Factory PR Review bypass

GitHub rulesets cannot grant bypass to individual users, so every rule in
each product's CODEOWNERS must include its owner team from
`policies/repo-registry.yaml`, and every owner must be a team. Specialist teams
may be listed alongside the owner team.
That same team is the only `factory-quality` bypass actor, in `pull_request`
mode, so every bypass is a recorded ruleset event on a pull request. There is
deliberately no break-glass team: an incident merge goes through the owner
team's bypass, so drift flags any other bypass actor.

`pnpm drift:review-gate` checks every repository whose review mode is not
`disabled`:

- every CODEOWNERS rule includes the owner team and lists only teams;
- the owner team exists;
- `factory-quality` bypass is exactly that team in `pull_request` mode;
- `factory-quality` covers both `dev` and `main`;
- `Factory PR Review` is required when `enforced` and not yet required while
  `advisory`.

The weekly drift audit runs it after `drift:check` and reports both in the
same issue.

## Factory repository

`factory-main.json` is the request body for this repository's own `main`
ruleset (`gh api -X POST repos/Risevestacademy/campus-software-factory/rulesets
--input policies/rulesets/factory-main.json`). It follows the same owner-team
`pull_request` bypass model. `tests/policy/factory-governance.test.ts` keeps its
required check aligned with the self-check job name, because a mismatch would
block every merge.

Known residual: `Factory PR Review` and any other check created with a
workflow `GITHUB_TOKEN` share the `github-actions` app, so a ruleset cannot
pin the check to the factory. A pull request that adds a workflow posting a
fake check is caught by human review (`.github/**` is tier R3) rather than by
GitHub. A dedicated GitHub App would close this.

Each snapshot is the canonical complete effective configuration returned by
GitHub: name, target, source, source type, enforcement, conditions, structured
bypass actors, rule types, and every rule parameter. Arrays are normalized for
comparison, but no enforceable field is projected away. This ensures changes
such as disabling latest-push approval or conversation resolution are visible
as drift.
