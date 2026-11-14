import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  fetchRemoteActionManifest,
  fetchRemoteSemVerTags,
  listActionAndWorkflowFiles,
} from "./lib/actions-registry.js";
import {
  analyzeUpstreamApiCompatibility,
  buildUpgradeCommitMessage,
  classifyUpgradeKind,
  diffPublicContracts,
  extractPublicContract,
  formatSafeCommitCommand,
  rewriteUsesRefsInContent,
  scanYamlActionUsages,
  selectLatestStableSemVerTag,
  type ActionStepUsage,
  type ApiCompatibilityReport,
  type UpgradeEvaluationEntry,
  type UpgradeKind,
} from "./lib/actions-upgrade-core.js";
import { calculateNextTag, sortSemVerTagsDesc } from "./lib/release-core.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");

const UpgradeReportEntrySchema = z.object({
  target: z.string(),
  currentTag: z.string(),
  latestTag: z.string(),
  upgradeKind: z.enum(["none", "patch", "minor", "major"]),
  compatible: z.boolean(),
  breakingReasons: z.array(z.string()),
  informationalNotes: z.array(z.string()),
  manifestFetchError: z.string().optional(),
  files: z.array(z.string()),
});

const UpgradeReportSchema = z.object({
  status: z.enum([
    "up_to_date",
    "dry_run_ready",
    "upgraded_ready",
    "blocked_api_change",
    "blocked_verification_failed",
  ]),
  dryRun: z.boolean(),
  latestReleaseTag: z.string().nullable(),
  recommendedReleaseBump: z.literal("minor").nullable(),
  nextReleaseTag: z.string().nullable(),
  nextMajorFloatingTag: z.string().nullable(),
  modifiedFiles: z.array(z.string()),
  staged: z.boolean(),
  commitMessage: z.string().nullable(),
  commitCommand: z.string().nullable(),
  downstreamContractDiffs: z.array(z.string()),
  upgrades: z.array(UpgradeReportEntrySchema),
  verificationError: z.string().optional(),
});

type UpgradeReport = z.infer<typeof UpgradeReportSchema>;

function runCommand(command: string, args: string[], options: { captureOutput: boolean }): string {
  try {
    if (options.captureOutput) {
      return execFileSync(command, args, {
        cwd: ROOT_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      }).trim();
    }
    execFileSync(command, args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
      shell: false,
    });
    return "";
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${details}`, {
      cause: error,
    });
  }
}

function getLatestLocalSemverTag(): string | null {
  const rawTags = runCommand("git", ["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*"], {
    captureOutput: true,
  });
  if (rawTags === "") {
    return null;
  }
  const sorted = sortSemVerTagsDesc(rawTags.split("\n"));
  return sorted[0] ?? null;
}

function getDirtyTargetFiles(filePaths: readonly string[]): string[] {
  if (filePaths.length === 0) {
    return [];
  }
  const output = runCommand("git", ["status", "--porcelain", "--", ...filePaths], {
    captureOutput: true,
  });
  if (output === "") {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function groupExternalUsages(usages: readonly ActionStepUsage[]): Map<
  string,
  {
    target: string;
    repoSlug: string;
    subpath: string | undefined;
    currentTag: string;
    usages: ActionStepUsage[];
  }
> {
  const grouped = new Map<
    string,
    {
      target: string;
      repoSlug: string;
      subpath: string | undefined;
      currentTag: string;
      usages: ActionStepUsage[];
    }
  >();

  for (const usage of usages) {
    if (usage.actionRef.isInternal) {
      continue;
    }

    const key = `${usage.actionRef.target}@${usage.actionRef.ref}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      existing.usages.push(usage);
      continue;
    }

    grouped.set(key, {
      target: usage.actionRef.target,
      repoSlug: usage.actionRef.repoSlug,
      subpath: usage.actionRef.subpath,
      currentTag: usage.actionRef.ref,
      usages: [usage],
    });
  }

  return grouped;
}

