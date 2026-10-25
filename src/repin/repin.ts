import type { RepositoryPolicy } from "../policy/index.ts";

export const repinBranch = "chore/repin-factory-review";
export const factoryRepository = "Risevestacademy/campus-software-factory";
export const callerWorkflowPath = ".github/workflows/factory-pr-review.yml";

const factoryPinPattern =
  /(Risevestacademy\/campus-software-factory\/\.github\/actions\/factory-pr-review@)([0-9a-f]{40})/g;
const fullShaPattern = /^[0-9a-f]{40}$/;

export interface PinReplacement {
  changed: boolean;
  content: string;
  previousSha: string;
}

export interface RepositoryFile {
  content: string;
  sha: string;
}

export interface UpdateRepositoryFileInput {
  repository: string;
  path: string;
  branch: string;
  fileSha: string;
  content: string;
  message: string;
}

export interface OpenPullRequestInput {
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface RepinGitHubPort {
  getFactoryMainSha(): Promise<string>;
  branchExists(repository: string, branch: string): Promise<boolean>;
  getBranchSha(repository: string, branch: string): Promise<string>;
  getFile(repository: string, path: string, ref: string): Promise<RepositoryFile>;
  createBranch(repository: string, branch: string, sha: string): Promise<void>;
  updateFile(input: UpdateRepositoryFileInput): Promise<void>;
  openPullRequest(input: OpenPullRequestInput): Promise<string>;
}

export function replaceFactoryPin(
  workflow: string,
  factorySha: string,
): PinReplacement {
  if (!fullShaPattern.test(factorySha)) {
    throw new Error(`Factory main SHA "${factorySha}" is not a full commit SHA`);
  }
  const matches = [...workflow.matchAll(factoryPinPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Caller workflow must contain exactly one Factory PR Review pin; found ${matches.length}`,
    );
  }
  const match = matches[0];
  const prefix = match?.[1];
  const previousSha = match?.[2];
  const matchIndex = match?.index;
  if (
    prefix === undefined ||
    previousSha === undefined ||
    matchIndex === undefined
  ) {
    throw new Error("Caller workflow Factory PR Review pin is invalid");
  }
  if (previousSha === factorySha) {
    return { changed: false, previousSha, content: workflow };
  }
  const shaStart = matchIndex + prefix.length;
  return {
    changed: true,
    previousSha,
    content:
      workflow.slice(0, shaStart) +
      factorySha +
      workflow.slice(shaStart + previousSha.length),
  };
}

export async function repinRepository(
  repository: RepositoryPolicy,
  github: RepinGitHubPort,
): Promise<{ factorySha: string; pullRequestUrl: string }> {
  if (await github.branchExists(repository.github, repinBranch)) {
    throw new Error(
      `Branch "${repinBranch}" already exists in ${repository.github}`,
    );
  }
  const [factorySha, devSha, workflow] = await Promise.all([
    github.getFactoryMainSha(),
    github.getBranchSha(repository.github, "dev"),
    github.getFile(repository.github, callerWorkflowPath, "dev"),
  ]);
  const replacement = replaceFactoryPin(workflow.content, factorySha);
  if (!replacement.changed) {
    throw new Error(
      `${repository.github} already pins Factory PR Review to ${factorySha}`,
    );
  }

  await github.createBranch(repository.github, repinBranch, devSha);
  await github.updateFile({
    repository: repository.github,
    path: callerWorkflowPath,
    branch: repinBranch,
    fileSha: workflow.sha,
    content: replacement.content,
    message: "chore: repin Factory PR Review",
  });
  const pullRequestUrl = await github.openPullRequest({
    repository: repository.github,
    title: "chore: repin Factory PR Review",
    body: pullRequestBody(repository.id, factorySha),
    head: repinBranch,
    base: "dev",
  });
  return { factorySha, pullRequestUrl };
}

function pullRequestBody(repositoryId: string, factorySha: string): string {
  return `## Work item

Repin Factory PR Review after a factory merge.

## Change and measurable outcome

Pin ${repositoryId} to factory main commit \`${factorySha}\`, so new CI runs use the current review policy and action.

## Risk and sensitive paths

- Proposed tier: R3
- Sensitive paths touched: \`.github/workflows/factory-pr-review.yml\`
- Cross-repository/API/WebSocket compatibility impact: None.

## Verification evidence

- Tests or deterministic checks: The caller replacement changes one full factory SHA only.
- Manual verification, when no stable automated signal exists: Re-run product CI after merge.
- Staging/preview evidence: Not applicable.

## Compatibility, rollout, and rollback

Merge into \`dev\`. Roll back by restoring the previous immutable factory SHA.

## Merge readiness

- [ ] The PR is ready for Code Owner review.
- [ ] Required checks and conversations are resolved.
- [ ] A different qualified Code Owner approved the latest change.
- [ ] Required product, platform, and security reviewers are identified.
- [ ] The final merge will be performed manually by an owning-team Code Owner.
`;
}
