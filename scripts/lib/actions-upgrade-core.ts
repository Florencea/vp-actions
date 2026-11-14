import { compare, tryParse } from "verkit";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseReleaseTag, sortSemVerTagsDesc } from "./release-core.js";

export const INTERNAL_REPO_PREFIX = "Florencea/vp-actions/";

export type UpgradeKind = "none" | "patch" | "minor" | "major";

export interface ActionRef {
  rawUses: string;
  target: string;
  repoSlug: string;
  subpath: string | undefined;
  ref: string;
  isInternal: boolean;
}

export interface ActionStepUsage {
  filePath: string;
  scopeId: string;
  stepIndex: number;
  stepId: string | undefined;
  stepName: string | undefined;
  actionRef: ActionRef;
  withKeys: string[];
  referencedOutputs: string[];
}

const ActionInputDefSchema = z.object({
  description: z.string().optional(),
  required: z.union([z.boolean(), z.string()]).optional(),
  default: z.unknown().optional(),
  deprecationMessage: z.string().optional(),
});

const ActionOutputDefSchema = z.object({
  description: z.string().optional(),
  value: z.unknown().optional(),
});

export const ActionManifestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inputs: z.record(z.string(), ActionInputDefSchema).optional(),
  outputs: z.record(z.string(), ActionOutputDefSchema).optional(),
  runs: z
    .object({
      using: z.string().min(1),
    })
    .optional(),
});

export type ActionInputDef = z.infer<typeof ActionInputDefSchema>;
export type ActionManifest = z.infer<typeof ActionManifestSchema>;

const RawStepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const RawCompositeActionSchema = z.object({
  inputs: z.record(z.string(), ActionInputDefSchema).optional(),
  runs: z
    .object({
      using: z.string(),
      steps: z.array(RawStepSchema).optional(),
    })
    .optional(),
});

const RawWorkflowJobSchema = z.object({
  strategy: z
    .object({
      matrix: z.record(z.string(), z.array(z.unknown())).optional(),
    })
    .optional(),
  steps: z.array(RawStepSchema).optional(),
});

const RawWorkflowSchema = z.object({
  on: z.record(z.string(), z.unknown()).optional(),
  jobs: z.record(z.string(), RawWorkflowJobSchema).optional(),
});

export interface ApiCompatibilityReport {
  compatible: boolean;
  breakingReasons: string[];
  informationalNotes: string[];
}

export interface PublicWorkflowContract {
  workflowCallInputs: Record<
    string,
    {
      type: string | undefined;
      required: boolean;
      defaultValue: unknown;
    }
  >;
  jobIds: string[];
  matrixOsByJob: Record<string, string[]>;
}

export interface PublicContractSnapshot {
  setupVpEnvInputs: Record<
    string,
    {
      required: boolean;
      defaultValue: unknown;
    }
  >;
  setupPlaywrightHasInputs: boolean;
  workflows: Record<string, PublicWorkflowContract>;
}

export interface UpgradeEvaluationEntry {
  target: string;
  repoSlug: string;
  subpath: string | undefined;
  currentTag: string;
  latestTag: string;
  upgradeKind: UpgradeKind;
  usages: ActionStepUsage[];
  compatibility: ApiCompatibilityReport;
  manifestFetchError: string | undefined;
}

export interface InternalSyncChange {
  filePath: string;
  target: string;
  from: string;
  to: string;
}

function isInputRequired(def: ActionInputDef): boolean {
  if (typeof def.required === "boolean") {
    return def.required;
  }
  if (typeof def.required === "string") {
    return def.required.trim().toLowerCase() === "true";
  }
  return false;
}

/**
 * Parses a GitHub Action `uses:` reference such as `actions/checkout@v7.0.1`
 * or `owner/repo/subpath@v1.2.3`. Returns `null` for local or Docker refs.
 */
