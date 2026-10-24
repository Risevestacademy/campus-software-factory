# Expected GitHub rulesets

`expected.json` remains empty until the read-only product-repository and
organization audit is complete. Do not guess repository names, team slugs, or
GitHub plan capabilities.

For each audited repository, record two independently layered rulesets:

- `factory-merge-actor` restricts updates to the default branch. Only the
  owning Code Owner team receives `pull_request` bypass for this ruleset.
- `factory-quality` requires a pull request, latest-change approval,
  conversation resolution, specialist review where applicable, and the stable
  `quality-gate`. Ordinary Code Owners receive no bypass.

The break-glass team may be listed on `factory-quality` only while an incident
is active and only under the exception process.

Each snapshot is the canonical complete effective configuration returned by
GitHub: name, target, source, source type, enforcement, conditions, structured
bypass actors, rule types, and every rule parameter. Arrays are normalized for
comparison, but no enforceable field is projected away. This ensures changes
such as disabling latest-push approval or conversation resolution are visible
as drift.