async function evaluateExternalDependencies(
  usages: readonly ActionStepUsage[],
): Promise<UpgradeEvaluationEntry[]> {
  const grouped = groupExternalUsages(usages);
  const remoteTagsCache = new Map<string, string[]>();

  const entriesWithTags = [...grouped.values()].map((entry) => {
    let remoteTags = remoteTagsCache.get(entry.repoSlug);
    if (remoteTags === undefined) {
      remoteTags = fetchRemoteSemVerTags(entry.repoSlug);
      remoteTagsCache.set(entry.repoSlug, remoteTags);
    }
    const latestTag = selectLatestStableSemVerTag(remoteTags) ?? entry.currentTag;
    const upgradeKind: UpgradeKind = classifyUpgradeKind(entry.currentTag, latestTag) ?? "none";
    return { entry, latestTag, upgradeKind };
  });

  const evaluations = await Promise.all(
    entriesWithTags.map(
      async ({ entry, latestTag, upgradeKind }): Promise<UpgradeEvaluationEntry> => {
        if (upgradeKind === "none") {
          return {
            target: entry.target,
            repoSlug: entry.repoSlug,
            subpath: entry.subpath,
            currentTag: entry.currentTag,
            latestTag,
            upgradeKind: "none",
            usages: entry.usages,
            compatibility: {
              compatible: true,
              breakingReasons: [],
              informationalNotes: [],
            },
            manifestFetchError: undefined,
          };
        }

        const [fromManifestResult, toManifestResult] = await Promise.all([
          fetchRemoteActionManifest(entry.repoSlug, entry.subpath, entry.currentTag),
          fetchRemoteActionManifest(entry.repoSlug, entry.subpath, latestTag),
        ]);

        if (!toManifestResult.ok) {
          return {
            target: entry.target,
            repoSlug: entry.repoSlug,
            subpath: entry.subpath,
            currentTag: entry.currentTag,
            latestTag,
            upgradeKind,
            usages: entry.usages,
            compatibility: {
              compatible: false,
              breakingReasons: [toManifestResult.error],
              informationalNotes: [],
            },
            manifestFetchError: toManifestResult.error,
          };
        }

        const compatibility: ApiCompatibilityReport = analyzeUpstreamApiCompatibility({
          usages: entry.usages,
          fromManifest: fromManifestResult.ok ? fromManifestResult.manifest : null,
          toManifest: toManifestResult.manifest,
        });

        return {
          target: entry.target,
          repoSlug: entry.repoSlug,
          subpath: entry.subpath,
          currentTag: entry.currentTag,
          latestTag,
          upgradeKind,
          usages: entry.usages,
          compatibility,
          manifestFetchError: undefined,
        };
      },
    ),
  );

  return evaluations.toSorted((a, b) => a.target.localeCompare(b.target));
}

function buildReportEntries(
  evaluations: readonly UpgradeEvaluationEntry[],
): UpgradeReport["upgrades"] {
  return evaluations.map((entry) => ({
    target: entry.target,
    currentTag: entry.currentTag,
    latestTag: entry.latestTag,
    upgradeKind: entry.upgradeKind,
    compatible: entry.compatibility.compatible,
    breakingReasons: entry.compatibility.breakingReasons,
    informationalNotes: entry.compatibility.informationalNotes,
    manifestFetchError: entry.manifestFetchError,
    files: [...new Set(entry.usages.map((usage) => usage.filePath))].toSorted(),
  }));
}

