import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fetchRemoteTagCommitMap, listActionAndWorkflowFiles } from "./lib/actions-registry.js";
import {
  buildUpgradeCommitMessage,
  formatSafeCommitCommand,
  planInternalActionRefSync,
  sanitizeCommitMessageForShell,
  scanYamlActionUsages,
} from "./lib/actions-upgrade-core.js";
import {
  calculateNextTag,
  determineBumpFromCommitMessages,
  sortSemVerTagsDesc,
  type BumpType,
  type NextReleaseTags,
} from "./lib/release-core.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");

function runGitCapture(args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  }).trim();
}

function runInteractive(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: false,
  });
}

function getLatestSemverTag(): string | null {
  const rawTags = runGitCapture(["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*"]);
  if (rawTags === "") {
    return null;
  }
  const sorted = sortSemVerTagsDesc(rawTags.split("\n"));
  return sorted[0] ?? null;
}

function getCurrentBranch(): string {
  return runGitCapture(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function getHeadSha(): string {
  return runGitCapture(["rev-parse", "HEAD"]);
}

function getStagedFiles(): string[] {
  const output = runGitCapture(["diff", "--cached", "--name-only"]);
  if (output === "") {
    return [];
  }
  return output.split(/\r?\n/).filter((line) => line !== "");
}

function getUnstagedModifiedFiles(): string[] {
  const output = runGitCapture(["diff", "--name-only"]);
  if (output === "") {
    return [];
  }
  return output.split(/\r?\n/).filter((line) => line !== "");
}

function deriveCommitMessageFromStagedActions(stagedFiles: readonly string[]): string {
  const changes: Array<{ target: string; from: string; to: string }> = [];
  const seen = new Set<string>();

  for (const relativePath of stagedFiles) {
    if (!relativePath.endsWith(".yml") && !relativePath.endsWith(".yaml")) {
      continue;
    }

    let headContent = "";
    try {
      headContent = runGitCapture(["show", `HEAD:${relativePath}`]);
    } catch {
      continue;
    }

    const workingContent = readFileSync(resolve(ROOT_DIR, relativePath), "utf8");
    const beforeUsages = scanYamlActionUsages(relativePath, headContent);
    const afterUsages = scanYamlActionUsages(relativePath, workingContent);

    const beforeByScopeStep = new Map<string, string>();
    for (const usage of beforeUsages) {
      beforeByScopeStep.set(`${usage.scopeId}#${usage.stepIndex}`, usage.actionRef.ref);
    }

    for (const usage of afterUsages) {
      if (usage.actionRef.isInternal) {
        continue;
      }
      const prevRef = beforeByScopeStep.get(`${usage.scopeId}#${usage.stepIndex}`);
      if (prevRef !== undefined && prevRef !== usage.actionRef.ref) {
        const key = `${usage.actionRef.target}:${prevRef}->${usage.actionRef.ref}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({
            target: usage.actionRef.target,
            from: prevRef,
            to: usage.actionRef.ref,
          });
        }
      }
    }
  }

  if (changes.length > 0) {
    return buildUpgradeCommitMessage(changes);
  }
  return "feat(actions): upgrade external GitHub Actions";
}

function computeExpectedRelease(latestTag: string | null): {
  bump: BumpType | null;
  nextTags: NextReleaseTags | null;
  alreadyTagged: boolean;
} {
  if (latestTag === null) {
    return {
      bump: "patch",
      nextTags: calculateNextTag(null, "patch"),
      alreadyTagged: false,
    };
  }

  const headSha = getHeadSha();
  const tagSha = runGitCapture(["rev-parse", `${latestTag}^{commit}`]);
  if (headSha === tagSha) {
    return {
      bump: null,
      nextTags: null,
      alreadyTagged: true,
    };
  }

  const commitLog = runGitCapture(["log", `${latestTag}..HEAD`, "--oneline"]);
  if (commitLog === "") {
    return {
      bump: null,
      nextTags: null,
      alreadyTagged: false,
    };
  }

  const bump = determineBumpFromCommitMessages(commitLog.split("\n"));
  if (bump === null) {
    return {
      bump: null,
      nextTags: null,
      alreadyTagged: false,
    };
  }

  return {
    bump,
    nextTags: calculateNextTag(latestTag, bump),
    alreadyTagged: false,
  };
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
  if (answer === "") {
    return defaultYes;
  }
  return answer === "y" || answer === "yes";
}

async function waitForRemoteTag(params: {
  remote: string;
  targetTag: string;
  expectedCommitSha: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}): Promise<void> {
  const { remote, targetTag, expectedCommitSha, intervalSeconds, timeoutSeconds } = params;
  const startedAt = Date.now();
  const shortSha = expectedCommitSha.slice(0, 7);

  console.log(
    `\nPolling remote "${remote}" for tag ${targetTag} (target commit ${shortSha}, interval=${intervalSeconds}s, timeout=${timeoutSeconds}s)...`,
  );

  async function pollOnce(): Promise<void> {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const remoteTags = fetchRemoteTagCommitMap(remote);
    const resolvedSha = remoteTags.get(targetTag);

    if (resolvedSha !== undefined) {
      if (resolvedSha === expectedCommitSha) {
        console.log(`[${elapsedSeconds}s] Remote tag ${targetTag} is ready on commit ${shortSha}.`);
        return;
      }
      throw new Error(
        `Remote tag ${targetTag} already exists on a different commit (${resolvedSha.slice(0, 7)} != ${shortSha}).`,
      );
    }

    if (elapsedSeconds >= timeoutSeconds) {
      throw new Error(
        `Timed out after ${timeoutSeconds}s waiting for remote tag ${targetTag} on commit ${shortSha}. Check GitHub Actions CI/Release workflow status and sync later with: git fetch ${remote} --tags --force`,
      );
    }

    console.log(`[${elapsedSeconds}s/${timeoutSeconds}s] Waiting for ${targetTag}...`);
    await delay(intervalSeconds * 1000);
    return pollOnce();
  }

  await pollOnce();
}

function readWorkflowFiles(): Record<string, string> {
  const allFiles = listActionAndWorkflowFiles(ROOT_DIR).filter((filePath) =>
    filePath.startsWith(".github/workflows/"),
  );
  const contents: Record<string, string> = {};
  for (const relativePath of allFiles) {
    contents[relativePath] = readFileSync(resolve(ROOT_DIR, relativePath), "utf8");
  }
  return contents;
}

async function runStage2InternalSync(params: {
  rl: ReturnType<typeof createInterface> | null;
  remote: string;
  branch: string;
  releasedTag: string;
  syncCommitType: "chore" | "fix";
  intervalSeconds: number;
  timeoutSeconds: number;
  isDryRun: boolean;
}): Promise<void> {
  const {
    rl,
    remote,
    branch,
    releasedTag,
    syncCommitType,
    intervalSeconds,
    timeoutSeconds,
    isDryRun,
  } = params;

  const workflowFiles = readWorkflowFiles();
  const plannedSync = planInternalActionRefSync(workflowFiles, releasedTag);
  if (plannedSync.length === 0) {
    console.log(`\nStage 2 check: All internal action references are aligned with ${releasedTag}.`);
    return;
  }

  console.log(`\n=== Stage 2: Internal Action Reference Sync -> ${releasedTag} ===`);
  for (const item of plannedSync) {
    for (const change of item.changes) {
      console.log(`- ${item.filePath}: ${change.target} ${change.from} -> ${change.to}`);
    }
  }

  const stage2Message = sanitizeCommitMessageForShell(
    `${syncCommitType}(ci): sync internal action refs to ${releasedTag}`,
  );
  console.log(`Planned Stage 2 commit: ${formatSafeCommitCommand(stage2Message)}`);

  if (isDryRun) {
    return;
  }

  if (rl === null) {
    return;
  }

  const applyConfirmed = await promptYesNo(
    rl,
    "Apply Stage 2 internal action ref sync, verify, and stage changes?",
    true,
  );
  if (!applyConfirmed) {
    console.log("Skipped Stage 2 internal action ref sync.");
    return;
  }

  const modifiedPaths: string[] = [];
  for (const item of plannedSync) {
    writeFileSync(resolve(ROOT_DIR, item.filePath), item.updatedContent, "utf8");
    modifiedPaths.push(item.filePath);
  }

  runInteractive("vp", ["fmt", ...modifiedPaths]);
  runInteractive("vpr", ["agent:verify:gate"]);
  runInteractive("git", ["add", "--", ...modifiedPaths]);

  const commitAndPushConfirmed = await promptYesNo(
    rl,
    `Commit and push Stage 2 (${stage2Message}) now?`,
    true,
  );
  if (!commitAndPushConfirmed) {
    console.log(
      `Stage 2 files are staged. Run when ready:\n  ${formatSafeCommitCommand(stage2Message)}`,
    );
    return;
  }

  runInteractive("git", ["commit", "-m", stage2Message]);
  runInteractive("git", ["push", remote, branch]);

  if (syncCommitType === "fix") {
    const latestBeforeSync = getLatestSemverTag();
    const expectedPatch = calculateNextTag(latestBeforeSync, "patch");
    const stage2HeadSha = getHeadSha();
    await waitForRemoteTag({
      remote,
      targetTag: expectedPatch.targetTag,
      expectedCommitSha: stage2HeadSha,
      intervalSeconds,
      timeoutSeconds,
    });
    runInteractive("git", ["fetch", remote, "--tags", "--force"]);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      remote: { type: "string", default: "origin" },
      branch: { type: "string", default: "main" },
      interval: { type: "string", default: "10" },
      timeout: { type: "string", default: "900" },
      message: { type: "string" },
      "sync-commit-type": { type: "string", default: "chore" },
      "no-sync-internal": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: false,
  });

  const remote = typeof values.remote === "string" ? values.remote : "origin";
  const branch = typeof values.branch === "string" ? values.branch : "main";
  const intervalSeconds = Number.parseInt(
    typeof values.interval === "string" ? values.interval : "10",
    10,
  );
  const timeoutSeconds = Number.parseInt(
    typeof values.timeout === "string" ? values.timeout : "900",
    10,
  );
  const syncCommitTypeRaw =
    typeof values["sync-commit-type"] === "string" ? values["sync-commit-type"] : "chore";
  const noSyncInternal = values["no-sync-internal"] === true;
  const isDryRun = values["dry-run"] === true;
  const force = values.force === true;
  const explicitMessage = typeof values.message === "string" ? values.message : undefined;

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 2) {
    throw new Error(`Invalid --interval value: must be >= 2 seconds`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < intervalSeconds) {
    throw new Error(`Invalid --timeout value: must be >= --interval`);
  }
  if (syncCommitTypeRaw !== "chore" && syncCommitTypeRaw !== "fix") {
    throw new Error(`Invalid --sync-commit-type "${syncCommitTypeRaw}": must be "chore" or "fix"`);
  }
  const syncCommitType: "chore" | "fix" = syncCommitTypeRaw;

  if (
    !isDryRun &&
    (!process.stdin.isTTY || !process.stdout.isTTY || process.env["CI"] === "true")
  ) {
    throw new Error(
      "publish-release.ts is restricted to interactive human terminals (TTY) and cannot run in CI or non-interactive agent subshells.",
    );
  }

  const currentBranch = getCurrentBranch();
  if (currentBranch !== branch && !force) {
    throw new Error(
      `Current branch is "${currentBranch}", expected "${branch}". Switch branches or pass --force.`,
    );
  }

  const unstagedFiles = getUnstagedModifiedFiles();
  if (unstagedFiles.length > 0 && !force) {
    throw new Error(
      `Unstaged changes detected (commit, stage, or stash them first, or pass --force):\n${unstagedFiles.join("\n")}`,
    );
  }

  const rl = isDryRun
    ? null
    : createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  try {
    if (!isDryRun) {
      console.log(`Fetching tags and branch state from ${remote}...`);
      runInteractive("git", ["fetch", remote, branch, "--tags", "--force"]);
    }

    const stagedFiles = getStagedFiles();
    if (stagedFiles.length > 0) {
      const defaultMsg =
        explicitMessage !== undefined
          ? sanitizeCommitMessageForShell(explicitMessage)
          : deriveCommitMessageFromStagedActions(stagedFiles);

      console.log("\n=== Stage 1: Staged Changes Detected ===");
      for (const file of stagedFiles) {
        console.log(`  - ${file}`);
      }
      console.log(`Proposed commit: ${formatSafeCommitCommand(defaultMsg)}`);

      if (!isDryRun && rl !== null) {
        const customInput = (
          await rl.question(`Press Enter to accept message or type custom message: `)
        ).trim();
        const finalMsg =
          customInput !== "" ? sanitizeCommitMessageForShell(customInput) : defaultMsg;
        const confirmed = await promptYesNo(
          rl,
          `Run interactive git commit (${formatSafeCommitCommand(finalMsg)})?`,
          true,
        );
        if (!confirmed) {
          console.log("Aborted before commit.");
          return;
        }
        runInteractive("git", ["commit", "-m", finalMsg]);
      }
    }

    const latestTag = getLatestSemverTag();
    const releaseEval = computeExpectedRelease(latestTag);
    let aheadCount = 0;
    try {
      const countRaw = runGitCapture(["rev-list", "--count", `${remote}/${branch}..HEAD`]);
      aheadCount = Number.parseInt(countRaw, 10) || 0;
    } catch {
      aheadCount = 0;
    }

    const expectedTag =
      releaseEval.nextTags?.targetTag ?? (releaseEval.alreadyTagged ? latestTag : null);

    console.log("\n=== Release Evaluation ===");
    console.log(`Latest tag: ${latestTag ?? "(none)"}`);
    console.log(`Commits ahead of ${remote}/${branch}: ${aheadCount}`);
    console.log(`Detected bump: ${releaseEval.bump ?? "(none)"}`);
    console.log(`Expected release tag: ${expectedTag ?? "(none)"}`);

    if (aheadCount > 0 && !isDryRun && rl !== null) {
      const pushConfirmed = await promptYesNo(
        rl,
        `Push ${aheadCount} commit(s) to ${remote}/${branch}?`,
        true,
      );
      if (!pushConfirmed) {
        console.log("Aborted before push.");
        return;
      }
      runInteractive("git", ["push", remote, branch]);
    }

    let confirmedTag = releaseEval.alreadyTagged ? latestTag : null;
    if (releaseEval.nextTags !== null && !isDryRun) {
      const headSha = getHeadSha();
      await waitForRemoteTag({
        remote,
        targetTag: releaseEval.nextTags.targetTag,
        expectedCommitSha: headSha,
        intervalSeconds,
        timeoutSeconds,
      });
      runInteractive("git", ["fetch", remote, "--tags", "--force"]);
      confirmedTag = releaseEval.nextTags.targetTag;
    }

    const stage2TargetTag = isDryRun ? expectedTag : confirmedTag;
    if (!noSyncInternal && stage2TargetTag !== null) {
      await runStage2InternalSync({
        rl,
        remote,
        branch,
        releasedTag: stage2TargetTag,
        syncCommitType,
        intervalSeconds,
        timeoutSeconds,
        isDryRun,
      });
    }

    console.log("\nSupervised release orchestration complete.");
  } finally {
    rl?.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Publish release helper failed: ${message}`);
  process.exitCode = 1;
});
