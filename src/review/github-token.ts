import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Local runs reuse the gh login, as pnpm repin does.
export async function resolveGitHubToken(
  environment: NodeJS.ProcessEnv = process.env,
  readGhLoginToken: () => Promise<string> = ghLoginToken,
): Promise<string> {
  const fromEnvironment = environment.GITHUB_TOKEN;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return fromEnvironment;
  }
  const fromGh = (await readGhLoginToken()).trim();
  if (fromGh.length === 0) {
    throw new Error("No GitHub token: set GITHUB_TOKEN or run gh auth login");
  }
  return fromGh;
}

async function ghLoginToken(): Promise<string> {
  try {
    return (await execFileAsync("gh", ["auth", "token"])).stdout;
  } catch {
    return "";
  }
}