function printHumanReport(report: UpgradeReport): void {
  console.log("=== External GitHub Actions Dependency Report ===");
  console.log(`Status: ${report.status}`);
  console.log(`Current latest release tag: ${report.latestReleaseTag ?? "(none)"}`);

  if (report.upgrades.length === 0) {
    console.log("No external GitHub Actions references found.");
    return;
  }

  console.log("");
  for (const item of report.upgrades) {
    const versionLabel =
      item.upgradeKind === "none"
        ? `${item.currentTag} (up-to-date)`
        : `${item.currentTag} -> ${item.latestTag} [${item.upgradeKind}]`;
    const apiStatus = item.compatible ? "API compatible" : "API CHANGE DETECTED";
    console.log(`- ${item.target}: ${versionLabel} | ${apiStatus}`);
    for (const note of item.informationalNotes) {
      console.log(`    info: ${note}`);
    }
    for (const reason of item.breakingReasons) {
      console.log(`    BLOCKED: ${reason}`);
    }
  }

  if (report.downstreamContractDiffs.length > 0) {
    console.log("\nDownstream public API contract changes detected:");
    for (const diff of report.downstreamContractDiffs) {
      console.log(`  - ${diff}`);
    }
  }

  if (report.verificationError !== undefined) {
    console.error(`\nVerification failure:\n${report.verificationError}`);
  }

  if (report.status === "blocked_api_change") {
    console.log(
      "\nAction required: Upstream API changes affect existing workflow/action usage. Review the BLOCKED items above and update actions/ or .github/workflows/ manually before releasing.",
    );
    return;
  }

  if (report.status === "upgraded_ready" || report.status === "dry_run_ready") {
    console.log(
      `\nNext planned minor release: ${report.nextReleaseTag ?? "(unknown)"} (floating ${report.nextMajorFloatingTag ?? "(unknown)"})`,
    );
    if (report.modifiedFiles.length > 0) {
      console.log(`Files (${report.staged ? "staged via git add" : "simulated"}):`);
      for (const filePath of report.modifiedFiles) {
        console.log(`  - ${filePath}`);
      }
    }
    if (report.commitCommand !== null) {
      console.log("\nRun the following command to commit (or use vpr release:publish):");
      console.log(`  ${report.commitCommand}`);
    }
  }
}

