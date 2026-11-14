import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalize, satisfies, tryParse } from "verkit";
import { describe, expect, it } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ROOT_DIR = resolve(import.meta.dirname, "..");

const ActionStepSchema = z.object({
  name: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  shell: z.string().optional(),
});

const CompositeActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
  runs: z.object({
    using: z.literal("composite"),
    steps: z.array(ActionStepSchema).min(1),
  }),
});

const WorkflowStepSchema = z.object({
  name: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
});

const WorkflowJobSchema = z.object({
  name: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: z.string().optional(),
  "runs-on": z.string(),
  "timeout-minutes": z.number().int().positive(),
  strategy: z
    .object({
      matrix: z.record(z.string(), z.array(z.unknown())).optional(),
    })
    .optional(),
  steps: z.array(WorkflowStepSchema).min(1),
});

const WorkflowSchema = z.object({
  name: z.string().min(1),
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  concurrency: z
    .object({
      group: z.string().min(1),
      "cancel-in-progress": z.union([z.boolean(), z.string()]),
    })
    .optional(),
  jobs: z.record(z.string(), WorkflowJobSchema),
});

type ParsedWorkflow = z.infer<typeof WorkflowSchema>;
type ParsedCompositeAction = z.infer<typeof CompositeActionSchema>;

function loadYaml(relativePath: string): unknown {
  const fullPath = resolve(ROOT_DIR, relativePath);
  return parseYaml(readFileSync(fullPath, "utf8"));
}

function loadWorkflow(relativePath: string): ParsedWorkflow {
  const result = WorkflowSchema.safeParse(loadYaml(relativePath));
  expect(result.success, `Invalid workflow schema in ${relativePath}`).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}

function loadCompositeAction(relativePath: string): ParsedCompositeAction {
  const result = CompositeActionSchema.safeParse(loadYaml(relativePath));
  expect(result.success, `Invalid composite action schema in ${relativePath}`).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.data;
}

function assertExactSemVerActionRef(
  uses: string,
  context: string,
): { target: string; rawVersion: string } {
  const atIndex = uses.lastIndexOf("@");
  expect(atIndex, `${context}: "${uses}" must include @ref`).toBeGreaterThan(0);

  const target = uses.slice(0, atIndex);
  const ref = uses.slice(atIndex + 1);
  expect(ref.startsWith("v"), `${context}: "${uses}" must use a v-prefixed tag`).toBe(true);

  const rawVersion = ref.slice(1);
  const parsed = tryParse(rawVersion);
  expect(parsed, `${context}: "${uses}" must use a valid SemVer tag`).not.toBeNull();
  if (parsed !== null) {
    expect(
      (parsed.prerelease?.length ?? 0) === 0 && (parsed.build?.length ?? 0) === 0,
      `${context}: "${uses}" must pin a stable release without prerelease or build metadata`,
    ).toBe(true);
    expect(
      normalize(parsed),
      `${context}: "${uses}" must pin an exact vX.Y.Z tag instead of a floating tag`,
    ).toBe(rawVersion);
  }

  return { target, rawVersion };
}

function listWorkflowFiles(): string[] {
  const workflowsDir = resolve(ROOT_DIR, ".github/workflows");
  return readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => `.github/workflows/${file}`);
}

describe("Composite Actions", () => {
  it("pins all action references in setup-vp-env to exact SemVer tags", () => {
    const action = loadCompositeAction("actions/setup-vp-env/action.yml");
    const stepUses = action.runs.steps.flatMap((step) =>
      step.uses !== undefined ? [step.uses] : [],
    );

    expect(stepUses.length).toBeGreaterThanOrEqual(3);
    for (const uses of stepUses) {
      assertExactSemVerActionRef(uses, "actions/setup-vp-env/action.yml");
    }
  });

  it("enforces zero-config platform-aware setup in setup-playwright", () => {
    const action = loadCompositeAction("actions/setup-playwright/action.yml");
    expect(action.inputs).toBeUndefined();

    const stepUses = action.runs.steps.flatMap((step) =>
      step.uses !== undefined ? [step.uses] : [],
    );
    expect(stepUses.some((uses) => uses.startsWith("actions/cache"))).toBe(false);

    const linuxStep = action.runs.steps.find((step) => step.if === "runner.os == 'Linux'");
    const nonLinuxStep = action.runs.steps.find((step) => step.if === "runner.os != 'Linux'");
    expect(linuxStep?.run).toContain("vp exec playwright install --with-deps chromium");
    expect(nonLinuxStep?.run).toContain("vp exec playwright install chromium");
  });
});

