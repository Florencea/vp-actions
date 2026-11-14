import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ActionManifestSchema, type ActionManifest } from "./actions-upgrade-core.js";
import { sortSemVerTagsDesc } from "./release-core.js";

const FETCH_TIMEOUT_MS = 10_000;

export type ManifestFetchResult =
  | {
      ok: true;
      manifest: ActionManifest;
      sourceUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Discovers all composite `actions/<name>/action.yml` (or `.yaml`) and
 * `.github/workflows/<name>.yml` (or `.yaml`) files relative to `rootDir` using POSIX forward slashes.
 */
export function listActionAndWorkflowFiles(rootDir: string): string[] {
  const files: string[] = [];

  const actionsDir = resolve(rootDir, "actions");
  if (existsSync(actionsDir)) {
    const entries = readdirSync(actionsDir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      for (const candidate of ["action.yml", "action.yaml"]) {
        const relativePath = `actions/${entry.name}/${candidate}`;
        if (existsSync(resolve(rootDir, relativePath))) {
          files.push(relativePath);
        }
      }
    }
  }

  const workflowsDir = resolve(rootDir, ".github/workflows");
  if (existsSync(workflowsDir)) {
    const entries = readdirSync(workflowsDir)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .toSorted();
    for (const name of entries) {
      files.push(`.github/workflows/${name}`);
    }
  }

  return files;
}

/**
 * Parses `git ls-remote --tags` output (without `--refs`) into a map of `tagName -> commitSha`,
 * preferring peeled annotated-tag commit SHAs (`^{}`) over unpeeled tag-object SHAs.
 */
export function parseLsRemoteTagMap(stdout: string): Map<string, string> {
  const lightweightOrTagObject = new Map<string, string>();
  const peeledCommit = new Map<string, string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }

    const tabIndex = line.indexOf("\t");
    if (tabIndex <= 0) {
      continue;
    }

    const sha = line.slice(0, tabIndex).trim();
    const ref = line.slice(tabIndex + 1).trim();
    if (!ref.startsWith("refs/tags/")) {
      continue;
    }

    const tagPart = ref.slice("refs/tags/".length);
    if (tagPart.endsWith("^{}")) {
      const tagName = tagPart.slice(0, -3);
      peeledCommit.set(tagName, sha);
    } else {
      lightweightOrTagObject.set(tagPart, sha);
    }
  }

  const resolved = new Map<string, string>();
  for (const [tagName, sha] of lightweightOrTagObject) {
    resolved.set(tagName, peeledCommit.get(tagName) ?? sha);
  }
  for (const [tagName, sha] of peeledCommit) {
    if (!resolved.has(tagName)) {
      resolved.set(tagName, sha);
    }
  }

  return resolved;
}

function toGitRemoteTarget(repoSlugOrRemote: string): string {
  if (
    repoSlugOrRemote.startsWith("https://") ||
    repoSlugOrRemote.startsWith("ssh://") ||
    repoSlugOrRemote.startsWith("git@") ||
    !repoSlugOrRemote.includes("/")
  ) {
    return repoSlugOrRemote;
  }
  return `https://github.com/${repoSlugOrRemote}.git`;
}

/**
 * Queries remote `v*` tags via `git ls-remote` and returns valid `vX.Y.Z` tags sorted descending.
 */
export function fetchRemoteSemVerTags(repoSlugOrRemote: string): string[] {
  const remoteTarget = toGitRemoteTarget(repoSlugOrRemote);
  const stdout = execFileSync(
    "git",
    ["ls-remote", "--tags", "--refs", remoteTarget, "refs/tags/v*"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );

  const tagNames: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const tabIndex = line.indexOf("\t");
    if (tabIndex <= 0) {
      continue;
    }
    const ref = line.slice(tabIndex + 1).trim();
    if (ref.startsWith("refs/tags/")) {
      tagNames.push(ref.slice("refs/tags/".length));
    }
  }

  return sortSemVerTagsDesc(tagNames);
}

/**
 * Queries remote `v*` tags including `^{}` peeled commit SHAs for tag polling verification.
 */
export function fetchRemoteTagCommitMap(remote: string): Map<string, string> {
  const stdout = execFileSync("git", ["ls-remote", "--tags", remote, "refs/tags/v*"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return parseLsRemoteTagMap(stdout);
}

async function fetchManifestAtUrl(url: string): Promise<ManifestFetchResult> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "vp-actions-upgrade-checker",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `${url} -> HTTP ${response.status}`,
      };
    }

    const rawYaml = await response.text();
    const parsedYaml: unknown = parseYaml(rawYaml);
    const validated = ActionManifestSchema.safeParse(parsedYaml);
    if (!validated.success) {
      return {
        ok: false,
        error: `Invalid action manifest schema at ${url}: ${validated.error.message}`,
      };
    }

    return {
      ok: true,
      manifest: validated.data,
      sourceUrl: url,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${url} -> ${message}`,
    };
  }
}

/**
 * Fetches and validates an external GitHub Action's `action.yml` (or `action.yaml`) at a specific tag.
 */
export async function fetchRemoteActionManifest(
  repoSlug: string,
  subpath: string | undefined,
  tag: string,
): Promise<ManifestFetchResult> {
  const normalizedSubpath =
    subpath !== undefined && subpath !== "" ? `${subpath.replace(/^\/+|\/+$/g, "")}/` : "";
  const candidateUrls = (["action.yml", "action.yaml"] as const).map(
    (fileName) =>
      `https://raw.githubusercontent.com/${repoSlug}/${tag}/${normalizedSubpath}${fileName}`,
  );

  const results = await Promise.all(candidateUrls.map((url) => fetchManifestAtUrl(url)));
  const firstSuccess = results.find((result) => result.ok);
  if (firstSuccess !== undefined) {
    return firstSuccess;
  }

  const errors = results
    .filter((result): result is Extract<ManifestFetchResult, { ok: false }> => !result.ok)
    .map((result) => result.error);
  return {
    ok: false,
    error: `Unable to fetch action manifest for ${repoSlug}@${tag}: ${errors.join("; ")}`,
  };
}
