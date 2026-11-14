import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalize, satisfies, tryParse } from "verkit";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

const ROOT_DIR = resolve(import.meta.dirname, "..");

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  type: z.literal("module"),
  engines: z.object({
    node: z.string().min(1),
  }),
  scripts: z.record(z.string(), z.string().min(1)),
});

const REQUIRED_SCRIPTS = [
  "agent:lint:ci",
  "agent:lint:fix",
  "agent:test:unit",
  "agent:verify:gate",
  "agent:verify:inner",
  "agent:verify:unit",
  "check:fast",
  "format",
  "format:check",
  "lint",
  "lint:ci",
  "release",
  "test",
  "test:unit",
  "typecheck",
  "verify",
] as const;

describe("package.json", () => {
  const rawContent = readFileSync(resolve(ROOT_DIR, "package.json"), "utf8");
  const parsedJson: unknown = JSON.parse(rawContent);
  const parsedPackage = PackageJsonSchema.safeParse(parsedJson);

  it("satisfies ESM and manifest schema contract", () => {
    expect(parsedPackage.success).toBe(true);
  });

  it("pins engines.node to an exact SemVer in the >=26.0.0 track", () => {
    expect(parsedPackage.success).toBe(true);
    if (!parsedPackage.success) return;

    const nodeEngine = parsedPackage.data.engines.node;
    const parsedVersion = tryParse(nodeEngine);
    expect(parsedVersion, `Invalid SemVer in engines.node: "${nodeEngine}"`).not.toBeNull();
    if (parsedVersion !== null) {
      expect(
        normalize(parsedVersion),
        `engines.node must be pinned without range operators, found "${nodeEngine}"`,
      ).toBe(nodeEngine);
      expect(satisfies(parsedVersion, ">=26.0.0")).toBe(true);
    }
  });

  it("exposes three-tier agent verification and toolchain scripts", () => {
    expect(parsedPackage.success).toBe(true);
    if (!parsedPackage.success) return;

    for (const scriptName of REQUIRED_SCRIPTS) {
      expect(
        parsedPackage.data.scripts[scriptName],
        `Missing required script "${scriptName}"`,
      ).toBeDefined();
    }
    expect(parsedPackage.data.scripts["test"]).toBe("vp test run");
  });
});