export function parseActionRef(uses: string): ActionRef | null {
  const trimmed = uses.trim();
  if (trimmed === "" || trimmed.startsWith("./") || trimmed.startsWith("docker://")) {
    return null;
  }

  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    return null;
  }

  const target = trimmed.slice(0, atIndex);
  const ref = trimmed.slice(atIndex + 1);
  const segments = target.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1];
  if (owner === undefined || repo === undefined) {
    return null;
  }

  const repoSlug = `${owner}/${repo}`;
  const subpath = segments.length > 2 ? segments.slice(2).join("/") : undefined;

  return {
    rawUses: trimmed,
    target,
    repoSlug,
    subpath,
    ref,
    isInternal: target.startsWith(INTERNAL_REPO_PREFIX),
  };
}

/**
 * Selects the highest stable `vX.Y.Z` tag from a list of tag names.
 */
export function selectLatestStableSemVerTag(tags: readonly string[]): string | null {
  const sorted = sortSemVerTagsDesc(tags);
  return sorted[0] ?? null;
}

/**
 * Classifies the SemVer upgrade level from `fromTag` to `toTag`.
 */
export function classifyUpgradeKind(fromTag: string, toTag: string): UpgradeKind | null {
  const fromVer = parseReleaseTag(fromTag);
  const toVer = parseReleaseTag(toTag);
  if (fromVer === null || toVer === null) {
    return null;
  }

  if (compare(toVer, fromVer) <= 0) {
    return "none";
  }
  if (toVer.major > fromVer.major) {
    return "major";
  }
  if (toVer.minor > fromVer.minor) {
    return "minor";
  }
  return "patch";
}

function collectOutputsReferencedByStepId(container: unknown): Map<string, Set<string>> {
  const serialized = JSON.stringify(container);
  const references = new Map<string, Set<string>>();
  const pattern = /\bsteps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\b/g;

  for (const match of serialized.matchAll(pattern)) {
    const stepId = match[1];
    const outputKey = match[2];
    if (stepId === undefined || outputKey === undefined) {
      continue;
    }
    let outputSet = references.get(stepId);
    if (outputSet === undefined) {
      outputSet = new Set<string>();
      references.set(stepId, outputSet);
    }
    outputSet.add(outputKey);
  }

  return references;
}

function extractStepUsages(
  filePath: string,
  scopeId: string,
  steps: readonly z.infer<typeof RawStepSchema>[],
  outputRefsByStepId: ReadonlyMap<string, Set<string>>,
): ActionStepUsage[] {
  const usages: ActionStepUsage[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    if (step.uses === undefined) {
      continue;
    }
    const actionRef = parseActionRef(step.uses);
    if (actionRef === null) {
      continue;
    }

    const withKeys = step.with !== undefined ? Object.keys(step.with) : [];
    const referencedSet = step.id !== undefined ? outputRefsByStepId.get(step.id) : undefined;
    const referencedOutputs = referencedSet !== undefined ? [...referencedSet] : [];

    usages.push({
      filePath,
      scopeId,
      stepIndex,
      stepId: step.id,
      stepName: step.name,
      actionRef,
      withKeys,
      referencedOutputs,
    });
  }

  return usages;
}

const RawRecordSchema = z.record(z.string(), z.unknown());

/**
 * Scans a composite action or GitHub workflow YAML file for external and internal `uses:` entries.
 */
