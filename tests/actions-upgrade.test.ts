import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseLsRemoteTagMap } from "../scripts/lib/actions-registry.js";
import {
  analyzeUpstreamApiCompatibility,
  buildUpgradeCommitMessage,
  classifyUpgradeKind,
  diffPublicContracts,
  extractPublicContract,
  formatSafeCommitCommand,
  parseActionRef,
  planInternalActionRefSync,
  rewriteUsesRefsInContent,
  sanitizeCommitMessageForShell,
  scanYamlActionUsages,
  selectLatestStableSemVerTag,
} from "../scripts/lib/actions-upgrade-core.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");

describe("actions-upgrade-core", () => {
  describe("parseActionRef", () => {
    it("parses external, subpath, and internal action references", () => {
      expect(parseActionRef("actions/checkout@v7.0.1")).toEqual({
        rawUses: "actions/checkout@v7.0.1",
        target: "actions/checkout",
        repoSlug: "actions/checkout",
        subpath: undefined,
        ref: "v7.0.1",
        isInternal: false,
      });

      expect(parseActionRef("Florencea/vp-actions/actions/setup-vp-env@v3.0.0")).toEqual({
        rawUses: "Florencea/vp-actions/actions/setup-vp-env@v3.0.0",
        target: "Florencea/vp-actions/actions/setup-vp-env",
        repoSlug: "Florencea/vp-actions",
        subpath: "actions/setup-vp-env",
        ref: "v3.0.0",
        isInternal: true,
      });
    });

    it("returns null for local relative or docker references", () => {
      expect(parseActionRef("./actions/local")).toBeNull();
      expect(parseActionRef("docker://alpine:3.20")).toBeNull();
      expect(parseActionRef("invalid-ref-without-at")).toBeNull();
    });
  });

  describe("SemVer tag selection and upgrade classification", () => {
    it("selects the highest stable vX.Y.Z tag while ignoring prerelease and floating tags", () => {
      expect(
        selectLatestStableSemVerTag([
          "v1",
          "v1.2",
          "v1.2.0",
          "v1.10.0-beta.1",
          "v1.9.4",
          "v2.0.0-rc.1",
        ]),
      ).toBe("v1.9.4");
    });

    it("classifies patch, minor, major, and non-upgrades accurately", () => {
      expect(classifyUpgradeKind("v7.0.1", "v7.0.1")).toBe("none");
      expect(classifyUpgradeKind("v7.0.2", "v7.0.1")).toBe("none");
      expect(classifyUpgradeKind("v7.0.1", "v7.0.2")).toBe("patch");
      expect(classifyUpgradeKind("v1.22.0", "v1.23.0")).toBe("minor");
      expect(classifyUpgradeKind("v6.1.0", "v7.0.0")).toBe("major");
    });
  });

  describe("scanYamlActionUsages", () => {
    it("extracts with keys and referenced step outputs from composite actions and workflows", () => {
      const yamlContent = `
name: Sample Workflow
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - id: cache_step
        uses: actions/cache@v6.1.0
        with:
          path: node_modules/.vite
          key: cache-key
      - run: echo "\${{ steps.cache_step.outputs.cache-hit }}"
`;
      const usages = scanYamlActionUsages(".github/workflows/sample.yml", yamlContent);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.actionRef.target).toBe("actions/cache");
      expect(usages[0]?.withKeys).toEqual(["path", "key"]);
      expect(usages[0]?.referencedOutputs).toEqual(["cache-hit"]);
    });

    it("scans repository actions and workflows cleanly", () => {
      const setupVpEnv = readFileSync(resolve(ROOT_DIR, "actions/setup-vp-env/action.yml"), "utf8");
      const usages = scanYamlActionUsages("actions/setup-vp-env/action.yml", setupVpEnv);
      expect(usages.map((u) => u.actionRef.target)).toEqual([
        "actions/checkout",
        "voidzero-dev/setup-vp",
        "actions/cache",
      ]);
    });
  });

  describe("analyzeUpstreamApiCompatibility", () => {
    const baseUsages = scanYamlActionUsages(
      "actions/setup-vp-env/action.yml",
      `
name: Test
description: Test
runs:
  using: composite
  steps:
    - id: cache
      uses: actions/cache@v6.1.0
      with:
        path: .cache
        key: k1
    - run: echo "\${{ steps.cache.outputs.cache-hit }}"
`,
    );

    it("allows major upgrade when only runs.using (node20 -> node24) or optional inputs change", () => {
      const report = analyzeUpstreamApiCompatibility({
        usages: baseUsages,
        fromManifest: {
          inputs: {
            path: { required: true },
            key: { required: true },
          },
          outputs: {
            "cache-hit": { description: "hit" },
          },
          runs: { using: "node20" },
        },
        toManifest: {
          inputs: {
            path: { required: true },
            key: { required: true },
            "restore-keys": { required: false },
            "new-opt": { required: true, default: "auto" },
          },
          outputs: {
            "cache-hit": { description: "hit" },
          },
          runs: { using: "node24" },
        },
      });

      expect(report.compatible).toBe(true);
      expect(report.breakingReasons).toEqual([]);
      expect(report.informationalNotes).toContain(
        "Runtime changed: node20 -> node24 (non-breaking)",
      );
    });

    it("blocks upgrade when a used with input is removed", () => {
      const report = analyzeUpstreamApiCompatibility({
        usages: baseUsages,
        fromManifest: {
          inputs: { path: { required: true }, key: { required: true } },
          outputs: { "cache-hit": { description: "hit" } },
        },
        toManifest: {
          inputs: { path: { required: true } },
          outputs: { "cache-hit": { description: "hit" } },
        },
      });

      expect(report.compatible).toBe(false);
      expect(report.breakingReasons[0]).toContain('removed input "key"');
    });

    it("blocks upgrade when a new required input without default is introduced", () => {
      const report = analyzeUpstreamApiCompatibility({
        usages: baseUsages,
        fromManifest: {
          inputs: { path: { required: true }, key: { required: true } },
          outputs: { "cache-hit": { description: "hit" } },
        },
        toManifest: {
          inputs: {
            path: { required: true },
            key: { required: true },
            token: { required: true },
          },
          outputs: { "cache-hit": { description: "hit" } },
        },
      });

      expect(report.compatible).toBe(false);
      expect(report.breakingReasons[0]).toContain('required input "token" has no default');
    });

    it("blocks upgrade when a referenced step output is removed", () => {
      const report = analyzeUpstreamApiCompatibility({
        usages: baseUsages,
        fromManifest: {
          inputs: { path: { required: true }, key: { required: true } },
          outputs: { "cache-hit": { description: "hit" } },
        },
        toManifest: {
          inputs: { path: { required: true }, key: { required: true } },
          outputs: {},
        },
      });

      expect(report.compatible).toBe(false);
      expect(report.breakingReasons[0]).toContain('removed output "cache-hit"');
    });
  });

  describe("downstream public contract snapshot", () => {
    it("confirms identical downstream contracts when only external uses tags change", () => {
      const files: Record<string, string> = {
        "actions/setup-vp-env/action.yml": readFileSync(
          resolve(ROOT_DIR, "actions/setup-vp-env/action.yml"),
          "utf8",
        ),
        "actions/setup-playwright/action.yml": readFileSync(
          resolve(ROOT_DIR, "actions/setup-playwright/action.yml"),
          "utf8",
        ),
        ".github/workflows/vp-web-ci.yml": readFileSync(
          resolve(ROOT_DIR, ".github/workflows/vp-web-ci.yml"),
          "utf8",
        ),
        ".github/workflows/vp-electron-ci.yml": readFileSync(
          resolve(ROOT_DIR, ".github/workflows/vp-electron-ci.yml"),
          "utf8",
        ),
      };

      const before = extractPublicContract(files);
      const { updatedContent } = rewriteUsesRefsInContent(
        files["actions/setup-vp-env/action.yml"] ?? "",
        new Map([["actions/checkout@v7.0.1", "actions/checkout@v8.0.0"]]),
      );
      const after = extractPublicContract({
        ...files,
        "actions/setup-vp-env/action.yml": updatedContent,
      });

      expect(diffPublicContracts(before, after)).toEqual([]);
    });
  });

  describe("YAML rewriting and internal ref sync", () => {
    it("preserves comments and formatting while rewriting targeted uses references", () => {
      const original = [
        "steps:",
        "  - name: Checkout # keep comment",
        "    uses: actions/checkout@v7.0.1 # pinned",
        "  - uses: actions/cache@v6.1.0",
      ].join("\n");

      const { updatedContent, changedCount } = rewriteUsesRefsInContent(
        original,
        new Map([["actions/checkout@v7.0.1", "actions/checkout@v7.1.0"]]),
      );

      expect(changedCount).toBe(1);
      expect(updatedContent).toContain("uses: actions/checkout@v7.1.0 # pinned");
      expect(updatedContent).toContain("uses: actions/cache@v6.1.0");
    });

    it("plans internal Florencea/vp-actions/actions/* sync within the same major track", () => {
      const workflows = {
        ".github/workflows/vp-web-ci.yml": `
name: Web
on:
  workflow_call:
permissions:
  contents: read
jobs:
  gatekeeper:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: Florencea/vp-actions/actions/setup-vp-env@v3.0.0
      - uses: Florencea/vp-actions/actions/setup-playwright@v3.0.0
`,
      };

      const planned = planInternalActionRefSync(workflows, "v3.1.0");
      expect(planned).toHaveLength(1);
      expect(planned[0]?.changes).toHaveLength(2);
      expect(planned[0]?.updatedContent).toContain(
        "uses: Florencea/vp-actions/actions/setup-vp-env@v3.1.0",
      );
      expect(planned[0]?.updatedContent).toContain(
        "uses: Florencea/vp-actions/actions/setup-playwright@v3.1.0",
      );
    });
  });

  describe("shell-safe commit command formatting (zsh & pwsh)", () => {
    it("wraps commit message in single quotes and strips single quotes, $, and backticks", () => {
      expect(sanitizeCommitMessageForShell("feat(ci)!: drop 'legacy' $VAR `cmd` (v2)")).toBe(
        "feat(ci)!: drop legacy VAR cmd (v2)",
      );
      expect(formatSafeCommitCommand("feat(ci)!: drop legacy (v2)")).toBe(
        "git commit -m 'feat(ci)!: drop legacy (v2)'",
      );
    });

    it("builds non-breaking feat(actions) messages for minor releases", () => {
      expect(
        buildUpgradeCommitMessage([{ target: "actions/checkout", from: "v7.0.1", to: "v7.1.0" }]),
      ).toBe("feat(actions): upgrade actions/checkout v7.0.1 to v7.1.0");
      expect(
        buildUpgradeCommitMessage([
          { target: "actions/checkout", from: "v7.0.1", to: "v7.1.0" },
          { target: "actions/cache", from: "v6.1.0", to: "v7.0.0" },
        ]),
      ).toBe("feat(actions): upgrade 2 external GitHub Actions");
    });
  });

  describe("parseLsRemoteTagMap", () => {
    it("prefers peeled ^{} commit SHA for annotated tags", () => {
      const stdout = [
        "1111111111111111111111111111111111111111\trefs/tags/v3.1.0",
        "2222222222222222222222222222222222222222\trefs/tags/v3.1.0^{}",
        "3333333333333333333333333333333333333333\trefs/tags/v3.0.0",
      ].join("\n");

      const map = parseLsRemoteTagMap(stdout);
      expect(map.get("v3.1.0")).toBe("2222222222222222222222222222222222222222");
      expect(map.get("v3.0.0")).toBe("3333333333333333333333333333333333333333");
    });
  });
});
