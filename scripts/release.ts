import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

type BumpType = "major" | "minor" | "patch";

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(tag: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed: git ${args.join(" ")}\n${message}`, {
      cause: error,
    });
  }
}

function getLatestSemverTag(): string | null {
  const rawTags = runGit(["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"]);
  if (!rawTags) return null;
  const tags = rawTags
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const tag of tags) {
    if (parseSemVer(tag) !== null) {
      return tag;
    }
  }
  return null;
}

function determineBumpFromCommits(fromTag: string): BumpType | null {
  const commitLog = runGit(["log", `${fromTag}..HEAD`, "--oneline"]);
  if (!commitLog) return null;

  const lines = commitLog
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let hasMajor = false;
  let hasMinor = false;
  let hasPatch = false;

  for (const line of lines) {
    // Remove the short commit hash
    const msg = line.replace(/^[a-f0-9]+\s+/i, "");

    // Check for breaking changes
    if (/BREAKING CHANGE:/i.test(msg) || /^[a-z]+(?:\([^)]+\))?!:/i.test(msg)) {
      hasMajor = true;
      continue;
    }

    // Check for minor (feat)
    if (/^feat(?:\([^)]+\))?:/i.test(msg)) {
      hasMinor = true;
      continue;
    }

    // Check for patch (fix, perf)
    if (/^(?:fix|perf)(?:\([^)]+\))?:/i.test(msg)) {
      hasPatch = true;
      continue;
    }
  }

  if (hasMajor) return "major";
  if (hasMinor) return "minor";
  if (hasPatch) return "patch";
  return null;
}

function bumpVersion(current: SemVer, bump: BumpType): SemVer {
  switch (bump) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: current.major, minor: current.minor + 1, patch: 0 };
    case "patch":
      return { major: current.major, minor: current.minor, patch: current.patch + 1 };
    default: {
      const exhaustiveCheck: never = bump;
      throw new Error(`Unhandled bump type: ${String(exhaustiveCheck)}`);
    }
  }
}

function main(): void {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args: rawArgs,
    allowPositionals: true,
    options: {
      bump: {
        type: "string",
        default: "auto",
      },
      "dry-run": {
        type: "boolean",
        default: false,
      },
      push: {
        type: "boolean",
        default: false,
      },
      "github-release": {
        type: "boolean",
        default: false,
      },
    },
    strict: false,
  });

  const requestedBump = values.bump ?? "auto";
  const isDryRun = values["dry-run"] ?? false;
  const shouldPush = values.push ?? false;
  const shouldCreateGhRelease = values["github-release"] ?? false;

  console.log(
    `Release Strategy: bump=${requestedBump}, dryRun=${isDryRun}, push=${shouldPush}, ghRelease=${shouldCreateGhRelease}`,
  );

  const latestTag = getLatestSemverTag();
  console.log(`Latest detected release tag: ${latestTag ?? "(none)"}`);

  const baseVersion: SemVer = latestTag
    ? (parseSemVer(latestTag) ?? { major: 1, minor: 0, patch: 0 })
    : { major: 1, minor: 0, patch: 0 };

  let bumpType: BumpType | null = null;
  if (requestedBump === "major" || requestedBump === "minor" || requestedBump === "patch") {
    bumpType = requestedBump;
  } else if (requestedBump === "auto") {
    if (!latestTag) {
      bumpType = "patch";
    } else {
      const headCommit = runGit(["rev-parse", "HEAD"]);
      const tagCommit = runGit(["rev-parse", `${latestTag}^{commit}`]);
      if (headCommit === tagCommit) {
        console.log(`HEAD is already tagged with ${latestTag}. No release needed.`);
        return;
      }
      bumpType = determineBumpFromCommits(latestTag);
    }
  } else {
    throw new Error(
      `Invalid bump type: "${requestedBump}". Must be one of: auto, patch, minor, major`,
    );
  }

  if (!bumpType) {
    console.log(
      "No releasable commits found since previous tag (only chores, docs, or non-releasable commits). Skipping release.",
    );
    return;
  }

  const nextVer = bumpVersion(baseVersion, bumpType);
  const targetTag = `v${nextVer.major}.${nextVer.minor}.${nextVer.patch}`;
  const majorFloatingTag = `v${nextVer.major}`;

  console.log(
    `Calculated next version: ${targetTag} (Major floating tag: ${majorFloatingTag}) [bump: ${bumpType}]`,
  );

  if (isDryRun) {
    console.log("\n[DRY RUN] Simulation complete. Planned actions:");
    console.log(`  1. git tag -a ${targetTag} -m "Release ${targetTag}"`);
    console.log(
      `  2. git tag -fa ${majorFloatingTag} -m "Update ${majorFloatingTag} floating tag to ${targetTag}"`,
    );
    if (shouldPush) {
      console.log(`  3. git push origin ${targetTag}`);
      console.log(`  4. git push origin ${majorFloatingTag} --force`);
    }
    if (shouldCreateGhRelease) {
      console.log(
        `  5. gh release create ${targetTag} --title "Release ${targetTag}" --generate-notes`,
      );
    }
    return;
  }

  // Tag new exact version
  console.log(`Creating tag ${targetTag}...`);
  runGit(["tag", "-a", targetTag, "-m", `Release ${targetTag}`]);

  // Update major floating tag
  console.log(`Updating floating tag ${majorFloatingTag} to ${targetTag}...`);
  runGit([
    "tag",
    "-fa",
    majorFloatingTag,
    "-m",
    `Update ${majorFloatingTag} floating tag to ${targetTag}`,
  ]);

  // Push tags if requested
  if (shouldPush) {
    console.log(`Pushing ${targetTag} to origin...`);
    runGit(["push", "origin", targetTag]);

    console.log(`Force-pushing floating tag ${majorFloatingTag} to origin...`);
    runGit(["push", "origin", majorFloatingTag, "--force"]);
  }

  // Create GitHub release if requested
  if (shouldCreateGhRelease) {
    console.log(`Creating GitHub Release for ${targetTag}...`);
    const ghCheck = spawnSync("gh", ["--version"], { stdio: "ignore" });
    if (ghCheck.status === 0) {
      try {
        execFileSync(
          "gh",
          ["release", "create", targetTag, "--title", `Release ${targetTag}`, "--generate-notes"],
          {
            stdio: "inherit",
          },
        );
        console.log(`GitHub Release for ${targetTag} created successfully.`);
      } catch (err: unknown) {
        console.error(`Warning: Failed to create GitHub Release via gh CLI: ${String(err)}`);
      }
    } else {
      console.log("Notice: gh CLI not found in PATH; skipping automated GitHub Release creation.");
    }
  }

  console.log(`Release ${targetTag} successfully published.`);
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release script failed: ${message}`);
  process.exitCode = 1;
}