export function scanYamlActionUsages(filePath: string, content: string): ActionStepUsage[] {
  const parsed: unknown = parseYaml(content);
  const rawDoc = RawRecordSchema.safeParse(parsed);
  const usages: ActionStepUsage[] = [];

  const compositeResult = RawCompositeActionSchema.safeParse(parsed);
  if (compositeResult.success && compositeResult.data.runs?.steps !== undefined) {
    const rawCompositeScope = rawDoc.success
      ? { runs: rawDoc.data["runs"], outputs: rawDoc.data["outputs"] }
      : compositeResult.data.runs.steps;
    const outputRefs = collectOutputsReferencedByStepId(rawCompositeScope);
    usages.push(
      ...extractStepUsages(filePath, "composite", compositeResult.data.runs.steps, outputRefs),
    );
  }

  const workflowResult = RawWorkflowSchema.safeParse(parsed);
  if (workflowResult.success && workflowResult.data.jobs !== undefined) {
    const rawJobs = rawDoc.success ? RawRecordSchema.safeParse(rawDoc.data["jobs"]) : null;
    for (const [jobId, job] of Object.entries(workflowResult.data.jobs)) {
      if (job.steps === undefined) {
        continue;
      }
      const rawJobScope = rawJobs !== null && rawJobs.success ? rawJobs.data[jobId] : job;
      const outputRefs = collectOutputsReferencedByStepId(rawJobScope);
      usages.push(...extractStepUsages(filePath, jobId, job.steps, outputRefs));
    }
  }

  return usages;
}

/**
 * Evaluates whether upgrading an external action from `fromManifest` to `toManifest`
 * introduces breaking changes affecting downstream CI behavior.
 *
 * Runtime changes such as `runs.using` (`node20` -> `node24`), added optional inputs,
 * added outputs, or unchanged caller contracts are treated as informational only.
 */
export function analyzeUpstreamApiCompatibility(params: {
  usages: readonly ActionStepUsage[];
  fromManifest: ActionManifest | null;
  toManifest: ActionManifest;
}): ApiCompatibilityReport {
  const { usages, fromManifest, toManifest } = params;
  const breakingReasons: string[] = [];
  const informationalNotes: string[] = [];

  const toInputs = toManifest.inputs ?? {};
  const toOutputs = toManifest.outputs ?? {};

  for (const usage of usages) {
    for (const usedInputKey of usage.withKeys) {
      if (toInputs[usedInputKey] === undefined) {
        breakingReasons.push(
          `${usage.filePath} (${usage.scopeId}): removed input "${usedInputKey}" in target version`,
        );
      }
    }

    for (const [inputName, inputDef] of Object.entries(toInputs)) {
      if (
        isInputRequired(inputDef) &&
        inputDef.default === undefined &&
        !usage.withKeys.includes(inputName)
      ) {
        breakingReasons.push(
          `${usage.filePath} (${usage.scopeId}): required input "${inputName}" has no default and is not provided`,
        );
      }
    }

    for (const outputKey of usage.referencedOutputs) {
      if (toOutputs[outputKey] === undefined) {
        breakingReasons.push(
          `${usage.filePath} (${usage.scopeId}): removed output "${outputKey}" referenced by steps.${usage.stepId ?? "<unknown>"}.outputs`,
        );
      }
    }
  }

  if (
    fromManifest?.runs?.using !== undefined &&
    toManifest.runs?.using !== undefined &&
    fromManifest.runs.using !== toManifest.runs.using
  ) {
    informationalNotes.push(
      `Runtime changed: ${fromManifest.runs.using} -> ${toManifest.runs.using} (non-breaking)`,
    );
  }

  const fromInputs = fromManifest?.inputs ?? {};
  for (const inputName of Object.keys(toInputs)) {
    if (fromInputs[inputName] === undefined) {
      informationalNotes.push(`Added optional input "${inputName}"`);
    }
  }

  return {
    compatible: breakingReasons.length === 0,
    breakingReasons,
    informationalNotes,
  };
}

