import type { RepositoryPolicy } from "../policy/index.ts";

export const repinBranch = "chore/repin-factory-review";
export const factoryRepository = "Risevestacademy/campus-software-factory";
export const callerWorkflowPath = ".github/workflows/factory-pr-review.yml";
export const pullRequestTemplatePath = ".github/pull_request_template.md";

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
  const [factorySha, devSha, workflow, pullRequestTemplate] = await Promise.all([
    github.getFactoryMainSha(),
    github.getBranchSha(repository.github, "dev"),
    github.getFile(repository.github, callerWorkflowPath, "dev"),
    github.getFile(repository.github, pullRequestTemplatePath, "dev"),
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
    body: pullRequestBody(
      pullRequestTemplate.content,
      repository.id,
      factorySha,
    ),
    head: repinBranch,
    base: "dev",
  });
  return { factorySha, pullRequestUrl };
}

function pullRequestBody(
  template: string,
  repositoryId: string,
  factorySha: string,
): string {
  const headings = [...template.matchAll(/^## (.+)$/gm)];
  const firstHeadingIndex = headings[0]?.index;
  if (
    firstHeadingIndex === undefined ||
    !headings.some((heading) => heading[1]?.trim() === "Summary")
  ) {
    throw new Error('Pull request template must contain a "Summary" section');
  }

  const preamble = template.slice(0, firstHeadingIndex).trim();
  const sections = headings.map((heading, index) => {
    const headingIndex = heading.index ?? 0;
    const title = heading[1]?.trim() ?? "";
    const bodyStart = headingIndex + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? template.length;
    const existingBody = template.slice(bodyStart, bodyEnd).trim();
    const body = populatePullRequestSection(
      title,
      existingBody,
      repositoryId,
      factorySha,
    );

    return body.length > 0 ? `## ${title}\n\n${body}` : `## ${title}`;
  });
  const content = [...(preamble.length > 0 ? [preamble] : []), ...sections];

  return `${content.join("\n\n")}\n`;
}

function populatePullRequestSection(
  title: string,
  existingBody: string,
  repositoryId: string,
  factorySha: string,
): string {
  switch (title) {
    case "Summary":
      return `Repin Factory PR Review in ${repositoryId} to factory main commit \`${factorySha}\`.`;
    case "Change and measurable outcome":
      return `New ${repositoryId} CI runs use the current factory review policy and action.`;
    case "Changes":
      return `- Update \`${callerWorkflowPath}\` to factory commit \`${factorySha}\`.`;
    case "Related Issue":
      return "Not applicable — automated maintenance after a factory merge.";
    case "Type of Change":
      return existingBody.replace(
        "- [ ] Chore / Maintenance",
        "- [x] Chore / Maintenance",
      );
    case "Testing":
      return prependSectionBody(
        "Deterministic verification: the repin command changed exactly one immutable factory SHA. After merge, rerun product CI.",
        existingBody,
      );
    case "Screenshots / Evidence":
      return "Not applicable — workflow-only change.";
    case "Notes for Reviewers":
      return `- Risk: R3 because this changes \`${callerWorkflowPath}\`.
- Compatibility: No API, WebSocket, or product contract changes.
- Rollout: Merge into \`dev\`, then rerun product CI.
- Rollback: Restore the previous immutable factory SHA.`;
    default:
      return existingBody;
  }
}

function prependSectionBody(value: string, existingBody: string): string {
  return existingBody.length > 0 ? `${value}\n\n${existingBody}` : value;
}
