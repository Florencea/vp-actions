---
trigger: glob
globs: "actions/**, .github/workflows/**"
description: Rules for maintaining and verifying GitHub Actions, Composite Actions, and Reusable Workflows.
---

# GitHub Actions & Workflows Maintenance Rules

## 1. Major Floating Tag Invariant

All external GitHub Actions referenced across `actions/**/*.yml` and `.github/workflows/**/*.yml` must reference their authoritative major floating tag:

- `actions/checkout@v7`
- `voidzero-dev/setup-vp@v1`
- `actions/cache@v6`
- `actions/upload-artifact@v7`
- Internal consumer references: `Florencea/vp-actions/actions/setup-vp-env@v1`, `Florencea/vp-actions/actions/setup-playwright@v1`, `Florencea/vp-actions/.github/workflows/vp-web-ci.yml@v1`

---

## 2. Windows Runner Safety (`tr -d '\r'`)

- Commands in composite actions executed across multiple platforms (especially `actions/setup-playwright`) that pipe command outputs into `$GITHUB_OUTPUT` or `$GITHUB_ENV` must strip carriage returns (`tr -d '\r'`) to prevent Windows runner CRLF breakage.

---

## 3. Shift-Left Local Verification (`actionlint`)

- Every change to workflow or action YAML files must be validated locally using `vpr lint:ci` (`actionlint`) achieving **0 errors and 0 warnings** before staging.
- Never embed `actionlint` into remote reusable workflows or production deployment workflows.

---

## 4. Runner Version Pinning Invariant

- All workflows, composite actions, and matrix configurations must strictly use exact pinned runner versions:
  - Linux: `ubuntu-24.04`
  - macOS: `macos-26`
  - Windows: `windows-2025`
- Floating runner aliases (`ubuntu-latest`, `macos-latest`, `windows-latest`) are strictly prohibited across all workflows and reusable actions.
