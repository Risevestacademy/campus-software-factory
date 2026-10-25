# Software Factory Glossary

- **Baseline window:** The earlier, explicitly bounded observation window used
  for comparison with the current window. A missing or undersized baseline is
  reported as insufficient data, never as improvement.
- **Current window:** The explicitly bounded observation window whose delivery
  and safety outcomes are being evaluated.
- **Decisive outcome:** A `clean` or `findings` review of a head SHA. Once one
  exists, that SHA is never reviewed again.
- **Disposition label:** `factory-review:valid` or
  `factory-review:false-positive`, applied by a product CODEOWNER to every
  finding-bearing pull request during a canary.
- **Eligible to merge:** The instant all required checks, reviews, and
  conversations are satisfied. It ends when an owning-team Code Owner merges.
- **Factory PR Review:** The Check Run the factory publishes on a pull request
  head SHA. It is required on `dev` and `main` once a repository is enforced.
- **Factory-caused incident:** A production incident attributed to a change in
  factory policy, automation, or enforcement rather than product behavior.
- **Measurable outcome:** The workflow, behavior, metric, log, trace, or eval
  score a pull request is intended to improve.
- **Ready for review:** The product-defined timestamp when a non-draft change
  first has the required context and is offered for human review.
- **Ready to merge:** The duration from ready for review until the change first
  becomes eligible to merge.
- **Review mode:** `disabled`, `advisory`, or `enforced` per repository in
  `policies/pr-review.yaml`. Advisory reviews every pull request but does not
  block merge.
- **Ruleset drift:** Any difference between the canonical expected ruleset and
  the complete effective GitHub configuration, including target, conditions,
  bypass actors, and rule parameters.
- **Specialist compliance:** The share of sensitive pull requests that obtained
  every mandatory specialist approval.
- **Technical outcome:** A review that could not produce a valid result after
  one retry. It fails the check and allows a same-SHA rerun.
- **Tested SHA:** The exact pull-request head revision that successfully
  completed the audited CI workflow.