function emitReport(report: UpgradeReport, jsonMode: boolean): void {
  const validated = UpgradeReportSchema.parse(report);
  if (jsonMode) {
    console.log(JSON.stringify(validated, null, 2));
  } else {
    printHumanReport(validated);
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "skip-breaking": { type: "boolean", default: false },
      "keep-on-error": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: false,
  });

  const isDryRun = values["dry-run"] === true || values.check === true;
  const jsonMode = values.json === true;
  const skipBreaking = values["skip-breaking"] === true;
  const keepOnError = values["keep-on-error"] === true;
  const force = values.force === true;

  const targetFiles = listActionAndWorkflowFiles(ROOT_DIR);
  if (!isDryRun && !force) {
    const dirtyFiles = getDirtyTargetFiles(targetFiles);
    if (dirtyFiles.length > 0) {
      throw new Error(
        `Refusing to modify action/workflow files with uncommitted changes (use --force to override):\n${dirtyFiles.join("\n")}`,
      );
    }
  }

  const originalContents: Record<string, string> = {};
  const allUsages: ActionStepUsage[] = [];
  for (const relativePath of targetFiles) {
    const content = readFileSync(resolve(ROOT_DIR, relativePath), "utf8");
    originalContents[relativePath] = content;
    allUsages.push(...scanYamlActionUsages(relativePath, content));
  }

  const latestReleaseTag = getLatestLocalSemverTag();
  const evaluations = await evaluateExternalDependencies(allUsages);
  const reportEntries = buildReportEntries(evaluations);

  const pendingUpgrades = evaluations.filter((entry) => entry.upgradeKind !== "none");
  if (pendingUpgrades.length === 0) {
    emitReport(
      {
        status: "up_to_date",
        dryRun: isDryRun,
        latestReleaseTag,
        recommendedReleaseBump: null,
        nextReleaseTag: null,
        nextMajorFloatingTag: null,
        modifiedFiles: [],
        staged: false,
        commitMessage: null,
        commitCommand: null,
        downstreamContractDiffs: [],
        upgrades: reportEntries,
      },
      jsonMode,
    );
    return;
  }

  const blockedUpgrades = pendingUpgrades.filter((entry) => !entry.compatibility.compatible);
  const eligibleUpgrades = pendingUpgrades.filter((entry) => entry.compatibility.compatible);

  if (blockedUpgrades.length > 0 && (!skipBreaking || eligibleUpgrades.length === 0)) {
    emitReport(
      {
        status: "blocked_api_change",
        dryRun: isDryRun,
        latestReleaseTag,
        recommendedReleaseBump: null,
        nextReleaseTag: null,
        nextMajorFloatingTag: null,
        modifiedFiles: [],
        staged: false,
        commitMessage: null,
        commitCommand: null,
        downstreamContractDiffs: [],
        upgrades: reportEntries,
      },
      jsonMode,
    );
    process.exitCode = 2;
    return;
  }

  const replacements = new Map<string, string>();
  const appliedList: Array<{ target: string; from: string; to: string }> = [];
  for (const upgrade of eligibleUpgrades) {
    replacements.set(
      `${upgrade.target}@${upgrade.currentTag}`,
      `${upgrade.target}@${upgrade.latestTag}`,
    );
    appliedList.push({
      target: upgrade.target,
      from: upgrade.currentTag,
      to: upgrade.latestTag,
    });
  }

  const plannedModifiedFiles: string[] = [];
  const updatedContents: Record<string, string> = { ...originalContents };
  for (const relativePath of targetFiles) {
    const original = originalContents[relativePath];
    if (original === undefined) {
      continue;
    }
    const { updatedContent, changedCount } = rewriteUsesRefsInContent(original, replacements);
    if (changedCount > 0) {
      plannedModifiedFiles.push(relativePath);
      updatedContents[relativePath] = updatedContent;
    }
  }

  const beforeContract = extractPublicContract(originalContents);
  const afterContract = extractPublicContract(updatedContents);
  const contractDiffs = diffPublicContracts(beforeContract, afterContract);

  const nextTags = calculateNextTag(latestReleaseTag, "minor");
  const commitMessage = buildUpgradeCommitMessage(appliedList);
  const commitCommand = formatSafeCommitCommand(commitMessage);

  if (contractDiffs.length > 0) {
    emitReport(
      {
        status: "blocked_api_change",
        dryRun: isDryRun,
        latestReleaseTag,
        recommendedReleaseBump: null,
        nextReleaseTag: null,
        nextMajorFloatingTag: null,
        modifiedFiles: [],
        staged: false,
        commitMessage: null,
        commitCommand: null,
        downstreamContractDiffs: contractDiffs,
        upgrades: reportEntries,
      },
      jsonMode,
    );
    process.exitCode = 2;
    return;
  }

  if (isDryRun) {
    emitReport(
      {
        status: "dry_run_ready",
        dryRun: true,
        latestReleaseTag,
        recommendedReleaseBump: "minor",
        nextReleaseTag: nextTags.targetTag,
        nextMajorFloatingTag: nextTags.majorFloatingTag,
        modifiedFiles: plannedModifiedFiles,
        staged: false,
        commitMessage,
        commitCommand,
        downstreamContractDiffs: [],
        upgrades: reportEntries,
      },
      jsonMode,
    );
    return;
  }

  for (const relativePath of plannedModifiedFiles) {
    const content = updatedContents[relativePath];
    if (content !== undefined) {
      writeFileSync(resolve(ROOT_DIR, relativePath), content, "utf8");
    }
  }

  try {
    runCommand("vp", ["fmt", ...plannedModifiedFiles], { captureOutput: jsonMode });
    runCommand("vpr", ["agent:verify:gate"], { captureOutput: jsonMode });
  } catch (error: unknown) {
    if (!keepOnError) {
      for (const relativePath of plannedModifiedFiles) {
        const original = originalContents[relativePath];
        if (original !== undefined) {
          writeFileSync(resolve(ROOT_DIR, relativePath), original, "utf8");
        }
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    emitReport(
      {
        status: "blocked_verification_failed",
        dryRun: false,
        latestReleaseTag,
        recommendedReleaseBump: null,
        nextReleaseTag: null,
        nextMajorFloatingTag: null,
        modifiedFiles: keepOnError ? plannedModifiedFiles : [],
        staged: false,
        commitMessage: null,
        commitCommand: null,
        downstreamContractDiffs: [],
        upgrades: reportEntries,
        verificationError: message,
      },
      jsonMode,
    );
    process.exitCode = 1;
    return;
  }

  // Strictly stage only the modified files (`git add`), never commit or push.
  runCommand("git", ["add", "--", ...plannedModifiedFiles], { captureOutput: jsonMode });

  emitReport(
    {
      status: "upgraded_ready",
      dryRun: false,
      latestReleaseTag,
      recommendedReleaseBump: "minor",
      nextReleaseTag: nextTags.targetTag,
      nextMajorFloatingTag: nextTags.majorFloatingTag,
      modifiedFiles: plannedModifiedFiles,
      staged: true,
      commitMessage,
      commitCommand,
      downstreamContractDiffs: [],
      upgrades: reportEntries,
    },
    jsonMode,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Action upgrade helper failed: ${message}`);
  process.exitCode = 1;
});
