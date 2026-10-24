# Software Factory Glossary

- **Baseline window:** The earlier, explicitly bounded observation window used
  for comparison with the current window. A missing or undersized baseline is
  reported as insufficient data, never as improvement.
- **Current window:** The explicitly bounded observation window whose delivery
  and safety outcomes are being evaluated.
- **Eligible to merge:** The instant all required checks, reviews, and
  conversations are satisfied. It ends when an owning-team Code Owner merges.
- **Factory-caused incident:** A production incident attributed to a change in
  factory policy, automation, or enforcement rather than product behavior.
- **Invocation claim:** A durable GitHub Actions artifact named for a tested
  head SHA. SHA-scoped workflow concurrency serializes contenders; the claim
  then prevents a later run from spending twice on the same revision.
- **Measurable outcome:** The workflow, behavior, metric, log, trace, or eval
  score a pull request is intended to improve.
- **Ready for review:** The product-defined timestamp when a non-draft change
  first has the required context and is offered for human review.
- **Ready to merge:** The duration from ready for review until the change first
  becomes eligible to merge.
- **Ruleset drift:** Any difference between the canonical expected ruleset and
  the complete effective GitHub configuration, including target, conditions,
  bypass actors, and rule parameters.
- **Specialist compliance:** The share of sensitive pull requests that obtained
  every mandatory specialist approval.
- **Tested SHA:** The exact pull-request head revision that successfully
  completed the audited CI workflow.
