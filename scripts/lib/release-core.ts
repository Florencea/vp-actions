import { compare, increment, normalize, tryParse, type SemVer } from "verkit";

export type BumpType = "major" | "minor" | "patch";

export interface NextReleaseTags {
  version: string;
  targetTag: string;
  majorFloatingTag: string;
}

const DEFAULT_BASE_VERSION = "1.0.0";

/**
 * Parses a strict `X.Y.Z` or `vX.Y.Z` release tag without prerelease or build metadata.
 */
export function parseReleaseTag(tag: string): SemVer | null {
  const trimmed = tag.trim();
  const raw = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const parsed = tryParse(raw);
  if (parsed === null) {
    return null;
  }
  if ((parsed.prerelease?.length ?? 0) > 0 || (parsed.build?.length ?? 0) > 0) {
    return null;
  }
  if (normalize(parsed) !== raw) {
    return null;
  }
  return parsed;
}

/**
 * Returns valid release tags sorted from highest to lowest semantic version.
 */
export function sortSemVerTagsDesc(tags: readonly string[]): string[] {
  const parsedEntries: Array<{ tag: string; semver: SemVer }> = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    const semver = parseReleaseTag(trimmed);
    if (semver !== null) {
      parsedEntries.push({ tag: trimmed, semver });
    }
  }

  parsedEntries.sort((a, b) => compare(b.semver, a.semver));
  return parsedEntries.map((entry) => entry.tag);
}

/**
 * Determines the highest semantic version bump required by a list of commit lines.
 */
export function determineBumpFromCommitMessages(messages: readonly string[]): BumpType | null {
  let hasMajor = false;
  let hasMinor = false;
  let hasPatch = false;

  for (const rawLine of messages) {
    const trimmed = rawLine.trim();
    if (trimmed === "") {
      continue;
    }

    // Strip optional leading Git commit SHA from `git log --oneline`.
    const message = trimmed.replace(/^[a-f0-9]{7,}\s+/i, "");

    if (/BREAKING CHANGE:/i.test(message) || /^[a-z]+(?:\([^)]+\))?!:/i.test(message)) {
      hasMajor = true;
      continue;
    }

    if (/^feat(?:\([^)]+\))?:/i.test(message)) {
      hasMinor = true;
      continue;
    }

    if (/^(?:fix|perf)(?:\([^)]+\))?:/i.test(message)) {
      hasPatch = true;
    }
  }

  if (hasMajor) return "major";
  if (hasMinor) return "minor";
  if (hasPatch) return "patch";
  return null;
}

/**
 * Calculates the next exact SemVer tag (`vX.Y.Z`) and floating major tag (`vX`).
 */
export function calculateNextTag(currentTag: string | null, bump: BumpType): NextReleaseTags {
  const baseVersion = currentTag !== null ? parseReleaseTag(currentTag) : null;
  const nextVersion = increment(baseVersion ?? DEFAULT_BASE_VERSION, bump);
  if (nextVersion === null) {
    throw new Error(`Failed to increment version from "${currentTag ?? DEFAULT_BASE_VERSION}"`);
  }

  const parsedNext = parseReleaseTag(nextVersion);
  if (parsedNext === null) {
    throw new Error(`Incremented version is invalid: "${nextVersion}"`);
  }

  return {
    version: nextVersion,
    targetTag: `v${nextVersion}`,
    majorFloatingTag: `v${parsedNext.major}`,
  };
}
