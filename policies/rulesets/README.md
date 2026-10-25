# Expected GitHub rulesets

`expected.json` remains empty until the read-only product-repository and
organization audit is complete. Do not guess repository names, team slugs, or
GitHub plan capabilities.

For each audited repository, record two independently layered rulesets:

- `factory-merge-actor` restricts updates to the default branch. Only the
  owning Code Owner team receives `pull_request` bypass for this ruleset.
- `factory-quality` targets `refs/heads/dev` and `refs/heads/main`. It
  requires a pull request, latest-change approval, conversation resolution,
  specialist review where applicable, and the stable `quality-gate`. Once the
  repository's review mode is `enforced` in `policies/pr-review.yaml`, it also
  requires the `Factory PR Review` check.

## Factory PR Review bypass

GitHub rulesets cannot grant bypass to individual users, so every rule in
each product's CODEOWNERS must include its owner team from
`policies/repo-registry.yaml`, and every owner must be a team. Specialist teams
may be listed alongside the owner team.
That same team is the only `factory-quality` bypass actor, in `pull_request`
mode, so every bypass is a recorded ruleset event on a pull request.

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
