import { loadFactoryReviewPolicies } from "../review/policy-loader.js";
import {
  collectCodeowners,
  collectRepository,
  resolveTeamId,
} from "./github-collector.js";
import { auditReviewGate } from "./review-gate.js";

try {
  const token = process.env.FACTORY_AUDIT_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("FACTORY_AUDIT_TOKEN is required");
  }
  const { bundle, policy } = await loadFactoryReviewPolicies(new Date());
  const active = policy.repositories.flatMap((review) => {
    const repository = bundle.repositories.find((entry) => entry.id === review.id);
    return repository === undefined || review.mode === "disabled"
      ? []
      : [{ repository, mode: review.mode }];
  });
  const findings = (
    await Promise.all(
      active.map(async ({ repository, mode }) => {
        const [snapshot, codeowners, ownerTeamId] = await Promise.all([
          collectRepository(repository.github, token),
          collectCodeowners(repository.github, token),
          resolveTeamId(repository.ownerTeam, token),
        ]);
        return auditReviewGate({
          repository: repository.github,
          ownerTeam: repository.ownerTeam,
          ownerTeamId,
          codeowners,
          mode,
          rulesets: snapshot.rulesets,
        });
      }),
    )
  ).flat();
  process.stdout.write(
    `${JSON.stringify({ auditedRepositories: active.length, findings }, null, 2)}\n`,
  );
  if (findings.length > 0) {
    process.exitCode = 1;
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
