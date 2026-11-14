<!--VITE PLUS START-->

## Vite+ Guidelines

This project uses Vite+ to manage development tools. Always use `vp` (or `vpr` shorthand for `vp run`) to run commands:

- `vpr <script>` (or `vp run <script>`): Run scripts from `package.json`
- `vp install`: Install dependencies
- `vp update`: Update dependencies
- `vp check`: Run linter, typecheck, format checks
- `vp fmt`: Run formatter
- `vp lint`: Run linter

<!--VITE PLUS END-->

# Agent Operations & Maintenance Guide

## 1. Architecture Overview

`vp-actions` provides modular GitHub Actions and Reusable Workflows for Vite+ applications.

| Layer                  | Path                                   | Responsibility                                                                        |
| :--------------------- | :------------------------------------- | :------------------------------------------------------------------------------------ |
| **Composite Actions**  | `actions/setup-vp-env/`                | Installs Node.js with Vite+, installs dependencies, and manages the Vite Task Cache   |
| **Composite Actions**  | `actions/setup-playwright/`            | Installs Playwright Chromium binaries and Linux OS dependencies                       |
| **Reusable Workflows** | `.github/workflows/vp-web-ci.yml`      | Standard three-tier verification gate for web apps (`ubuntu-24.04`)                   |
| **Reusable Workflows** | `.github/workflows/vp-electron-ci.yml` | Electron gatekeeper (`ubuntu-24.04`) and OS matrix (`macos-26`, `windows-2025`)       |
| **Automation Scripts** | `scripts/`                             | Release CLI (`release.ts`) and pure SemVer calculation module (`lib/release-core.ts`) |
| **Test Suite**         | `tests/`                               | Vitest invariant tests (`workflows.test.ts`, `package.test.ts`, `release.test.ts`)    |
| **Modular Rules**      | `.agents/rules/`                       | Domain rules for Git delivery (`git-delivery.md`) and Actions (`actions.md`)          |

---

## 2. Three-Tier Verification Gate

```bash
# Tier 1: Inner loop (vp check + typecheck + actionlint)
vpr agent:verify:inner

# Tier 2: Unit verification (inner loop + Vitest unit suite)
vpr agent:verify:unit

# Tier 3: Full gatekeeper (unit verification + release dry-run)
vpr agent:verify:gate
```

---

## 3. Repository SSOT Invariants

- **Git Delivery**: AI agents must never run `git commit` or `git push`. Verify via `vpr agent:verify:gate`, format via `vp fmt`, stage explicitly with `git add <files>`, and output a Conventional Commit command for manual signing.
- **Release Pipeline**: Automated version tagging and GitHub Releases run exclusively in `.github/workflows/release.yml` via `workflow_run` after `CI` succeeds on `main`. Never create or push tags locally; sync with `git fetch origin --tags --force`.
- **Node.js Engine Pinning**: `package.json` pins `engines.node` to an exact `major.minor.patch` SemVer (without range prefixes), validated via `verkit`.
- **Action & Runner Pinning**: All `actions/*.yml` and `.github/workflows/*.yml` pin exact `vX.Y.Z` Action tags and pinned runners (`ubuntu-24.04`, `macos-26`, `windows-2025`); `*-latest` runners are prohibited.