describe("Workflows Global Invariants", () => {
  const workflowFiles = listWorkflowFiles();

  it("pins all runners (no *-latest), enforces job timeouts, and pins exact action SemVer tags", () => {
    for (const file of workflowFiles) {
      const workflow = loadWorkflow(file);
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        expect(job["timeout-minutes"], `${file}#${jobId} timeout-minutes`).toBeLessThanOrEqual(30);
        expect(
          /-latest$/i.test(job["runs-on"]),
          `${file}#${jobId} runs-on "${job["runs-on"]}" must not use *-latest`,
        ).toBe(false);

        const matrixOs = job.strategy?.matrix?.["os"];
        if (matrixOs !== undefined) {
          for (const entry of matrixOs) {
            expect(
              typeof entry === "string" && /-latest$/i.test(entry),
              `${file}#${jobId} matrix.os "${String(entry)}" must not use *-latest`,
            ).toBe(false);
          }
        }

        for (const step of job.steps) {
          if (step.uses !== undefined) {
            const { target, rawVersion } = assertExactSemVerActionRef(
              step.uses,
              `${file}#${jobId}`,
            );
            if (target.startsWith("Florencea/vp-actions/")) {
              expect(
                satisfies(rawVersion, "^3.0.0"),
                `${file}#${jobId} internal action "${step.uses}" must target v3`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("Reusable Workflows", () => {
  it("vp-web-ci.yml enforces single-job Linux gatekeeper without platform-compat or actionlint", () => {
    const workflow = loadWorkflow(".github/workflows/vp-web-ci.yml");

    expect(workflow.on["workflow_call"]).toBeDefined();
    expect(workflow.permissions["contents"]).toBe("read");
    expect(Object.keys(workflow.jobs)).toEqual(["gatekeeper"]);

    const inputsObj = z
      .object({ inputs: z.record(z.string(), z.unknown()).optional() })
      .safeParse(workflow.on["workflow_call"]);
    expect(inputsObj.success).toBe(true);
    if (inputsObj.success) {
      expect(inputsObj.data.inputs?.["enable-platform-compat"]).toBeUndefined();
    }

    const gatekeeper = workflow.jobs["gatekeeper"];
    expect(gatekeeper?.["runs-on"]).toBe("ubuntu-24.04");

    const allUses = gatekeeper?.steps.flatMap((s) => (s.uses !== undefined ? [s.uses] : [])) ?? [];
    expect(allUses.some((u) => u.includes("actionlint"))).toBe(false);
    expect(allUses.some((u) => u.startsWith("Florencea/vp-actions/actions/setup-vp-env@"))).toBe(
      true,
    );
    expect(
      allUses.some((u) => u.startsWith("Florencea/vp-actions/actions/setup-playwright@")),
    ).toBe(true);
  });

  it("vp-electron-ci.yml enforces Linux gatekeeper and macOS/Windows packaging matrix", () => {
    const workflow = loadWorkflow(".github/workflows/vp-electron-ci.yml");

    expect(workflow.on["workflow_call"]).toBeDefined();
    expect(workflow.permissions["contents"]).toBe("read");

    const gatekeeper = workflow.jobs["gatekeeper"];
    const platformPackage = workflow.jobs["platform-package"];
    expect(gatekeeper?.["runs-on"]).toBe("ubuntu-24.04");
    expect(platformPackage?.needs).toEqual(["gatekeeper"]);
    expect(platformPackage?.strategy?.matrix?.["os"]).toEqual(["macos-26", "windows-2025"]);

    const allSteps = [...(gatekeeper?.steps ?? []), ...(platformPackage?.steps ?? [])];
    const allUses = allSteps.flatMap((s) => (s.uses !== undefined ? [s.uses] : []));
    expect(allUses.some((u) => u.includes("actionlint"))).toBe(false);

    const allRuns = allSteps.flatMap((s) => (s.run !== undefined ? [s.run] : [])).join("\n");
    for (const cmd of [
      "vp run --no-cache app:pack",
      "xvfb-run --auto-servernum vp run agent:test:e2e",
      "vp run --no-cache app:linux",
      "vp run --no-cache app:mac",
      "vp run --no-cache app:win",
    ]) {
      expect(allRuns).toContain(cmd);
    }
  });
});

describe("CI and Release Governance Workflows", () => {
  it("test-actions.yml runs the unit test suite", () => {
    const workflow = loadWorkflow(".github/workflows/test-actions.yml");
    expect(workflow.permissions["contents"]).toBe("read");
    expect(workflow.concurrency).toBeDefined();

    const validateJob = workflow.jobs["validate"];
    expect(validateJob?.["runs-on"]).toBe("ubuntu-24.04");
    const runs = validateJob?.steps.flatMap((s) => (s.run !== undefined ? [s.run] : [])) ?? [];
    expect(runs.some((cmd) => cmd.includes("vpr agent:test:unit"))).toBe(true);
  });

  it("release.yml gates publishing behind successful CI workflow_run with fork protection", () => {
    const workflow = loadWorkflow(".github/workflows/release.yml");
    expect(workflow.permissions["contents"]).toBe("write");
    expect(workflow.on["push"]).toBeUndefined();
    expect(workflow.on["workflow_dispatch"]).toBeDefined();

    const workflowRun = z
      .object({
        workflows: z.array(z.string()),
      })
      .safeParse(workflow.on["workflow_run"]);
    expect(workflowRun.success).toBe(true);
    if (workflowRun.success) {
      expect(workflowRun.data.workflows).toContain("CI");
    }

    const releaseJob = workflow.jobs["release"];
    expect(releaseJob?.["runs-on"]).toBe("ubuntu-24.04");
    expect(releaseJob?.if).toContain("workflow_run.event == 'push'");
    expect(releaseJob?.if).toContain("head_repository.full_name == github.repository");
    expect(releaseJob?.if).toContain("workflow_run.conclusion == 'success'");

    const runs = (
      releaseJob?.steps.flatMap((s) => (s.run !== undefined ? [s.run] : [])) ?? []
    ).join("\n");
    expect(runs).toContain("vpr agent:test:unit");
    expect(runs).toContain("vpx ./scripts/release.ts");
  });
});
