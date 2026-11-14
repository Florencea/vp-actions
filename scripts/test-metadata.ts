import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

interface ValidationResult {
  file: string;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const rootDir = resolve(import.meta.dirname, "..");
const results: ValidationResult[] = [];

function validateFile(
  relativePath: string,
  validator: (content: string, errors: string[]) => void,
): void {
  const fullPath = resolve(rootDir, relativePath);
  const errors: string[] = [];

  if (!existsSync(fullPath)) {
    errors.push(`File does not exist: ${relativePath}`);
    results.push({ file: relativePath, errors });
    return;
  }

  const content = readFileSync(fullPath, "utf8");
  validator(content, errors);
  results.push({ file: relativePath, errors });
}

// 1. Validate actions/setup-vp-env/action.yml
validateFile("actions/setup-vp-env/action.yml", (content, errors) => {
  if (!content.includes("name: Setup Vite+ Environment")) {
    errors.push('Missing or invalid "name"');
  }
  if (!content.includes("using: composite")) {
    errors.push("Must use composite action run type");
  }
  if (!content.includes("actions/checkout@v7")) {
    errors.push("Must use actions/checkout@v7");
  }
  if (!content.includes("voidzero-dev/setup-vp@v1")) {
    errors.push("Must use voidzero-dev/setup-vp@v1");
  }
  if (!content.includes("actions/cache@v6")) {
    errors.push("Must use actions/cache@v6 for task cache");
  }
});

// 2. Validate actions/setup-playwright/action.yml
validateFile("actions/setup-playwright/action.yml", (content, errors) => {
  if (!content.includes("name: Setup Playwright Browsers")) {
    errors.push('Missing or invalid "name"');
  }
  if (!content.includes("using: composite")) {
    errors.push("Must use composite action run type");
  }
  if (content.includes("inputs:")) {
    errors.push("Must not expose inputs in zero-config setup-playwright v2");
  }
  if (!content.includes("vp exec playwright install --with-deps chromium")) {
    errors.push("Must run vp exec playwright install --with-deps chromium on Linux");
  }
  if (!content.includes("vp exec playwright install chromium")) {
    errors.push("Must run vp exec playwright install chromium on non-Linux platforms");
  }
  if (!content.includes("runner.os == 'Linux'") || !content.includes("runner.os != 'Linux'")) {
    errors.push("Must select platform-specific Playwright install steps via runner.os");
  }
  if (content.includes("actions/cache")) {
    errors.push("Must not cache browser binaries in setup-playwright v2");
  }
});

// 3. Validate .github/workflows/vp-web-ci.yml
validateFile(".github/workflows/vp-web-ci.yml", (content, errors) => {
  if (!content.includes("workflow_call:")) {
    errors.push("Must be a reusable workflow (workflow_call)");
  }
  if (!content.includes("gatekeeper:")) {
    errors.push("Missing gatekeeper job");
  }
  if (content.includes("platform-compat:") || content.includes("enable-platform-compat")) {
    errors.push(
      "vp-web-ci.yml must not define platform-compat job or enable-platform-compat input",
    );
  }
  if (
    /runs-on:\s*.*-latest/i.test(content) ||
    /-\s*(?:ubuntu|windows|macos)-latest/i.test(content)
  ) {
    errors.push(
      "vp-web-ci.yml must use pinned runner versions, prohibited floating *-latest runners",
    );
  }
  if (!content.includes("Florencea/vp-actions/actions/setup-vp-env@v2")) {
    errors.push("vp-web-ci.yml must use Florencea/vp-actions/actions/setup-vp-env@v2");
  }
  if (!content.includes("Florencea/vp-actions/actions/setup-playwright@v2")) {
    errors.push("vp-web-ci.yml must use Florencea/vp-actions/actions/setup-playwright@v2");
  }
  if (/Florencea\/vp-actions\/[^\s]+@v1\b/.test(content)) {
    errors.push("vp-web-ci.yml must not reference stale @v1 actions");
  }
});

// 4. Validate .github/workflows/vp-electron-ci.yml
validateFile(".github/workflows/vp-electron-ci.yml", (content, errors) => {
  if (!content.includes("workflow_call:")) {
    errors.push("Must be a reusable workflow (workflow_call)");
  }
  if (!content.includes("gatekeeper:")) {
    errors.push("Missing gatekeeper job");
  }
  if (!content.includes("platform-package:")) {
    errors.push("Missing platform-package job");
  }
  if (
    /runs-on:\s*.*-latest/i.test(content) ||
    /-\s*(?:ubuntu|windows|macos)-latest/i.test(content)
  ) {
    errors.push(
      "vp-electron-ci.yml must use pinned runner versions, prohibited floating *-latest runners",
    );
  }
  for (const runner of ["ubuntu-24.04", "macos-26", "windows-2025"]) {
    if (!content.includes(runner)) {
      errors.push(`vp-electron-ci.yml must pin runner "${runner}"`);
    }
  }
  if (!content.includes("Florencea/vp-actions/actions/setup-vp-env@v2")) {
    errors.push("vp-electron-ci.yml must use Florencea/vp-actions/actions/setup-vp-env@v2");
  }
  if (!content.includes("Florencea/vp-actions/actions/setup-playwright@v2")) {
    errors.push("vp-electron-ci.yml must use Florencea/vp-actions/actions/setup-playwright@v2");
  }
  if (/Florencea\/vp-actions\/[^\s]+@v1\b/.test(content)) {
    errors.push("vp-electron-ci.yml must not reference stale @v1 actions");
  }
  for (const cmd of [
    "vp run --no-cache app:pack",
    "xvfb-run --auto-servernum vp run agent:test:e2e",
    "vp run --no-cache app:linux",
    "vp run --no-cache app:mac",
    "vp run --no-cache app:win",
  ]) {
    if (!content.includes(cmd)) {
      errors.push(`vp-electron-ci.yml must include "${cmd}"`);
    }
  }
});

// 4. Validate .github/workflows/release.yml
validateFile(".github/workflows/release.yml", (content, errors) => {
  if (!content.includes("contents: write")) {
    errors.push("release.yml must declare 'contents: write' permission");
  }
  if (!content.includes("workflow_dispatch:")) {
    errors.push("release.yml must support workflow_dispatch trigger");
  }
  if (!content.includes("workflow_run:")) {
    errors.push("release.yml must declare workflow_run trigger dependent on CI");
  }
  if (!content.includes('workflows: ["CI"]')) {
    errors.push('release.yml workflow_run must monitor the "CI" workflow');
  }
  if (!content.includes("workflow_run.event == 'push'")) {
    errors.push("release.yml must ensure workflow_run is triggered only by CI push events");
  }
  if (!content.includes("head_repository.full_name == github.repository")) {
    errors.push("release.yml must verify head_repository matches github.repository");
  }
  if (!content.includes("workflow_run.conclusion == 'success'")) {
    errors.push("release.yml must verify workflow_run.conclusion == 'success'");
  }
  if (/^\s*push:\s*$/m.test(content)) {
    errors.push("release.yml must not trigger directly on push; it must follow CI completion");
  }
  if (!content.includes("timeout-minutes: 15")) {
    errors.push("release.yml must declare timeout-minutes: 15");
  }
  if (!content.includes("vpx ./scripts/release.ts")) {
    errors.push("release.yml must execute vpx ./scripts/release.ts");
  }
  if (/runs-on:\s*.*-latest/i.test(content)) {
    errors.push(
      "release.yml must use pinned runner versions, prohibited floating *-latest runners",
    );
  }
});

// 5. Validate .github/workflows/test-actions.yml
validateFile(".github/workflows/test-actions.yml", (content, errors) => {
  if (/runs-on:\s*.*-latest/i.test(content)) {
    errors.push(
      "test-actions.yml must use pinned runner versions, prohibited floating *-latest runners",
    );
  }
});

// 6. Validate package.json
validateFile("package.json", (content, errors) => {
  try {
    const pkg: unknown = JSON.parse(content);
    if (!isRecord(pkg)) {
      errors.push("package.json must be an object");
      return;
    }
    if (pkg["type"] !== "module") {
      errors.push('package.json must declare "type": "module"');
    }
    const engines = pkg["engines"];
    if (!isRecord(engines) || engines["node"] !== "26.13.0") {
      const nodeVersion = isRecord(engines) ? String(engines["node"]) : "undefined";
      errors.push(
        `package.json engines.node must be pinned to exact "26.13.0", found "${nodeVersion}"`,
      );
    }
    const scripts = pkg["scripts"];
    if (!isRecord(scripts)) {
      errors.push('package.json missing "scripts" object');
      return;
    }
    const requiredScripts = [
      "agent:verify:inner",
      "agent:verify:gate",
      "lint",
      "lint:ci",
      "typecheck",
      "format",
      "test",
      "release",
    ];
    for (const script of requiredScripts) {
      if (typeof scripts[script] !== "string") {
        errors.push(`package.json missing required script: "${script}"`);
      }
    }
  } catch (err: unknown) {
    errors.push(`Failed to parse package.json: ${String(err)}`);
  }
});

// Report results
let totalErrors = 0;
for (const res of results) {
  if (res.errors.length > 0) {
    console.error(`FAIL: ${res.file}`);
    for (const err of res.errors) {
      console.error(`  - ${err}`);
      totalErrors++;
    }
  } else {
    console.log(`PASS: ${res.file}`);
  }
}

if (totalErrors > 0) {
  console.error(`\nMetadata validation failed with ${totalErrors} error(s).`);
  process.exitCode = 1;
} else {
  console.log("\nAll metadata and configuration integrity checks passed successfully.");
}
