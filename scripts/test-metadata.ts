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
  if (!content.includes("PLAYWRIGHT_BROWSERS_PATH")) {
    errors.push("Must configure PLAYWRIGHT_BROWSERS_PATH");
  }
  if (!content.includes("actions/cache@v6")) {
    errors.push("Must use actions/cache@v6 for browser cache");
  }
  if (!content.includes("tr -d '\\r'")) {
    errors.push("Must strip carriage returns from version output for Windows safety");
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
  if (!content.includes("platform-compat:")) {
    errors.push("Missing platform-compat job");
  }
  // Ensure platform-compat includes Setup Playwright Browsers
  const platformCompatIndex = content.indexOf("platform-compat:");
  if (platformCompatIndex === -1) {
    errors.push("Missing platform-compat definition");
  } else {
    const hasPlaywrightStep = content.includes("Setup Playwright Browsers", platformCompatIndex);
    if (!hasPlaywrightStep) {
      errors.push('platform-compat must include "Setup Playwright Browsers" step');
    }
    const hasPlaywrightAction = content.includes(
      "actions/setup-playwright@v1",
      platformCompatIndex,
    );
    if (!hasPlaywrightAction) {
      errors.push("platform-compat must use actions/setup-playwright@v1");
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
  if (!content.includes("timeout-minutes: 15")) {
    errors.push("release.yml must declare timeout-minutes: 15");
  }
  if (!content.includes("vpx ./scripts/release.ts")) {
    errors.push("release.yml must execute vpx ./scripts/release.ts");
  }
});

// 5. Validate package.json
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
