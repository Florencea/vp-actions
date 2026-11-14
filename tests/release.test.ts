import { describe, expect, it } from "vite-plus/test";
import {
  calculateNextTag,
  determineBumpFromCommitMessages,
  parseReleaseTag,
  sortSemVerTagsDesc,
} from "../scripts/lib/release-core.js";

describe("release-core", () => {
  describe("parseReleaseTag", () => {
    it("parses strict v-prefixed and bare SemVer tags", () => {
      expect(parseReleaseTag("v3.0.0")).toEqual({
        major: 3,
        minor: 0,
        patch: 0,
        prerelease: undefined,
        build: undefined,
      });
      expect(parseReleaseTag("2.1.4")).toEqual({
        major: 2,
        minor: 1,
        patch: 4,
        prerelease: undefined,
        build: undefined,
      });
    });

    it("rejects prerelease, build metadata, floating tags, and malformed strings", () => {
      expect(parseReleaseTag("v3")).toBeNull();
      expect(parseReleaseTag("v3.0")).toBeNull();
      expect(parseReleaseTag("v3.0.0-rc.1")).toBeNull();
      expect(parseReleaseTag("v3.0.0+build.1")).toBeNull();
      expect(parseReleaseTag("not-a-tag")).toBeNull();
    });
  });

  describe("sortSemVerTagsDesc", () => {
    it("orders semantic versions accurately across double-digit segments", () => {
      const sorted = sortSemVerTagsDesc(["v1.2.0", "v1.10.0", "v2.0.0", "v1.9.3", "v3"]);
      expect(sorted).toEqual(["v2.0.0", "v1.10.0", "v1.9.3", "v1.2.0"]);
    });
  });

  describe("determineBumpFromCommitMessages", () => {
    it("returns null for non-releasable commits only", () => {
      expect(
        determineBumpFromCommitMessages([
          "aa6b974 chore(ci): update GitHub Actions (2 actions)",
          "0ff1fe9 chore(node): Update engines.node 26.13.0 -> 26.13.1",
          "23fa2d7 docs: update docs",
          "1234567 ci: tweak workflow timeout",
        ]),
      ).toBeNull();
    });

    it("selects patch for fix and perf commits", () => {
      expect(determineBumpFromCommitMessages(["abc1234 fix(ci): handle empty tag"])).toBe("patch");
      expect(determineBumpFromCommitMessages(["abc1234 perf: cache action inputs"])).toBe("patch");
    });

    it("selects minor over patch when feat is present", () => {
      expect(
        determineBumpFromCommitMessages([
          "abc1234 fix(ci): repair timeout",
          "def5678 feat(electron): add macos-26 packaging",
        ]),
      ).toBe("minor");
    });

    it("selects major when breaking change syntax is present", () => {
      expect(
        determineBumpFromCommitMessages([
          "abc1234 feat: add new input",
          "def5678 feat(ci)!: remove platform-compat job",
        ]),
      ).toBe("major");
      expect(
        determineBumpFromCommitMessages(["abc1234 refactor: BREAKING CHANGE: drop v1 inputs"]),
      ).toBe("major");
    });
  });

  describe("calculateNextTag", () => {
    it("increments from v1.0.0 when no prior release tag exists", () => {
      expect(calculateNextTag(null, "patch")).toEqual({
        version: "1.0.1",
        targetTag: "v1.0.1",
        majorFloatingTag: "v1",
      });
    });

    it("resets lower segments and advances major floating tag", () => {
      expect(calculateNextTag("v2.3.4", "minor")).toEqual({
        version: "2.4.0",
        targetTag: "v2.4.0",
        majorFloatingTag: "v2",
      });
      expect(calculateNextTag("v2.3.4", "major")).toEqual({
        version: "3.0.0",
        targetTag: "v3.0.0",
        majorFloatingTag: "v3",
      });
    });
  });
});