const WorkflowCallInputSchema = z.object({
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

/**
 * Extracts the public interface contract exposed by `vp-actions` to downstream consumers.
 */
export function extractPublicContract(files: Record<string, string>): PublicContractSnapshot {
  const setupVpEnvContent = files["actions/setup-vp-env/action.yml"];
  const setupPlaywrightContent = files["actions/setup-playwright/action.yml"];

  const setupVpEnvInputs: PublicContractSnapshot["setupVpEnvInputs"] = {};
  if (setupVpEnvContent !== undefined) {
    const parsed = RawCompositeActionSchema.safeParse(parseYaml(setupVpEnvContent));
    if (parsed.success && parsed.data.inputs !== undefined) {
      for (const [key, def] of Object.entries(parsed.data.inputs).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        setupVpEnvInputs[key] = {
          required: isInputRequired(def),
          defaultValue: def.default ?? null,
        };
      }
    }
  }

  let setupPlaywrightHasInputs = false;
  if (setupPlaywrightContent !== undefined) {
    const parsed = RawCompositeActionSchema.safeParse(parseYaml(setupPlaywrightContent));
    if (parsed.success && parsed.data.inputs !== undefined) {
      setupPlaywrightHasInputs = Object.keys(parsed.data.inputs).length > 0;
    }
  }

  const workflows: Record<string, PublicWorkflowContract> = {};
  for (const workflowPath of [
    ".github/workflows/vp-web-ci.yml",
    ".github/workflows/vp-electron-ci.yml",
  ]) {
    const content = files[workflowPath];
    if (content === undefined) {
      continue;
    }
    const parsed = RawWorkflowSchema.safeParse(parseYaml(content));
    if (!parsed.success) {
      continue;
    }

    const workflowCallInputs: PublicWorkflowContract["workflowCallInputs"] = {};
    const workflowCall = z
      .object({
        inputs: z.record(z.string(), WorkflowCallInputSchema).optional(),
      })
      .safeParse(parsed.data.on?.["workflow_call"]);

    if (workflowCall.success && workflowCall.data.inputs !== undefined) {
      for (const [key, def] of Object.entries(workflowCall.data.inputs).toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        workflowCallInputs[key] = {
          type: def.type,
          required: def.required ?? false,
          defaultValue: def.default ?? null,
        };
      }
    }

    const jobIds = Object.keys(parsed.data.jobs ?? {}).toSorted();
    const matrixOsByJob: Record<string, string[]> = {};
    for (const jobId of jobIds) {
      const osValues = parsed.data.jobs?.[jobId]?.strategy?.matrix?.["os"];
      if (osValues !== undefined) {
        matrixOsByJob[jobId] = osValues.map((entry) => String(entry));
      }
    }

    workflows[workflowPath] = {
      workflowCallInputs,
      jobIds,
      matrixOsByJob,
    };
  }

  return {
    setupVpEnvInputs,
    setupPlaywrightHasInputs,
    workflows,
  };
}

/**
 * Compares two `PublicContractSnapshot` objects and returns human-readable differences.
 */
export function diffPublicContracts(
  before: PublicContractSnapshot,
  after: PublicContractSnapshot,
): string[] {
  const diffs: string[] = [];

  if (JSON.stringify(before.setupVpEnvInputs) !== JSON.stringify(after.setupVpEnvInputs)) {
    diffs.push("Public inputs in actions/setup-vp-env/action.yml changed");
  }

  if (before.setupPlaywrightHasInputs !== after.setupPlaywrightHasInputs) {
    diffs.push("Zero-input contract in actions/setup-playwright/action.yml changed");
  }

  const workflowKeys = new Set([...Object.keys(before.workflows), ...Object.keys(after.workflows)]);
  for (const workflowPath of [...workflowKeys].toSorted()) {
    const beforeContract = before.workflows[workflowPath];
    const afterContract = after.workflows[workflowPath];
    if (JSON.stringify(beforeContract) !== JSON.stringify(afterContract)) {
      diffs.push(`Public workflow contract in ${workflowPath} changed`);
    }
  }

  return diffs;
}

/**
 * Rewrites `uses:` references in a YAML file while preserving comments and surrounding layout.
 * `replacements` maps old `rawUses` (e.g. `actions/checkout@v7.0.1`) to new `rawUses`.
 */
export function rewriteUsesRefsInContent(
  content: string,
  replacements: ReadonlyMap<string, string>,
): { updatedContent: string; changedCount: number } {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  let changedCount = 0;

  const updatedLines = lines.map((line) => {
    const match = /^(\s*(?:-\s*)?uses:\s*["']?)([^"'\s#]+)(["']?(?:\s*#.*)?)$/.exec(line);
    if (match === null) {
      return line;
    }

    const prefix = match[1];
    const currentUses = match[2];
    const suffix = match[3];
    if (prefix === undefined || currentUses === undefined || suffix === undefined) {
      return line;
    }

    const nextUses = replacements.get(currentUses);
    if (nextUses === undefined || nextUses === currentUses) {
      return line;
    }

    changedCount += 1;
    return `${prefix}${nextUses}${suffix}`;
  });

  return {
    updatedContent: updatedLines.join(lineEnding),
    changedCount,
  };
}

/**
 * Finds internal `Florencea/vp-actions/actions/*` references in workflow files whose pinned tag
 * is in the same major track and older than `targetTag`, returning updated file contents.
 */
export function planInternalActionRefSync(
  workflowFiles: Record<string, string>,
  targetTag: string,
): Array<{ filePath: string; updatedContent: string; changes: InternalSyncChange[] }> {
  const parsedTarget = parseReleaseTag(targetTag);
  if (parsedTarget === null) {
    throw new Error(`Invalid target release tag for internal sync: "${targetTag}"`);
  }

  const normalizedTargetTag = `v${parsedTarget.major}.${parsedTarget.minor}.${parsedTarget.patch}`;
  const results: Array<{
    filePath: string;
    updatedContent: string;
    changes: InternalSyncChange[];
  }> = [];

  for (const [filePath, content] of Object.entries(workflowFiles).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const usages = scanYamlActionUsages(filePath, content);
    const replacements = new Map<string, string>();
    const changes: InternalSyncChange[] = [];

    for (const usage of usages) {
      if (!usage.actionRef.isInternal) {
        continue;
      }

      const currentVer = parseReleaseTag(usage.actionRef.ref);
      const targetVer = tryParse(normalizedTargetTag.slice(1));
      if (currentVer === null || targetVer === null) {
        continue;
      }

      if (currentVer.major !== targetVer.major || compare(currentVer, targetVer) >= 0) {
        continue;
      }

      const nextUses = `${usage.actionRef.target}@${normalizedTargetTag}`;
      replacements.set(usage.actionRef.rawUses, nextUses);
      changes.push({
        filePath,
        target: usage.actionRef.target,
        from: usage.actionRef.ref,
        to: normalizedTargetTag,
      });
    }

    if (replacements.size === 0) {
      continue;
    }

    const { updatedContent, changedCount } = rewriteUsesRefsInContent(content, replacements);
    if (changedCount > 0) {
      results.push({
        filePath,
        updatedContent,
        changes,
      });
    }
  }

  return results;
}

/**
 * Strips shell-hazardous characters (`'`, `$`, backticks) so a commit message can be safely
 * embedded inside single quotes `'...'` across both zsh and PowerShell (pwsh).
 */
export function sanitizeCommitMessageForShell(message: string): string {
  return message
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll(/['$`]/g, "")
    .trim();
}

/**
 * Formats a `git commit -m '...'` command using single quotes so `!`, `(`, `)`, and `$`
 * are never interpreted by zsh history expansion or pwsh subexpressions.
 */
export function formatSafeCommitCommand(message: string): string {
  const sanitized = sanitizeCommitMessageForShell(message);
  return `git commit -m '${sanitized}'`;
}

/**
 * Builds a Conventional Commit `feat(actions): ...` message so `.github/workflows/release.yml`
 * publishes a minor release without introducing a breaking-change marker.
 */
export function buildUpgradeCommitMessage(
  applied: ReadonlyArray<{ target: string; from: string; to: string }>,
): string {
  if (applied.length === 1) {
    const single = applied[0];
    if (single !== undefined) {
      return sanitizeCommitMessageForShell(
        `feat(actions): upgrade ${single.target} ${single.from} to ${single.to}`,
      );
    }
  }

  return sanitizeCommitMessageForShell(
    `feat(actions): upgrade ${applied.length} external GitHub Actions`,
  );
}
